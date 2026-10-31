package ai.sunnypilot.webhud

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Ordnance Survey's road links for Great Britain (the "Ordnance Survey" map data setting): the carriageway widths
 * OSM rarely has there, from OS NGD API - Features (Road Link, trn-ntwk-roadlink-5), for the page to hang on the
 * OSM ways they lie along (static/js/world/osroads.js). A cell is the page's FEAT_DEG square (`/map/os/<klat>/<klon>`,
 * the same cells as the map features), fetched once with the user's OS Data Hub key (header X-OS-Key) and kept
 * under [root] as `{cell, at, links: [[avgWidth, minWidth, dir, kind, lon0, lat0, lon1, lat1, ...], ...]}` for
 * good: dir 0 both ways, 1 with the points, -1 against; kind DUAL, SINGLE, SLIP, ROUNDABOUT or OTHER.
 *
 * The road surfaces come the same way (`/map/ossurf/<klat>/<klon>`, Road Track Or Path, trn-fts-roadtrackorpath-3): the
 * surveyed outline of every carriageway, pavement and central reservation at ground level, kept as
 * `surf_<klat>_<klon>.json` `{cell, at, polys: [[kind, [lon0, lat0, ...], [hole...], ...], ...]}`, kind R (the
 * carriageway: road, lay-by, shared use, crossing, traffic calming), P (pavement) or C (central reservation), for
 * the page to draw the road as it really is (static/js/world/osroads.js, roadnetgeom.js).
 *
 * Both are premium data: every page of up to 100 links is one transaction against the account's free monthly
 * allowance, so the requests are counted per calendar month (`usage.json`) and none are made past the cap the page
 * sends (header X-OS-Cap). GET /map/os/status says how many were made this month.
 */
class OsRoads(private val root: File) {
    private val lock = Any()
    private val failedAt = ConcurrentHashMap<String, Long>()
    @Volatile var lastError: String? = null
        private set

    /** The cell's road links, fetching them first when needed; null when they can't be had (outside GB, no key, over the cap). */
    fun cell(klat: Int, klon: Int, key: String?, cap: Int): File? =
        ensure(File(root, "${klat}_$klon.json"), "roads $klat/$klon", klat, klon, key) { k -> fetch(klat, klon, k, cap, ROADLINK, "links") { a, b -> compact(a, b) } }

    /** The cell's road surfaces, likewise. */
    fun surface(klat: Int, klon: Int, key: String?, cap: Int): File? =
        ensure(File(root, "surf_${klat}_$klon.json"), "surfaces $klat/$klon", klat, klon, key) { k -> fetch(klat, klon, k, cap, SURFACE, "polys") { a, b -> compactSurface(a, b) } }

    private fun ensure(file: File, what: String, klat: Int, klon: Int, key: String?, fetch: (String) -> Unit): File? {
        if (!inGb(klat, klon)) return null
        if (file.isFile) return file
        if (key.isNullOrBlank()) return null
        synchronized(lock) {
            if (file.isFile) return file
            val failed = failedAt[what]
            if (failed != null && System.currentTimeMillis() - failed < RETRY_MS) return null
            try {
                fetch(key.trim())
                lastError = null
            } catch (e: Exception) {
                Log.w(TAG, "OS $what failed: ${e.message}")
                lastError = e.message
                failedAt[what] = System.currentTimeMillis()
                return null
            }
        }
        return file.takeIf { it.isFile }
    }

    /** {month, requests, cells, error}. */
    fun status(): JSONObject {
        val u = usage()
        val files = root.listFiles { f -> f.name.endsWith(".json") && f.name != USAGE } ?: emptyArray()
        val surfaces = files.count { it.name.startsWith("surf_") }
        return JSONObject().put("month", u.first).put("requests", u.second).put("cells", files.size - surfaces).put("surfaces", surfaces)
            .put("error", lastError ?: JSONObject.NULL)
    }

