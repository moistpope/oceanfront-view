package ai.sunnypilot.webhud

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.floor

/**
 * The map's point features the page draws along the roads (static/js/mapfeatures.js): traffic signals, stop
 * and give-way signs, crossings, level crossings, traffic calming. The road tiles (MapTiles) hold none, so
 * they come from the Overpass API, a road tile's worth ([TILE_DEG] square, one request) at a time, split into
 * the [FEAT_DEG] cells the page asks for (`/map/features/<klat>/<klon>`, the cell's south-west corner in units
 * of FEAT_DEG) and kept under [root] as compact JSON `{cell, bbox, at, nodes: [[id, lat, lon, {tags}], ...]}`
 * for good. One request at a time, politely.
 *
 * The same goes for the roads' full detail the tiles leave out (static/js/world/roaddetail.js): the lanes each way,
 * turn arrows, widths, roundabouts -- the tags of every road way in a road tile that has any of them, one Overpass
 * request per tile, kept as `ways3_<tlat>_<tlon>.json` `{tile, at, ways: {<osm id>: {tag: value}}}` and served whole
 * (`/map/ways/<tlat>/<tlon>`).
 */
class MapFeatures(private val root: File) {
    private val lock = Any()
    private val failedAt = ConcurrentHashMap<String, Long>()

    /** The cell's file, fetching its tile first when needed; null when it can't be had. */
    fun cell(klat: Int, klon: Int): File? {
        if (klat < -1800 || klat >= 1800 || klon < -3600 || klon >= 3600) return null
        val file = File(root, "${klat}_$klon.json")
        if (file.isFile) return file
        if (!ensureTile(Math.floorDiv(klat, CELLS_PER_TILE), Math.floorDiv(klon, CELLS_PER_TILE))) return null
        return if (file.isFile) file else null
    }

    fun haveTile(tlat: Int, tlon: Int): Boolean = marker(tlat, tlon).isFile

    private fun marker(tlat: Int, tlon: Int) = File(root, "tile_${tlat}_$tlon.done")

    /** Fetch the tile's features (all its cells) unless already on disk. True when they are. */
    fun ensureTile(tlat: Int, tlon: Int): Boolean = ensure("$tlat/$tlon", { haveTile(tlat, tlon) }) { fetchTile(tlat, tlon) }

    /** The road tile's way detail file, fetching it first when needed; null when it can't be had. */
    fun ways(tlat: Int, tlon: Int): File? {
        if (tlat < -360 || tlat >= 360 || tlon < -720 || tlon >= 720) return null
        if (!ensureWays(tlat, tlon)) return null
        return waysFile(tlat, tlon).takeIf { it.isFile }
    }

    fun haveWays(tlat: Int, tlon: Int): Boolean = waysFile(tlat, tlon).isFile

    private fun waysFile(tlat: Int, tlon: Int) = File(root, "ways3_${tlat}_$tlon.json")   // 3: with the overtaking and lane_markings tags

    /** Fetch the road tile's way detail unless already on disk. True when it is. */
    fun ensureWays(tlat: Int, tlon: Int): Boolean = ensure("ways $tlat/$tlon", { haveWays(tlat, tlon) }) { fetchWays(tlat, tlon) }

    private fun ensure(key: String, have: () -> Boolean, fetch: () -> Unit): Boolean {
        if (have()) return true
        synchronized(lock) {
            if (have()) return true
            val failed = failedAt[key]
            if (failed != null && System.currentTimeMillis() - failed < RETRY_MS) return false
            try {
                fetch()
            } catch (e: Exception) {
                Log.w(TAG, "map features $key failed: ${e.message}")
                failedAt[key] = System.currentTimeMillis()
                return false
            }
        }
        return true
    }

    private fun bboxOf(tlat: Int, tlon: Int): String {
        val s = tlat * TILE_DEG
        val w = tlon * TILE_DEG
        return "%.4f,%.4f,%.4f,%.4f".format(java.util.Locale.ROOT, s, w, s + TILE_DEG, w + TILE_DEG)
    }

    /** Overpass, with a couple of short retries while it is busy (504 or 429 for a while). */
    private fun overpass(query: String): JSONArray {
        var text: String? = null
        for (attempt in 1..TRIES) {
            try {
                text = post(query)
                break
            } catch (e: BusyException) {
                if (attempt == TRIES) throw e
                Thread.sleep(RETRY_PAUSE_MS)
            }
        }
        return JSONObject(text!!).optJSONArray("elements") ?: JSONArray()
    }

    private fun fetchWays(tlat: Int, tlon: Int) {
        val bbox = bboxOf(tlat, tlon)
        Log.i(TAG, "fetching road detail $tlat/$tlon ($bbox)")
        val elements = overpass(WAYS_QUERY.replace("{bbox}", bbox))
        val ways = JSONObject()
        for (i in 0 until elements.length()) {
            val el = elements.getJSONObject(i)
            if (el.optString("type") != "way") continue
            val all = el.optJSONObject("tags") ?: continue
            val tags = JSONObject()
            for (k in WAY_TAGS) if (all.has(k)) tags.put(k, all.getString(k))
            if (tags.length() > 0) ways.put(el.getLong("id").toString(), tags)
        }
        root.mkdirs()
        val now = System.currentTimeMillis() / 1000
        val out = JSONObject().put("tile", JSONArray().put(tlat).put(tlon)).put("at", now).put("ways", ways)
        val file = waysFile(tlat, tlon)
        val part = File(root, "${file.name}.part")
        part.writeText(out.toString())
        if (!part.renameTo(file)) throw IOException("could not place ${file.name}")
        Log.i(TAG, "road detail $tlat/$tlon: ${ways.length()} ways")
    }

