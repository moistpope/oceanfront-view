package ai.sunnypilot.webhud

import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The next turn of the head unit's nav app, sent to the comma for sunnypilot's route turns. sunnypilot uses it only
 * when the car's own navigation has no route turn (sunnypilot/selfdrive/car/nav_route_turn.py), and takes a turn only
 * once the driver signals it.
 *
 * This runs in the notification listener ([HudListener]), so turns go to the comma whether the HUD is on screen or
 * not. It reads the notification the way the page does (infotainment.js parseNav/maneuverOf, navicon.js
 * iconManeuver): keep the two in step. Only left and right turns count; bends, forks, ramps, roundabouts and U-turns
 * don't. Sent to the comma's `POST /api/route_turn` each time the notification changes and once a second besides,
 * with how long ago the app wrote the distance so the comma can carry it on with the car.
 */
object NavTurn {
    private const val TAG = "WebHud"

    data class Turn(val direction: String, val distance: Double, val tolerance: Double, val step: String = "")  // step: what to do there, without the distance

    private val UNIT_M = mapOf("mi" to 1609.344, "mile" to 1609.344, "miles" to 1609.344, "ft" to 0.3048, "feet" to 0.3048,
        "foot" to 0.3048, "yd" to 0.9144, "yds" to 0.9144, "yard" to 0.9144, "yards" to 0.9144, "km" to 1000.0, "m" to 1.0,
        "meter" to 1.0, "meters" to 1.0)
    private val DIST_RE = Regex("""(\d+(?:[.,]\d+)?)\s*(miles?|mi|feet|foot|ft|yards?|yds?|km|met(?:er|re)s?|m)(?![a-z])""", RegexOption.IGNORE_CASE)
    private val TRIP_RE = Regex("""\b\d+\s*(?:min|hr|h)\b|\bETA\b|arriv""", RegexOption.IGNORE_CASE)
    private val SPACES = Regex("""\s+""")

    /** The distance a text gives, in m, with what it was rounded to (m either side), else null. */
    fun distanceOf(f: String): Pair<Double, Double>? {
        val m = DIST_RE.find(f) ?: return null
        val raw = m.groupValues[1]
        val value = raw.replace(',', '.').toDouble()
        val unit = m.groupValues[2].lowercase().replace(Regex("re(s?)$"), "er$1")
        val k = UNIT_M[unit] ?: 1.0
        val decimals = raw.split('.', ',').getOrNull(1)?.length ?: 0
        val half = if (decimals > 0) 0.5 * Math.pow(10.0, -decimals.toDouble())
            else if (value % 100 == 0.0) 50.0 else if (value % 50 == 0.0) 25.0 else if (value % 10 == 0.0) 5.0 else 0.5
        return value * k to half * k
    }

    /** "left" or "right" when an instruction says to turn there (a turn or a sharp turn), "" when it names some other
     *  maneuver, null when it names none (then the app's picture says). As infotainment.js maneuverOf. */
    fun textTurn(text: String): String? {
        val t = text.lowercase()
        if (t.isBlank()) return null
        val side = if (Regex("""\bleft\b""").containsMatchIn(t)) "left" else if (Regex("""\bright\b""").containsMatchIn(t)) "right" else null
        if (Regex("destination|arriv|you have reached").containsMatchIn(t)) return ""
        if (Regex("u-?turn").containsMatchIn(t)) return ""
        if (Regex("roundabout|rotary|traffic circle").containsMatchIn(t)) return ""
        if (Regex("sharp (left|right)").containsMatchIn(t)) return side ?: ""
        if (Regex("(slight|bear) (left|right)").containsMatchIn(t)) return ""
        if (Regex("""\b(keep|stay)\b|\bfork\b""").containsMatchIn(t)) return ""
        if (Regex("""\bexit\b|\bramp\b""").containsMatchIn(t)) return ""
        if (Regex("""\bmerge\b""").containsMatchIn(t)) return ""
        if (Regex("""\bturn\b""").containsMatchIn(t) && side != null) return side
        if (side != null && Regex("""\b(left|right) (onto|on|at|to)\b|^(left|right)\b""").containsMatchIn(t)) return side
        if (Regex("""continue|straight|\bhead\b|\bgo\b|\bstay on\b""").containsMatchIn(t)) return ""
        return null
    }

