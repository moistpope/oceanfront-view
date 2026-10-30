package ai.sunnypilot.webhud

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The page's Comma tab, served under `/app/comma` by the [LocalServer]: the app's SSH key and putting it on the
 * comma, then managing the comma over SSH ([CommaSsh]) -- openpilot's log (its tmux session), its processes and
 * the device's state, the recorded routes, and jobs: start, stop and restart openpilot, reboot, update (openpilot's
 * updater or git), switch branches, install another fork, build and flash the panda, run a command.
 *
 * The scripts are the app's assets (`assets/comma/`): prelude.sh then actions.sh, info.py or routes.py. Every
 * request carries the page's [token] (`X-App-Token`): the server listens on loopback, which other apps on the
 * head unit can reach too. Anything that disturbs openpilot is refused while the car moves, by the bridge's
 * word or the page's (it reads the speed off the car's own bus).
 */
class CommaManager(private val context: Context, private val link: () -> Link) {
    private val key = SshKey(context)
    private val ssh = CommaSsh(context, key)
    private val pool = Executors.newCachedThreadPool { Thread(it, "webhud-comma").apply { isDaemon = true } }
    private val jobs = ConcurrentHashMap<Int, Job>()
    private val jobSeq = AtomicInteger()
    @Volatile private var sshOk: Boolean? = null
    @Volatile private var sshError: String? = null
    @Volatile private var sshCheckedAt = 0L
    @Volatile private var sshHost: String? = null
    private val sshChecking = java.util.concurrent.atomic.AtomicBoolean()

    /** A secret the page sends with each request; it gets it from the app's JavaScript interface. */
    val token: String = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    private fun asset(name: String) = context.assets.open("comma/$name").use { it.readBytes().toString(Charsets.UTF_8) }
    private val prelude by lazy { asset("prelude.sh") }

    private class ApiError(val status: Int, message: String) : Exception(message)