    /** Every page of a collection's features in the cell, each compacted into one array kept as [field]. */
    private fun fetch(klat: Int, klon: Int, key: String, cap: Int, collection: String, field: String, compact: (JSONArray, JSONArray) -> Unit) {
        val s = klat * FEAT_DEG
        val w = klon * FEAT_DEG
        val bbox = "%.4f,%.4f,%.4f,%.4f".format(Locale.ROOT, w, s, w + FEAT_DEG, s + FEAT_DEG)
        Log.i(TAG, "fetching OS $collection $klat/$klon ($bbox)")
        val items = JSONArray()
        var offset = 0
        while (true) {
            if (usage().second >= cap) throw IOException("monthly request cap ($cap) reached")
            val page = getRetrying(itemsUrl(collection, bbox, offset, key))
            val features = page.optJSONArray("features") ?: JSONArray()
            compact(features, items)
            val returned = page.optInt("numberReturned", features.length())
            if (returned < PAGE || features.length() == 0) break
            offset += PAGE
            if (offset >= MAX_ITEMS) { Log.w(TAG, "OS $collection $klat/$klon: stopped at $MAX_ITEMS"); break }
        }
        root.mkdirs()
        val out = JSONObject().put("cell", JSONArray().put(klat).put(klon)).put("at", System.currentTimeMillis() / 1000).put(field, items)
        val file = File(root, (if (collection == SURFACE) "surf_" else "") + "${klat}_$klon.json")
        val part = File(root, "${file.name}.part")
        part.writeText(out.toString())
        if (!part.renameTo(file)) throw IOException("could not place ${file.name}")
        Log.i(TAG, "OS $collection $klat/$klon: ${items.length()} kept")
    }

    /** Coordinates come back as lon, lat (CRS84), the API's default. Every feature comes, paths too: a CQL filter on the
     *  kinds times out (504) over a city cell, so the compacting drops the ones cars don't drive on. */
    private fun itemsUrl(collection: String, bbox: String, offset: Int, key: String) =
        "$API/$collection/items?key=${enc(key)}&bbox=$bbox&limit=$PAGE&offset=$offset"

    /** A page, asked again a couple of times while the API is busy (429, 5xx). */
    private fun getRetrying(url: String): JSONObject {
        for (attempt in 1..TRIES) {
            try {
                return get(url)
            } catch (e: HttpException) {
                if (attempt == TRIES || (e.code != 429 && e.code < 500)) throw e
                Thread.sleep(RETRY_PAUSE_MS * attempt)
            }
        }
        throw IOException("unreachable")
    }

    private class HttpException(val code: Int) : IOException("HTTP $code")