    /**
     * The turn in a notification: its texts as [HudListener] collects them (title, text, bigText, lines, app) and the
     * picture of the turn as ARGB pixels, or null when there's no left or right turn with a distance.
     */
    fun of(title: String, text: String, bigText: String, lines: String, app: String, icon: IntArray?, w: Int, h: Int): Turn? {
        val clean = { s: String -> s.replace(SPACES, " ").trim() }
        val appName = clean(app).lowercase()
        val fields = (listOf(title, text, bigText) + lines.split('\n')).map(clean).filter { it.isNotEmpty() && it.lowercase() != appName }
        var dist: Pair<Double, Double>? = null
        var instruction = ""
        for (f in fields) {
            val d = if (dist == null && !TRIP_RE.containsMatchIn(f)) distanceOf(f) else null
            if (d != null) {
                dist = d
                val m = DIST_RE.find(f)!!
                val rest = clean(f.replaceRange(m.range, " ").replace(Regex("""^\s*(in|within)\b\s*""", RegexOption.IGNORE_CASE), "")
                    .replace(Regex("""\s+(in|within)\s*(?=[,·•\-–—:]|$)""", RegexOption.IGNORE_CASE), " ")
                    .replace(Regex("""^[,·•\-–—:\s]+|[,·•\-–—:\s]+$"""), ""))
                if (rest.length > 2) instruction = rest
            } else if (instruction.isEmpty() && !TRIP_RE.containsMatchIn(f)) instruction = f
        }
        if (instruction.isEmpty()) instruction = fields.firstOrNull { !TRIP_RE.containsMatchIn(it) && !DIST_RE.containsMatchIn(it) } ?: ""
        val d = dist ?: return null
        val side = textTurn(instruction) ?: icon?.let { iconTurn(it, w, h) } ?: return null
        return if (side.isEmpty()) null else Turn(side, d.first, d.second, instruction)
    }

    // ---- the nav app's picture of the turn (navicon.js iconManeuver) -------------------------------

    private const val BOTTOM = 0.15

    /** "left" or "right" for a turn or sharp turn drawn in the picture (ARGB, w * h), "" for another maneuver, null
     *  when it doesn't look like an arrow. */
    fun iconTurn(argb: IntArray, w: Int, h: Int): String? {
        val n = w * h
        if (argb.size < n || n < 64) return null
        val alpha = { i: Int -> (argb[i] ushr 24) and 0xFF }
        val lum = { i: Int -> 0.299 * ((argb[i] shr 16) and 0xFF) + 0.587 * ((argb[i] shr 8) and 0xFF) + 0.114 * (argb[i] and 0xFF) }
        val mask = BooleanArray(n)
        val clear = (0 until n).count { alpha(it) < 100 }
        if (clear > n * 0.2) {
            for (i in 0 until n) mask[i] = alpha(i) >= 100
        } else {
            val bg = (lum(0) + lum(w - 1) + lum(n - w) + lum(n - 1)) / 4
            for (i in 0 until n) mask[i] = abs(lum(i) - bg) > 60
        }
        var x0 = w; var y0 = h; var x1 = -1; var y1 = -1; var area = 0
        for (y in 0 until h) for (x in 0 until w) if (mask[y * w + x]) {
            area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
        }
        if (area < 20 || x1 - x0 < 3 || y1 - y0 < 3) return null
        val bh = y1 - y0 + 1; val bw = x1 - x0 + 1
        val footTop = y1 - max(1, (bh * BOTTOM).roundToInt())
        val cols = BooleanArray(bw)
        for (y in footTop..y1) for (x in x0..x1) if (mask[y * w + x]) cols[x - x0] = true
        val runs = ArrayList<IntArray>()
        for (i in 0 until bw) if (cols[i]) { if (runs.isNotEmpty() && runs.last()[1] == i - 1) runs.last()[1] = i else runs.add(intArrayOf(i, i)) }
        val big = runs.filter { it[1] - it[0] + 1 >= max(2.0, bw * 0.06) }
        if (big.size >= 2 && big.last()[0] - big.first()[1] > bw * 0.15) return ""   // a U-turn
        var sx = 0.0; var sn = 0
        for (y in footTop..y1) for (x in x0..x1) if (mask[y * w + x]) { sx += x; sn++ }
        sx /= sn
        val sy = y1.toDouble()
        val dist = IntArray(n) { -1 }
        val queue = IntArray(n)
        var qn = 0
        for (x in x0..x1) { val i = y1 * w + x; if (mask[i]) { dist[i] = 0; queue[qn++] = i } }
        var tip = queue[0]
        var q = 0
        while (q < qn) {
            val i = queue[q++]; val x = i % w; val y = i / w
            if (dist[i] > dist[tip]) tip = i
            for (j in intArrayOf(if (x > 0) i - 1 else -1, if (x < w - 1) i + 1 else -1, if (y > 0) i - w else -1, if (y < h - 1) i + w else -1)) {
                if (j >= 0 && mask[j] && dist[j] < 0) { dist[j] = dist[i] + 1; queue[qn++] = j }
            }
        }
        if (hypot(tip % w - sx, tip / w - sy) < max(bw, bh) * 0.3) return null
        if (hasHole(mask, w, h, area)) return ""   // a roundabout
        val dTip = dist[tip]
        var hx = 0.0; var hy = 0.0; var hn = 0; var kx = 0.0; var ky = 0.0; var kn = 0
        for (i in 0 until n) {
            val d = dist[i]
            if (d < 0) continue
            if (d >= 0.85 * dTip) { hx += i % w; hy += i / w; hn++ } else if (d >= 0.55 * dTip) { kx += i % w; ky += i / w; kn++ }
        }
        if (hn == 0 || kn == 0) return null
        hx /= hn; hy /= hn; kx /= kn; ky /= kn
        val angle = Math.toDegrees(atan2(hx - kx, ky - hy))
        val a = abs(angle)
        return if (a in 60.0..165.0) (if (angle > 0) "right" else "left") else ""   // turn or sharp; else straight, slight, U-turn
    }

