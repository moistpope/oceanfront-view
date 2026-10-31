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
 * Road Link is premium data: every page of up to 100 links is one transaction against the account's free monthly
 * allowance, so the requests are counted per calendar month (`usage.json`) and none are made past the cap the page
 * sends (header X-OS-Cap). GET /map/os/status says how many were made this month.
 */
class OsRoads(private val root: File) {
    private val lock = Any()
    private val failedAt = ConcurrentHashMap<String, Long>()
    @Volatile var lastError: String? = null
        private set

    /** The cell's file, fetching it first when needed; null when it can't be had (outside GB, no key, over the cap). */
    fun cell(klat: Int, klon: Int, key: String?, cap: Int): File? {
        if (!inGb(klat, klon)) return null
        val file = File(root, "${klat}_$klon.json")
        if (file.isFile) return file
        if (key.isNullOrBlank()) return null
        val k = "$klat/$klon"
        synchronized(lock) {
            if (file.isFile) return file
            val failed = failedAt[k]
            if (failed != null && System.currentTimeMillis() - failed < RETRY_MS) return null
            try {
                fetch(klat, klon, key.trim(), cap)
                lastError = null
            } catch (e: Exception) {
                Log.w(TAG, "OS roads $k failed: ${e.message}")
                lastError = e.message
                failedAt[k] = System.currentTimeMillis()
                return null
            }
        }
        return file.takeIf { it.isFile }
    }

    /** {month, requests, cells, error}. */
    fun status(): JSONObject {
        val u = usage()
        val cells = root.listFiles { f -> f.name.endsWith(".json") && f.name != USAGE }?.size ?: 0
        return JSONObject().put("month", u.first).put("requests", u.second).put("cells", cells).put("error", lastError ?: JSONObject.NULL)
    }

    private fun fetch(klat: Int, klon: Int, key: String, cap: Int) {
        val s = klat * FEAT_DEG
        val w = klon * FEAT_DEG
        val bbox = "%.4f,%.4f,%.4f,%.4f".format(Locale.ROOT, w, s, w + FEAT_DEG, s + FEAT_DEG)
        Log.i(TAG, "fetching OS roads $klat/$klon ($bbox)")
        val links = JSONArray()
        var offset = 0
        var filtered = true
        while (true) {
            if (usage().second >= cap) throw IOException("monthly request cap ($cap) reached")
            val page = try {
                get(itemsUrl(bbox, offset, filtered, key))
            } catch (e: HttpException) {
                // a filter the server won't take: ask for every link and drop the paths here
                if (e.code == 400 && filtered && offset == 0) { filtered = false; continue } else throw e
            }
            val features = page.optJSONArray("features") ?: JSONArray()
            compact(features, links)
            val returned = page.optInt("numberReturned", features.length())
            if (returned < PAGE || features.length() == 0) break
            offset += PAGE
            if (offset >= MAX_LINKS) { Log.w(TAG, "OS roads $klat/$klon: stopped at $MAX_LINKS links"); break }
        }
        root.mkdirs()
        val out = JSONObject().put("cell", JSONArray().put(klat).put(klon)).put("at", System.currentTimeMillis() / 1000).put("links", links)
        val file = File(root, "${klat}_$klon.json")
        val part = File(root, "${file.name}.part")
        part.writeText(out.toString())
        if (!part.renameTo(file)) throw IOException("could not place ${file.name}")
        Log.i(TAG, "OS roads $klat/$klon: ${links.length()} links with a width")
    }

    /** Coordinates come back as lon, lat (CRS84), the API's default. */
    private fun itemsUrl(bbox: String, offset: Int, filtered: Boolean, key: String): String {
        val q = StringBuilder("$BASE_URL?key=${enc(key)}&bbox=$bbox&limit=$PAGE&offset=$offset")
        if (filtered) q.append("&filter=").append(enc(FILTER)).append("&filter-lang=cql-text")
        return q.toString()
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
        const val BASE_URL = "https://api.os.uk/features/ngd/ofa/v1/collections/trn-ntwk-roadlink-5/items"
        private const val PAGE = 100            // the API's most per request
        private const val MAX_LINKS = 20_000    // a cell's worth in the densest city is well under this
        private const val USAGE = "usage.json"
        private const val RETRY_MS = 60_000L
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 60_000
        private const val USER_AGENT = "oceanscape/1.0 (OS road widths)"
        /** The links cars drive on: no paths, tracks, subways or footbridges. */
        private const val FILTER = "description IN ('Single Carriageway','Dual Carriageway','Collapsed Dual Carriageway','Slip Road'," +
            "'Roundabout','Shared Use Carriageway','Service Road','Layby','Enclosed Traffic Area','Traffic Island Link','Traffic Island Link At Junction')"
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

        private fun round1(v: Double) = Math.round(v * 10) / 10.0
        private fun round6(v: Double) = Math.round(v * 1e6) / 1e6

        /** `/map/os/<klat>/<klon>` -> (klat, klon), or null. */
        fun parsePath(path: String): Pair<Int, Int>? {
            val parts = path.split('/')
            if (parts.size != 5 || parts[1] != "map" || parts[2] != "os") return null
            val klat = parts[3].toIntOrNull() ?: return null
            val klon = parts[4].toIntOrNull() ?: return null
            return Pair(klat, klon)
        }
    }
}
