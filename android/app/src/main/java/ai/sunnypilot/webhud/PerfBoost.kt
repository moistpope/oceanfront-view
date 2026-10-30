package ai.sunnypilot.webhud

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Full speed while the car is in Ready (the page's *Display → Debug → Full speed in Ready*, on by
 * default). In Ready [fast] is on, and [CanBridge] hands the page its frames every screen frame instead
 * of at 15 Hz. With root it also runs the head unit flat out ([PerfPlan] says how: CPU and GPU held at
 * their top speed, the CAN chips' interrupts moved off CPU 0 and their threads raised to real-time
 * priority), and puts every value back when Ready ends, the bus goes quiet or the switch goes off.
 *
 * Ready is the READY lamp, read straight off IBUS1 ([onReadyFrame]); 0x234 comes every 10 ms with a new
 * alive counter, so a payload that stops changing means the bus is quiet (the helper only repeats it).
 * What a boost changes is saved first ([RESTORE_FILE], a shell script), so a process that dies boosted
 * puts it back when it starts again; a restart of the head unit resets it all anyway, so a script from
 * another boot is dropped.
 */
object PerfBoost {
    private const val TAG = "WebHud"
    private const val PREFS = "perfboost"
    private const val PREF_ON = "on"
    private const val RESTORE_FILE = "perfboost-restore.sh"
    private const val TICK_MS = 1000L
    private const val READY_STALE_MS = 3000L
    private const val ROOT_TIMEOUT_MS = 5000L

    private val thread = HandlerThread("webhud-perf").apply { start() }
    private val handler = Handler(thread.looper)

    @Volatile private var context: Context? = null
    @Volatile private var root: RootShell? = null
    @Volatile private var enabled = true
    @Volatile private var lamp = false
    @Volatile private var lampAt = 0L            // elapsedRealtime of the last 0x234 with a new payload
    private var lastReadyData: String? = null    // CanBridge's reader thread only

    // the perf thread's, read by status()
    @Volatile private var boosted = false        // boosting, or tried to: put back once Ready ends
    @Volatile private var result: PerfPlan.Result? = null
    @Volatile private var error: String? = null

    /** The car is in Ready and the switch is on. */
    val fast: Boolean get() = enabled && ready()

    private fun ready() = lamp && SystemClock.elapsedRealtime() - lampAt < READY_STALE_MS