    private fun get(url: String): JSONObject {
        count()
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.setRequestProperty("Accept", "application/geo+json")
        conn.setRequestProperty("User-Agent", USER_AGENT)
        try {
            val code = conn.responseCode
            if (code == 401 || code == 403) throw IOException("HTTP $code: the OS key was refused (is Road Link in its API project?)")
            if (code != 200) throw HttpException(code)
            return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally {
            conn.disconnect()
        }
    }

    // ---- the month's request count --------------------------------------------------------------------

    private fun month() = SimpleDateFormat("yyyy-MM", Locale.ROOT).format(Date())

    private fun usage(): Pair<String, Int> {
        val m = month()
        return try {
            val o = JSONObject(File(root, USAGE).readText())
            if (o.optString("month") == m) Pair(m, o.optInt("requests")) else Pair(m, 0)
        } catch (e: Exception) {
            Pair(m, 0)
        }
    }

    private fun count() {
        val (m, n) = usage()
        root.mkdirs()
        File(root, USAGE).writeText(JSONObject().put("month", m).put("requests", n + 1).toString())
    }

    companion object {
        private const val TAG = "WebHud"
        const val FEAT_DEG = MapFeatures.FEAT_DEG
        const val API = "https://api.os.uk/features/ngd/ofa/v1/collections"
        const val ROADLINK = "trn-ntwk-roadlink-5"
        const val SURFACE = "trn-fts-roadtrackorpath-3"
        private const val PAGE = 100            // the API's most per request
        private const val MAX_ITEMS = 40_000    // a cell's worth in the densest city is well under this
        private const val USAGE = "usage.json"
        private const val RETRY_MS = 60_000L
        private const val TRIES = 3
        private const val RETRY_PAUSE_MS = 2_000L
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 60_000
        private const val USER_AGENT = "oceanscape/1.0 (OS road widths)"
        /** The links cars drive on: no paths, tracks, subways or footbridges. */
        private val ROADS = setOf("Single Carriageway", "Dual Carriageway", "Collapsed Dual Carriageway", "Slip Road", "Roundabout",
            "Shared Use Carriageway", "Service Road", "Layby", "Enclosed Traffic Area", "Traffic Island Link", "Traffic Island Link At Junction")

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        /** Great Britain, roughly (the API covers nothing else). */
        fun inGb(klat: Int, klon: Int): Boolean {
            val lat = klat * FEAT_DEG
            val lon = klon * FEAT_DEG
            return lat >= 49.8 && lat < 61.0 && lon >= -8.8 && lon < 2.0
        }

        /** Append the road links of a GeoJSON page that carry a width, compacted, to [out]. */
        fun compact(features: JSONArray, out: JSONArray) {
            for (i in 0 until features.length()) {
                val f = features.optJSONObject(i) ?: continue
                val p = f.optJSONObject("properties") ?: continue
                val desc = p.optString("description")
                if (desc !in ROADS) continue
                val avg = p.optDouble("roadwidth_average", Double.NaN)
                if (avg.isNaN() || avg <= 0) continue
                val min = p.optDouble("roadwidth_minimum", Double.NaN)
                val coords = f.optJSONObject("geometry")?.optJSONArray("coordinates") ?: continue
                if (coords.length() < 2) continue
                val dir = when (p.optString("directionality")) { "In Direction" -> 1; "In Opposite Direction" -> -1; else -> 0 }
                val kind = when (desc) {
                    "Dual Carriageway", "Collapsed Dual Carriageway" -> "DUAL"
                    "Single Carriageway" -> "SINGLE"
                    "Slip Road" -> "SLIP"
                    "Roundabout" -> "ROUNDABOUT"
                    else -> "OTHER"
                }
                val link = JSONArray().put(round1(avg)).put(if (min.isNaN()) JSONObject.NULL else round1(min)).put(dir).put(kind)
                for (j in 0 until coords.length()) {
                    val c = coords.optJSONArray(j) ?: continue
                    link.put(round6(c.getDouble(0))).put(round6(c.getDouble(1)))
                }
                out.put(link)
            }
        }

        /** The surface kinds kept, by OS description: R the carriageway, P pavement, C central reservation. */
        private val SURF_KIND = mapOf("Road" to "R", "Lay-by" to "R", "Shared Use Carriageway" to "R", "Pedestrian Crossing" to "R",
            "Traffic Calming" to "R", "Pavement" to "P", "Pavement And Steps" to "P", "Central Reservation" to "C")

        /** Append the ground-level road surfaces of a GeoJSON page, compacted, to [out]: [kind, ring, hole, ...] each ring
         *  [lon0, lat0, lon1, lat1, ...] without the closing point. A multipolygon becomes one entry per polygon. */
        fun compactSurface(features: JSONArray, out: JSONArray) {
            for (i in 0 until features.length()) {
                val f = features.optJSONObject(i) ?: continue
                val p = f.optJSONObject("properties") ?: continue
                val kind = SURF_KIND[p.optString("description")] ?: continue
                if (p.optBoolean("isobscured", false) || p.optString("physicallevel", "Surface Level") != "Surface Level") continue
                val g = f.optJSONObject("geometry") ?: continue
                val coords = g.optJSONArray("coordinates") ?: continue
                val polys = when (g.optString("type")) {
                    "Polygon" -> listOf(coords)
                    "MultiPolygon" -> (0 until coords.length()).mapNotNull { coords.optJSONArray(it) }
                    else -> emptyList()
                }
                for (poly in polys) {
                    val entry = JSONArray().put(kind)
                    for (r in 0 until poly.length()) {
                        val ring = poly.optJSONArray(r) ?: continue
                        val flat = JSONArray()
                        val n = ring.length() - 1   // GeoJSON repeats the first point last
                        for (j in 0 until n) {
                            val c = ring.optJSONArray(j) ?: continue
                            flat.put(round6(c.getDouble(0))).put(round6(c.getDouble(1)))
                        }
                        if (flat.length() >= 6) entry.put(flat) else if (r == 0) break
                    }
                    if (entry.length() >= 2) out.put(entry)
                }
            }
        }

        private fun round1(v: Double) = Math.round(v * 10) / 10.0
        private fun round6(v: Double) = Math.round(v * 1e6) / 1e6

        /** `/map/os/<klat>/<klon>` (or `/map/ossurf/...`) -> (klat, klon), or null. */
        fun parsePath(path: String, kind: String = "os"): Pair<Int, Int>? {
            val parts = path.split('/')
            if (parts.size != 5 || parts[1] != "map" || parts[2] != kind) return null
            val klat = parts[3].toIntOrNull() ?: return null
            val klon = parts[4].toIntOrNull() ?: return null
            return Pair(klat, klon)
        }
    }
}
