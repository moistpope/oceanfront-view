package ai.sunnypilot.webhud

import android.content.Context
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import java.io.ByteArrayOutputStream
import java.util.Base64

/**
 * SSH to the comma as `comma`, with the app's own key ([SshKey]). One session is kept open and shared by every
 * command (each runs on its own exec channel), and opened again when the comma moves or the link drops.
 *
 * The comma's host key is pinned on first use: a later connection presenting another key is refused before any
 * command runs ([HostKeyChanged]) until the user trusts the new one (a reflashed comma makes new host keys).
 */
class CommaSsh(context: Context, private val key: SshKey) {
    private val prefs = context.getSharedPreferences("comma", Context.MODE_PRIVATE)
    private var session: Session? = null
    private var sessionHost: String? = null

    class HostKeyChanged(val seen: String, val pinned: String) :
        Exception("the comma's host key changed (now $seen, trusted $pinned): trust it again if the comma was reflashed")

    /** The pinned host key's fingerprint, or null before the first connection. */
    val pinnedFingerprint: String? get() = prefs.getString(PREF_HOST_FP, null)

    fun forgetHostKey() {
        prefs.edit().remove(PREF_HOST_KEY).remove(PREF_HOST_FP).apply()
        close()
    }

    @Synchronized
    fun close() {
        session?.disconnect()
        session = null
        sessionHost = null
    }

    @Synchronized
    private fun session(host: String): Session {
        session?.let { if (it.isConnected && sessionHost == host) return it }
        close()
        val jsch = JSch()
        jsch.addIdentity(key.identity(), null)
        jsch.hostKeyRepository = AcceptAll   // checked against the pin below, once the key is known
        val s = jsch.getSession(USER, host, PORT)
        s.setConfig("StrictHostKeyChecking", "no")
        s.setConfig("PreferredAuthentications", "publickey")
        s.setServerAliveInterval(10_000)
        s.setServerAliveCountMax(3)
        s.connect(CONNECT_MS)
        try {
            checkHostKey(s.hostKey)
        } catch (e: Exception) {
            s.disconnect()
            throw e
        }
        session = s
        sessionHost = host
        return s
    }

    private fun checkHostKey(hk: HostKey) {
        val seen = hk.key   // base64 of the key blob
        val fp = SshWire.fingerprint(Base64.getDecoder().decode(seen))
        val pinned = prefs.getString(PREF_HOST_KEY, null)
        when {
            pinned == null -> prefs.edit().putString(PREF_HOST_KEY, seen).putString(PREF_HOST_FP, fp).apply()
            pinned != seen -> throw HostKeyChanged(fp, pinnedFingerprint ?: "?")
        }
    }

    /** Result of a command: its exit code and output (stdout and stderr together). -1: no exit code, either because
     *  the command ran past its time ([timedOut]) or because the connection closed before the comma sent one (it
     *  rebooted, its network dropped, or the session was closed under it). */
    data class Result(val code: Int, val output: String, val timedOut: Boolean = false)

    /**
     * Runs [script] with bash on the comma, and returns once it ends or [timeoutMs]
     * passes. [onOutput] gets the output as it comes; at most [cap] bytes are kept for the result (the newest).
     */
    fun run(host: String, script: String, timeoutMs: Long, cap: Int = 1 shl 20, onOutput: ((String) -> Unit)? = null): Result {
        val ch = try {
            session(host).openChannel("exec") as ChannelExec
        } catch (e: com.jcraft.jsch.JSchException) {
            // a session that died under us: once more on a fresh one
            if (e.message?.contains("session is down") != true) throw e
            close()
            session(host).openChannel("exec") as ChannelExec
        }
        // as an argument rather than on stdin, where a command in it (git, a user's command) could read the rest
        ch.setCommand("bash -c " + CommaManager.shellQuote(script))
        ch.setErrStream(ByteArrayOutputStream())   // the scripts send stderr to stdout themselves
        val input = ch.inputStream
        val stdin = ch.outputStream
        ch.connect(CONNECT_MS)
        try {
            stdin.close()
            val out = ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (true) {
                var got = false
                while (input.available() > 0) {
                    val n = input.read(buf)
                    if (n < 0) break
                    got = true
                    out.write(buf, 0, n)
                    onOutput?.invoke(String(buf, 0, n, Charsets.UTF_8))
                    if (out.size() > cap * 2) {
                        val keep = out.toByteArray().let { it.copyOfRange(it.size - cap, it.size) }
                        out.reset(); out.write(keep)
                    }
                }
                if (ch.isClosed && input.available() == 0) break
                if (System.currentTimeMillis() > deadline) return Result(-1, out.toString(Charsets.UTF_8.name()) + "\n[timed out]", timedOut = true)
                if (!got) Thread.sleep(25)
            }
            val bytes = out.toByteArray()
            val tail = if (bytes.size > cap) bytes.copyOfRange(bytes.size - cap, bytes.size) else bytes
            return Result(ch.exitStatus, String(tail, Charsets.UTF_8))
        } finally {
            ch.disconnect()
        }
    }

    /** Lets every key through to [checkHostKey], which knows the pin. */
    private object AcceptAll : HostKeyRepository {
        override fun check(host: String?, key: ByteArray?) = HostKeyRepository.OK
        override fun add(hostkey: HostKey?, ui: UserInfo?) {}
        override fun remove(host: String?, type: String?) {}
        override fun remove(host: String?, type: String?, key: ByteArray?) {}
        override fun getKnownHostsRepositoryID() = "oceanfront-view"
        override fun getHostKey(): Array<HostKey> = emptyArray()
        override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
    }

    companion object {
        const val USER = "comma"
        const val PORT = 22
        private const val CONNECT_MS = 6000
        private const val PREF_HOST_KEY = "hostKey"
        private const val PREF_HOST_FP = "hostKeyFingerprint"
    }
}