    private fun hasHole(mask: BooleanArray, w: Int, h: Int, area: Int): Boolean {
        val seen = BooleanArray(w * h)
        val stack = ArrayDeque<Int>()
        fun push(i: Int) { if (!mask[i] && !seen[i]) { seen[i] = true; stack.addLast(i) } }
        for (x in 0 until w) { push(x); push((h - 1) * w + x) }
        for (y in 0 until h) { push(y * w); push(y * w + w - 1) }
        while (stack.isNotEmpty()) {
            val i = stack.removeLast(); val x = i % w; val y = i / w
            if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w)
        }
        val enclosed = (0 until w * h).count { !mask[it] && !seen[it] }
        return enclosed > max(4.0, area * 0.05)
    }

    // ---- to the comma ------------------------------------------------------------------------------

    private val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "webhud-navturn").apply { isDaemon = true } }
    private var link: Link? = null
    private var current: JSONObject? = null   // the turn's message, without its age
    private var writtenAt = 0L                 // wall clock ms the nav app wrote its distance
    private var sentTurn = false
    private var beat: ScheduledFuture<*>? = null

    /** The nav app's latest notification ([turn] null: no turn, or guidance ended), from [HudListener]. Any thread. */
    fun update(link: Link, turn: Turn?, app: String, postedAt: Long) = exec.execute {
        this.link = link
        current = turn?.let {
            JSONObject().put("type", "routeTurn").put("direction", it.direction).put("distance", it.distance)
                .put("tolerance", it.tolerance).put("step", "${it.step}|${it.direction}").put("app", app)
        }
        writtenAt = postedAt
        send()
        if (current != null && beat == null) beat = exec.scheduleWithFixedDelay({ send() }, 1, 1, TimeUnit.SECONDS)
    }

    private fun send() {
        val msg = current
        if (msg == null) {
            beat?.cancel(false)
            beat = null
            if (!sentTurn) return   // nothing said that needs taking back
        }
        // the comma found while the HUD was last on screen (the link only searches then), else where it was last seen
        val l = link ?: return
        val (host, port) = l.device?.let { it.host to it.port }
            ?: l.lastSeen?.split(':')?.takeIf { it.size == 2 }?.let { it[0] to (it[1].toIntOrNull() ?: return) } ?: return
        val body = (msg ?: JSONObject().put("type", "routeTurn").put("direction", JSONObject.NULL))
            .put("age", max(0L, System.currentTimeMillis() - writtenAt) / 1000.0).toString()
        val r = Probe.request(host, port, "POST", "/api/route_turn", body, timeoutMs = 1500)
        if (r == null || r.first != 200) Log.d(TAG, "route turn not taken by the comma: ${r?.first}")
        sentTurn = msg != null
    }
}