    /** One request: (status, JSON body). */
    fun handle(method: String, path: String, query: Map<String, String>, body: String?, token: String?): Pair<Int, String> {
        if (token != this.token) return 403 to err("not the HUD page")
        return try {
            val sub = path.removePrefix("/app/comma").trimEnd('/')
            val json = when {
                sub == "" && method == "GET" -> status(check = true)
                sub == "/key" && method == "POST" -> { key.create(); status(check = false) }
                sub == "/key" && method == "DELETE" -> deleteKey()
                sub == "/authorize" && method == "POST" -> authorize()
                sub == "/hostkey" && method == "DELETE" -> { ssh.forgetHostKey(); status(check = true) }
                sub == "/search" && method == "POST" -> { link().searchAgain(); JSONObject().put("ok", true) }
                sub == "/info" && method == "GET" -> JSONObject(script("info.py", "python3 - <<'PY'\n${asset("info.py")}\nPY", 25_000))
                sub == "/preview" && method == "GET" -> JSONObject(script("preview.py", "python3 - <<'PY'\n${asset("preview.py")}\nPY", 150_000))
                sub == "/routes" && method == "GET" -> JSONObject(script("routes.py", "python3 - <<'PY'\n${asset("routes.py")}\nPY", 25_000))
                sub == "/log" && method == "GET" -> log(query["lines"]?.toIntOrNull() ?: 400)
                sub == "/branches" && method == "GET" -> branches(query["url"])
                sub == "/jobs" && method == "POST" -> startJob(JSONObject(body ?: "{}"))
                sub == "/jobs" && method == "GET" -> JSONObject().put("jobs", JSONArray(jobs.values.sortedByDescending { it.id }.take(20).map { it.summary() }))
                sub.startsWith("/jobs/") && method == "GET" -> job(sub.removePrefix("/jobs/").toIntOrNull(), query["from"]?.toLongOrNull() ?: 0)
                else -> throw ApiError(404, "no such request")
            }
            200 to json.toString()
        } catch (e: ApiError) {
            e.status to err(e.message)
        } catch (e: CommaSsh.HostKeyChanged) {
            409 to err(e.message)
        } catch (e: Exception) {
            Log.w(TAG, "comma $method $path failed", e)
            502 to err(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun err(message: String?) = JSONObject().put("error", message ?: "failed").toString()

    private fun device(): Device = link().device ?: throw ApiError(503, "the comma isn't connected")

    // ---- the key -----------------------------------------------------------------------------------------

    private fun status(check: Boolean): JSONObject {
        val d = link().device
        val out = JSONObject()
        out.put("device", d?.let { JSONObject().put("host", it.host).put("port", it.port).put("hostname", it.hostname).put("version", it.version) } ?: JSONObject.NULL)
        out.put("key", if (key.exists) JSONObject().put("publicKey", key.openSsh()).put("fingerprint", key.fingerprint()).put("created", key.created) else JSONObject.NULL)
        // the SSH check can take seconds (or hang on a comma that's still starting): it runs on its own, and the page,
        // which asks every few seconds, sees its result next time rather than waiting for it with nothing on screen
        if (check && d != null && key.exists && (System.currentTimeMillis() - sshCheckedAt > SSH_CHECK_MS || sshHost != d.host || sshOk != true) &&
            sshChecking.compareAndSet(false, true)) {
            pool.execute { try { checkSsh(d) } finally { sshChecking.set(false) } }
        }
        out.put("ssh", JSONObject().put("ok", if (d != null && key.exists && sshHost == d.host) sshOk ?: JSONObject.NULL else JSONObject.NULL)
            .put("error", sshError ?: JSONObject.NULL).put("user", CommaSsh.USER).put("hostKey", ssh.pinnedFingerprint ?: JSONObject.NULL))
        return out
    }

    private fun checkSsh(d: Device) {
        sshHost = d.host
        sshCheckedAt = System.currentTimeMillis()
        try {
            val r = ssh.run(d.host, "true", 8000)
            sshOk = r.code == 0
            sshError = if (r.code == 0) null else "exit ${r.code}"
        } catch (e: Exception) {
            sshOk = false
            sshError = when {
                e is CommaSsh.HostKeyChanged -> e.message
                e.message?.contains("Auth fail", true) == true -> "the comma doesn't accept the app's key yet"
                else -> e.message ?: e.javaClass.simpleName
            }
        }
    }

    /** Puts the public key on the comma through its bridge, then checks that SSH lets the app in. */
    private fun authorize(): JSONObject {
        val d = device()
        key.create()
        val line = key.openSsh() ?: throw ApiError(500, "no key")
        val r = Probe.request(d.host, d.port, "POST", "/api/ssh/authorize", JSONObject().put("publicKey", line).toString())
            ?: throw ApiError(502, "the comma's bridge didn't answer")
        if (r.first == 404) throw ApiError(501, "the comma's bridge can't add keys: update sunnypilot's webhud, or add the key by hand")
        if (r.first != 200) throw ApiError(r.first, runCatching { JSONObject(r.second).getString("error") }.getOrDefault("the bridge refused (${r.first})"))
        ssh.close()
        sshCheckedAt = 0
        Thread.sleep(500)   // sshd reads the keys on each login
        checkSsh(d)         // here and now: the page shows whether it worked
        return status(check = false)
    }

    /** Takes the key off the comma (if it is there to ask) and deletes it here. */
    private fun deleteKey(): JSONObject {
        val d = link().device
        val line = key.openSsh()
        if (d != null && line != null) Probe.request(d.host, d.port, "DELETE", "/api/ssh/authorize", JSONObject().put("publicKey", line).toString())
        ssh.close()
        key.delete()
        sshOk = null
        sshError = null
        return status(check = false)
    }

    // ---- reading -----------------------------------------------------------------------------------------

    /** Runs a script after the prelude; its output, or an error with the output's end. */
    private fun script(what: String, body: String, timeoutMs: Long): String {
        val d = device()
        val r = ssh.run(d.host, "$prelude\n$body\n", timeoutMs)
        if (r.code != 0) throw ApiError(502, "$what failed (exit ${r.code}): ${r.output.takeLast(600).trim()}")
        return r.output.trim().lines().last { it.isNotBlank() }   // the JSON is the last line; anything before is noise
    }

    /** The end of openpilot's tmux session (its manager's and processes' output). */
    private fun log(lines: Int): JSONObject {
        val n = lines.coerceIn(50, 5000)
        val d = device()
        val r = ssh.run(d.host, "$prelude\nif op_running; then tmux capture-pane -p -J -t comma -S -$n; else echo '(openpilot is not running: no tmux session \"comma\")'; " +
            "[ -f /tmp/launch_log ] && { echo; echo '--- /tmp/launch_log (the last start) ---'; tail -n 200 /tmp/launch_log; }; fi\n", 15_000)
        return JSONObject().put("text", r.output.trimEnd()).put("running", !r.output.startsWith("(openpilot is not running"))
    }

    /** The branches of the install's repository, or of [url]'s. */
    private fun branches(url: String?): JSONObject {
        val d = device()
        val u = url?.trim().orEmpty()
        if (u.isNotEmpty() && !REPO_URL.matches(u)) throw ApiError(400, "not a git repository URL (https://… or git@…): $u")
        val urlVar = if (u.isEmpty()) "" else "URL=${shellQuote(u)}\n"
        val r = ssh.run(d.host, "$prelude\nACTION=branches\n$urlVar${asset("actions.sh")}\n", 40_000)
        if (r.code != 0) throw ApiError(502, "couldn't list the branches: ${r.output.takeLast(400).trim()}")
        return JSONObject().put("branches", JSONArray(r.output.lines().map { it.trim() }.filter { BRANCH.matches(it) }))
    }

    // ---- jobs --------------------------------------------------------------------------------------------

    private inner class Job(val id: Int, val action: String, val title: String) {
        private val out = StringBuilder()
        @Volatile var base = 0L                 // offset of out[0] in the whole output (the start is dropped past MAX_JOB_OUTPUT)
        @Volatile var done = false
        @Volatile var code: Int? = null
        @Volatile var timedOut = false          // ran past its time: stopped waiting
        @Volatile var lost = false              // the connection closed before the comma said how it ended
        val startedAt = System.currentTimeMillis()

        @Synchronized fun append(s: String) {
            out.append(s)
            if (out.length > MAX_JOB_OUTPUT) {
                val cut = out.length - MAX_JOB_OUTPUT
                out.delete(0, cut)
                base += cut
            }
        }

        @Synchronized fun from(offset: Long): Pair<String, Long> {
            val start = (offset - base).coerceIn(0, out.length.toLong()).toInt()
            return out.substring(start) to base + out.length
        }

        fun summary(): JSONObject = JSONObject().put("id", id).put("action", action).put("title", title).put("done", done)
            .put("code", code ?: JSONObject.NULL).put("startedAt", startedAt).put("timedOut", timedOut).put("lost", lost)
    }

    private fun job(id: Int?, from: Long): JSONObject {
        val j = jobs[id ?: -1] ?: throw ApiError(404, "no such job")
        val (text, next) = j.from(from)
        return j.summary().put("output", text).put("offset", next)
    }

    private fun startJob(req: JSONObject): JSONObject {
        val action = req.optString("action")
        val spec = ACTIONS[action] ?: throw ApiError(400, "unknown action $action")
        val vars = linkedMapOf("ACTION" to action, "RESTART" to if (req.optBoolean("restart", false)) "1" else "0")
        if (spec.needs.contains("branch")) {
            val b = req.optString("branch").trim()
            if (!BRANCH.matches(b)) throw ApiError(400, "not a branch name: $b")
            vars["BRANCH"] = b
        }
        if (spec.needs.contains("url")) {
            val u = req.optString("url").trim()
            if (!REPO_URL.matches(u)) throw ApiError(400, "not a git repository URL (https://… or git@…): $u")
            vars["URL"] = u
        }
        if (spec.needs.contains("cmd")) {
            val c = req.optString("cmd")
            if (c.isBlank() || c.length > 4000) throw ApiError(400, "no command")
            vars["CMD"] = c
        }
        val d = device()
        if (spec.disturbs) refuseIfMoving(d, req.optDouble("speed", 0.0))
        if (spec.disturbs && jobs.values.any { !it.done && ACTIONS[it.action]?.disturbs == true }) throw ApiError(409, "another job is still running")
        val title = spec.title + (vars["BRANCH"]?.let { " $it" } ?: "") + (vars["URL"]?.let { " from $it" } ?: "")
        val j = Job(jobSeq.incrementAndGet(), action, title)
        jobs[j.id] = j
        while (jobs.size > 30) jobs.keys.minOrNull()?.let { jobs.remove(it) }
        val assignments = vars.entries.joinToString("\n") { (k, v) -> "$k=${shellQuote(v)}" }
        Log.i(TAG, "comma job ${j.id}: $title")
        pool.execute {
            try {
                val r = ssh.run(d.host, "$prelude\n$assignments\n${asset("actions.sh")}\n", spec.timeoutMs, onOutput = j::append)
                when {
                    r.timedOut -> {
                        j.timedOut = true
                        j.code = -1
                        j.append("\n[the job took longer than ${spec.timeoutMs / 60_000} min: stopped waiting]\n")
                    }
                    r.code == -1 -> {
                        // the job may well have finished (openpilot restarting can take the connection down): look
                        j.lost = true
                        j.append("\n[the connection closed before the comma said how the job ended: checking]\n")
                        j.code = verify(d, action, assignments, j)
                    }
                    else -> j.code = r.code
                }
            } catch (e: Exception) {
                // a reboot (or a stop that took the link down) ends the session: that's the job done
                j.append("\n[${e.message ?: e.javaClass.simpleName}]\n")
                j.code = if (action == "reboot") 0 else -1
                ssh.close()
            } finally {
                j.done = true
            }
        }
        return j.summary()
    }

    /** After a job whose connection closed: what the checkout is now, on a fresh session, and whether that is what
     *  the job was to do (a branch switch or pull that reached its commit is done: 0, one that didn't: 1); -1 when
     *  the job leaves nothing to check or the comma can't be reached. */
    private fun verify(d: Device, action: String, assignments: String, j: Job): Int {
        ssh.close()
        val check = when (action) {
            "branch" -> "[ \"\$(git rev-parse --abbrev-ref HEAD)\" = \"\$BRANCH\" ] && [ \"\$(git rev-parse HEAD)\" = \"\$(git rev-parse \"origin/\$BRANCH\")\" ] && exit 0; exit 1"
            "pull" -> "[ \"\$(git rev-parse HEAD)\" = \"\$(git rev-parse '@{u}')\" ] && exit 0; exit 1"
            else -> "exit 3"
        }
        val script = "$prelude\n$assignments\n" +
            "git log -1 --format=\"now on \$(git rev-parse --abbrev-ref HEAD) at %h %s (%cr)\"\n" +
            "op_running && echo 'openpilot is running' || echo 'openpilot is not running'\n$check\n"
        val r = try {
            ssh.run(d.host, script, 20_000)
        } catch (e: Exception) {
            j.append("[couldn't reach the comma to check: ${e.message ?: e.javaClass.simpleName}]\n")
            return -1
        }
        j.append(r.output.trimEnd() + "\n")
        return when (r.code) {
            0 -> { j.append("[the change is in place]\n"); 0 }
            1 -> { j.append("[the checkout isn't where the job was taking it]\n"); 1 }
            else -> -1
        }
    }

    /** Disruptive jobs wait for the car to stop: the bridge knows from openpilot, the page from the car's bus. */
    private fun refuseIfMoving(d: Device, pageSpeed: Double) {
        if (pageSpeed > MOVING_MS) throw ApiError(409, "not while the car is moving")
        val st = Probe.request(d.host, d.port, "GET", "/api/status", timeoutMs = 3000)
        val moving = st?.takeIf { it.first == 200 }?.let { runCatching { JSONObject(it.second).optBoolean("moving") }.getOrNull() }
        if (moving == true) throw ApiError(409, "not while the car is moving")
    }

    private data class Action(val title: String, val disturbs: Boolean, val timeoutMs: Long = 120_000, val needs: Set<String> = emptySet())

    companion object {
        private const val TAG = "WebHud"
        private const val SSH_CHECK_MS = 15_000L
        private const val MAX_JOB_OUTPUT = 512 * 1024
        private const val MOVING_MS = 1.0
        private val BRANCH = Regex("^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")
        private val REPO_URL = Regex("^(https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+)$")
        private val ACTIONS = mapOf(
            "start" to Action("Start the driving software", true),
            "stop" to Action("Stop the driving software", true),
            "restart" to Action("Restart the driving software", true),
            "reboot" to Action("Reboot the comma", true, 30_000),
            "update_check" to Action("Check for an update", false, 30_000),
            "update_download" to Action("Download the update", false, 30_000),
            "fetch" to Action("Fetch from origin", false, 180_000),
            "pull" to Action("Pull the branch", true, 600_000),
            "branch" to Action("Switch to", true, 900_000, setOf("branch")),
            "install" to Action("Install", true, 1_800_000, setOf("branch", "url")),
            "restore" to Action("Restore the previous install", true, 120_000),
            "panda_build" to Action("Build the panda firmware", true, 900_000),
            "panda_flash" to Action("Build and flash the panda", true, 900_000),
            "panda_recover" to Action("Recover the panda (DFU)", true, 900_000),
            "exec" to Action("Run", true, 300_000, setOf("cmd")),
        )

        fun shellQuote(s: String) = "'" + s.replace("'", "'\\''") + "'"
    }
}