    /** From [HudService]: watch for Ready, after putting back what a process that died boosted left. */
    @Synchronized
    fun start(context: Context, root: RootShell) {
        if (this.context != null) return
        val app = context.applicationContext
        enabled = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_ON, true)
        this.root = root
        this.context = app
        handler.post {
            runCatching { restoreLeftover(app, root) }
            tick.run()
        }
    }

    /** The page's switch, when it starts and when it changes. */
    fun setEnabled(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_ON, on).apply()
        if (on == enabled) return
        enabled = on
        handler.post { update() }
    }

    /** An IBUS1 0x234 payload (hex), on CanBridge's reader thread. */
    fun onReadyFrame(data: String) {
        if (data == lastReadyData) return   // the helper's once-a-second repeat: no news from the bus
        lastReadyData = data
        lampAt = SystemClock.elapsedRealtime()
        val on = PerfPlan.readyLamp(data) ?: return
        if (on != lamp) {
            lamp = on
            handler.post { update() }
        }
    }

    /**
     * For the page's settings: {on, ready, root (absent until su has answered), boosted, and once a boost
     * has been checked: cpu, gpu, irqs, threads as [done, of], irqCpu; error when it couldn't be}.
     */
    fun status(): String {
        val j = JSONObject().put("on", enabled).put("ready", ready()).put("boosted", boosted)
        root?.available?.let { j.put("root", it) }
        result?.let { r ->
            val count = { c: PerfPlan.Count -> JSONArray().put(c.done).put(c.of) }
            j.put("cpu", count(r.cpu)).put("gpu", count(r.gpu)).put("irqs", count(r.irqs)).put("threads", count(r.threads))
            r.irqCpu?.let { j.put("irqCpu", it) }
        }
        error?.let { j.put("error", it) }
        return j.toString()
    }

    private val tick = object : Runnable {
        override fun run() {
            update()
            handler.postDelayed(this, TICK_MS)
        }
    }

    /** On the perf thread: boost, or put back, to match the switch and Ready. */
    private fun update() {
        val ctx = context ?: return
        val r = root ?: return
        val want = enabled && ready()
        if (want == boosted) return
        try {
            if (want) boost(ctx, r) else restore(ctx, r)
        } catch (e: Exception) {   // a file or the shell: not worth the HUD's process
            error = e.message ?: e.toString()
            Log.w(TAG, "full speed in Ready: ${if (want) "boost" else "putting back"} failed", e)
        }
    }

    private fun boost(ctx: Context, r: RootShell) {
        boosted = true
        result = null
        error = null
        val saved = File(ctx.filesDir, RESTORE_FILE)
        // what's left over from a process that died boosted is the device's real state: put it back
        // first, or this would save the boosted values as the ones to return to
        if (saved.exists() && !restoreLeftover(ctx, r)) {
            error = "couldn't put back what an earlier run changed"
            return
        }
        val script = probeScript(ctx) ?: run { error = "the probe is missing from the app"; return }
        val before = r.run(script, timeoutMs = ROOT_TIMEOUT_MS)
        if (before == null) {
            if (r.available != false) error = "the root shell didn't answer"
            Log.i(TAG, "full speed in Ready: no root, only the CAN hand-off is faster")
            return
        }
        val probe = PerfPlan.parse(before)
        val plan = PerfPlan.plan(probe)
        if (plan.boost.isNotEmpty()) {
            val written = runCatching { saved.writeText(PerfPlan.BOOT_PREFIX + probe.bootId + "\n" + plan.restore.joinToString("\n") + "\n") }.isSuccess
            if (!written) {
                error = "couldn't save the values to put back"
                return
            }
            r.run(plan.boost.joinToString("\n"), timeoutMs = ROOT_TIMEOUT_MS)
        }
        val after = r.run(script, timeoutMs = ROOT_TIMEOUT_MS)?.let { PerfPlan.parse(it) }
        result = after?.let { PerfPlan.result(it) }
        if (after == null) error = "the root shell didn't answer"
        Log.i(TAG, "in Ready, full speed: ${result ?: "couldn't check"} (${plan.boost.size} changes)")
    }

    /** Puts back what [boost] changed. If the root shell doesn't answer, it stays boosted and the next tick tries again. */
    private fun restore(ctx: Context, r: RootShell) {
        val saved = File(ctx.filesDir, RESTORE_FILE)
        val text = if (saved.exists()) runCatching { saved.readText() }.getOrNull() else null
        if (text != null && r.run(text, timeoutMs = ROOT_TIMEOUT_MS) == null) {
            error = "couldn't put the clocks and CAN interrupts back"
            Log.w(TAG, "out of Ready, but the root shell didn't answer: trying again")
            return
        }
        if (text != null) Log.i(TAG, "out of Ready: clocks and CAN interrupts put back")
        saved.delete()
        boosted = false
        result = null
        error = null
    }

    /** Runs the saved restore script if it's from this boot, and drops it. False if root didn't answer (it's kept). */
    private fun restoreLeftover(ctx: Context, r: RootShell): Boolean {
        val saved = File(ctx.filesDir, RESTORE_FILE)
        val text = runCatching { saved.readText() }.getOrNull()
        if (text == null) {
            saved.delete()
            return true
        }
        val boot = r.run("cat /proc/sys/kernel/random/boot_id", timeoutMs = ROOT_TIMEOUT_MS)?.trim() ?: return false
        if (text.lineSequence().first() == PerfPlan.BOOT_PREFIX + boot) {
            r.run(text, timeoutMs = ROOT_TIMEOUT_MS) ?: return false
            Log.i(TAG, "put back the clocks and CAN interrupts an earlier run left boosted")
        }
        saved.delete()
        return true
    }

    private fun probeScript(ctx: Context): String? =
        runCatching { ctx.assets.open("perf/probe.sh").use { it.readBytes().toString(Charsets.UTF_8) } }.getOrNull()
}