    private fun fetchTile(tlat: Int, tlon: Int) {
        val bbox = bboxOf(tlat, tlon)
        Log.i(TAG, "fetching map features $tlat/$tlon ($bbox)")
        val elements = overpass(QUERY.replace("{bbox}", bbox))
        // split into the page's cells (a node on the tile's far edge stays in this tile)
        val cells = HashMap<Pair<Int, Int>, JSONArray>()
        for (i in 0 until CELLS_PER_TILE) for (j in 0 until CELLS_PER_TILE) cells[Pair(tlat * CELLS_PER_TILE + i, tlon * CELLS_PER_TILE + j)] = JSONArray()
        var total = 0
        for (i in 0 until elements.length()) {
            val el = elements.getJSONObject(i)
            if (el.optString("type") != "node") continue
            val lat = el.getDouble("lat")
            val lon = el.getDouble("lon")
            val klat = floor(lat / FEAT_DEG).toInt().coerceIn(tlat * CELLS_PER_TILE, tlat * CELLS_PER_TILE + CELLS_PER_TILE - 1)
            val klon = floor(lon / FEAT_DEG).toInt().coerceIn(tlon * CELLS_PER_TILE, tlon * CELLS_PER_TILE + CELLS_PER_TILE - 1)
            val tags = JSONObject()
            val all = el.optJSONObject("tags")
            if (all != null) for (k in KEEP_TAGS) if (all.has(k)) tags.put(k, all.getString(k))
            cells[Pair(klat, klon)]!!.put(JSONArray().put(el.getLong("id")).put(lat).put(lon).put(tags))
            total++
        }
        root.mkdirs()
        val now = System.currentTimeMillis() / 1000
        for ((cell, nodes) in cells) {
            val (klat, klon) = cell
            val cs = klat * FEAT_DEG
            val cw = klon * FEAT_DEG
            val out = JSONObject()
                .put("cell", JSONArray().put(klat).put(klon))
                .put("bbox", JSONArray().put(cs).put(cw).put(cs + FEAT_DEG).put(cw + FEAT_DEG))
                .put("at", now)
                .put("nodes", nodes)
            val file = File(root, "${klat}_$klon.json")
            val part = File(root, "${file.name}.part")
            part.writeText(out.toString())
            if (!part.renameTo(file)) throw IOException("could not place ${file.name}")
        }
        marker(tlat, tlon).writeText(now.toString())
        Log.i(TAG, "map features tile $tlat/$tlon: $total nodes in ${cells.size} cells")
    }

    private class BusyException(code: Int) : IOException("HTTP $code")

    private fun post(query: String): String {
        val conn = URL(OVERPASS_URL).openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("User-Agent", USER_AGENT)
        conn.setRequestProperty("Accept", "application/json")
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        try {
            conn.outputStream.use { it.write(("data=" + URLEncoder.encode(query, "UTF-8")).toByteArray()) }
            val code = conn.responseCode
            if (code == 504 || code == 429) throw BusyException(code)
            if (code != 200) throw IOException("HTTP $code")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val TAG = "WebHud"
        const val FEAT_DEG = 0.05
        const val TILE_DEG = 0.25
        const val CELLS_PER_TILE = 5
        const val OVERPASS_URL = "https://overpass-api.de/api/interpreter"
        private const val RETRY_MS = 60_000L
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 150_000
        private const val TRIES = 3
        private const val RETRY_PAUSE_MS = 3_000L
        private const val USER_AGENT = "sunnypilot-webhud/1.0 (map features; github.com/sunnypilot/sunnypilot)"
        private val KEEP_TAGS = listOf("highway", "railway", "direction", "traffic_signals:direction", "traffic_signals", "crossing",
            "crossing:markings", "stop", "traffic_calming")
        private val QUERY = """[out:json][timeout:120];
(
  node["highway"~"^(traffic_signals|stop|give_way|crossing|mini_roundabout)$"]({bbox});
  node["railway"="level_crossing"]({bbox});
  node["traffic_calming"]({bbox});
);
out body;"""
        /** The road ways with any lane, width or junction detail (roaddetail.js WAY_TAGS), tags only. */
        private val WAYS_QUERY = """[out:json][timeout:120];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$"][~"^(lanes|width|est_width|turn:lanes|junction|overtaking|divider|lane_markings)"~"."]({bbox});
out tags;"""
        private val WAY_TAGS = listOf("width", "est_width", "lanes", "lanes:forward", "lanes:backward", "lanes:both_ways", "turn:lanes",
            "turn:lanes:forward", "turn:lanes:backward", "junction",
            "overtaking", "overtaking:forward", "overtaking:backward", "divider", "lane_markings")

        /** `/map/features/<klat>/<klon>` -> (klat, klon), or null. */
        fun parsePath(path: String): Pair<Int, Int>? {
            val parts = path.split('/')
            if (parts.size != 5 || parts[1] != "map" || parts[2] != "features") return null
            val klat = parts[3].toIntOrNull() ?: return null
            val klon = parts[4].toIntOrNull() ?: return null
            return Pair(klat, klon)
        }

        /** `/map/ways/<tlat>/<tlon>` -> (tlat, tlon), or null. */
        fun parseWaysPath(path: String): Pair<Int, Int>? {
            val parts = path.split('/')
            if (parts.size != 5 || parts[1] != "map" || parts[2] != "ways") return null
            val tlat = parts[3].toIntOrNull() ?: return null
            val tlon = parts[4].toIntOrNull() ?: return null
            return Pair(tlat, tlon)
        }
    }
}
