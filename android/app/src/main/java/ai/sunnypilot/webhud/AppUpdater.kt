package ai.sunnypilot.webhud

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * The app updating itself from the repository's GitHub releases, for the Software sheet (static/js/appupdate.js),
 * served under `/app/update` by the [LocalServer]:
 *
 *   GET  /app/update           the installed version, the last check and what an update is doing
 *   POST /app/update/check     asks GitHub for the latest release (drafts and pre-releases aren't offered)
 *   POST /app/update/install   {speed}: downloads the release's APK, checks it, and installs it
 *
 * A release is newer when its tag (`v1.2`) is a higher version than the installed versionName. Its APK is checked
 * against the SHA-256 GitHub keeps for the asset, and must be this app, signed by the same key, and not an older
 * versionCode, before anything is installed. With root (the head unit is rooted) `pm install` replaces the app
 * silently and starts it again; without, Android's own installer asks on screen. Either way the HUD restarts, so
 * installing is refused while the car moves. Every request carries the page's [token], as /app/comma does.
 */
class AppUpdater(private val context: Context, private val root: RootShell, private val appToken: () -> String) {
    private val dir = File(context.cacheDir, "update")
    private val lock = Any()

    @Volatile private var checking = false
    @Volatile private var checkedAt = 0L
    @Volatile private var checkError: String? = null
    @Volatile private var latest: Release? = null

    /** What an install is doing: idle, downloading, verifying, installing, confirm (Android's installer is asking) or failed. */
    @Volatile private var state = "idle"
    @Volatile private var done = 0L
    @Volatile private var total = 0L
    @Volatile private var error: String? = null

    private class ApiError(val status: Int, message: String) : Exception(message)

    data class Release(val tag: String, val version: String, val name: String, val notes: String, val published: String,
                       val page: String, val apkName: String, val apkUrl: String, val apkSize: Long, val sha256: String?)

    fun handle(method: String, path: String, body: String?, token: String?): Pair<Int, String> {
        if (token != appToken()) return 403 to err("not the HUD page")
        return try {
            val json = when (path.removePrefix("/app/update").trimEnd('/') to method) {
                "" to "GET" -> status()
                "/check" to "POST" -> { check(); status() }
                "/install" to "POST" -> { install(JSONObject(body ?: "{}").optDouble("speed", 0.0)); status() }
                else -> throw ApiError(404, "no such request")
            }
            200 to json.toString()
        } catch (e: ApiError) {
            e.status to err(e.message)
        } catch (e: Exception) {
            Log.w(TAG, "update $method $path failed", e)
            502 to err(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun err(message: String?) = JSONObject().put("error", message ?: "failed").toString()

    private fun installed(): PackageInfo = context.packageManager.getPackageInfo(context.packageName, 0)

    @Suppress("DEPRECATION")
    private val PackageInfo.code: Long get() = if (Build.VERSION.SDK_INT >= 28) longVersionCode else versionCode.toLong()

    private fun status(): JSONObject {
        val me = installed()
        val r = latest
        return JSONObject()
            .put("installed", JSONObject().put("version", me.versionName).put("code", me.code).put("updated", me.lastUpdateTime))
            .put("repo", REPO)
            .put("checking", checking)
            .put("checkedAt", if (checkedAt == 0L) JSONObject.NULL else checkedAt)
            .put("checkError", checkError ?: JSONObject.NULL)
            .put("latest", r?.let {
                JSONObject().put("tag", it.tag).put("version", it.version).put("name", it.name).put("notes", it.notes)
                    .put("published", it.published).put("url", it.page).put("apk", it.apkName).put("size", it.apkSize)
            } ?: JSONObject.NULL)
            .put("newer", r != null && compareVersions(r.version, me.versionName.orEmpty()) > 0)
            .put("root", root.available ?: JSONObject.NULL)
            .put("state", state).put("done", done).put("total", total).put("error", error ?: JSONObject.NULL)
    }

    // ---- checking ----------------------------------------------------------------------------------------

    private fun check() {
        synchronized(lock) {
            checking = true
            try {
                latest = parseRelease(JSONObject(get(LATEST_URL)))
                checkError = null
            } catch (e: IOException) {
                checkError = if (e.message?.startsWith("HTTP 404") == true) "GitHub has no releases it will show for $REPO (it's private, or has none yet)" else "couldn't reach GitHub: ${e.message}"
            } catch (e: Exception) {
                checkError = e.message ?: e.javaClass.simpleName
            } finally {
                checkedAt = System.currentTimeMillis()
                checking = false
            }
        }
    }

    private fun open(url: String): HttpURLConnection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 30_000
        instanceFollowRedirects = true   // the asset redirects to GitHub's object storage, https to https
        setRequestProperty("User-Agent", "OceanfrontView/${installed().versionName} (Android)")
    }

    private fun get(url: String): String {
        val conn = open(url)
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode}")
            return conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally {
            conn.disconnect()
        }
    }

    // ---- installing --------------------------------------------------------------------------------------

    private fun install(speed: Double) {
        if (speed > MOVING_MS) throw ApiError(409, "not while the car is moving: the HUD restarts to update")
        if (state in BUSY) throw ApiError(409, "an update is already under way")
        val r = latest ?: throw ApiError(409, "check for an update first")
        if (compareVersions(r.version, installed().versionName.orEmpty()) <= 0) throw ApiError(409, "${r.version} isn't newer than this app")
        state = "downloading"
        done = 0
        total = r.apkSize
        error = null
        thread(name = "webhud-update", isDaemon = true) {
            try {
                val apk = download(r)
                state = "verifying"
                verify(apk, r)
                state = "installing"
                if (!installAsRoot(apk)) installWithAndroid(apk)
            } catch (e: Exception) {
                Log.w(TAG, "update to ${r.tag} failed", e)
                fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private fun fail(why: String) {
        error = why
        state = "failed"
    }

    private fun download(r: Release): File {
        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }   // an earlier download, finished or not
        val part = File(dir, "update.apk.part")
        val conn = open(r.apkUrl)
        try {
            if (conn.responseCode != 200) throw IOException("the download answered HTTP ${conn.responseCode}")
            if (conn.contentLengthLong > 0) total = conn.contentLengthLong
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
        val apk = File(dir, "update.apk")
        if (!part.renameTo(apk)) throw IOException("couldn't keep the download")
        return apk
    }

    /** The download is the release's asset, this app, signed by the same key, and not an older build. */
    @Suppress("DEPRECATION")
    private fun verify(apk: File, r: Release) {
        if (r.apkSize > 0 && apk.length() != r.apkSize) throw IOException("the download is ${apk.length()} bytes, the release says ${r.apkSize}")
        if (r.sha256 != null && sha256(apk) != r.sha256) throw IOException("the download doesn't match the release's SHA-256")
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info = pm.getPackageArchiveInfo(apk.path, flags) ?: throw IOException("the download isn't an APK Android can read")
        if (info.packageName != context.packageName) throw IOException("the release's APK is ${info.packageName}, not this app")
        val me = pm.getPackageInfo(context.packageName, flags)
        if (info.code < me.code) throw IOException("the release's APK is an older build (${info.code} < ${me.code})")
        val theirs = signers(info)
        val mine = signers(me)
        if (theirs.isNotEmpty() && mine.isNotEmpty() && theirs.intersect(mine).isEmpty()) {
            throw IOException("the release is signed with another key than this app, so Android won't install it over this one: " +
                "uninstall the app and install the release's APK by hand once")
        }
    }

    @Suppress("DEPRECATION")
    private fun signers(p: PackageInfo): Set<String> {
        val sigs = if (Build.VERSION.SDK_INT >= 28) p.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
                   else p.signatures
        return sigs.orEmpty().map { sha256(it.toByteArray()) }.toSet()
    }

    /**
     * `pm install` through root: no prompt, and the app is started again afterwards. Installing kills this
     * process, so the install runs detached from the root shell and writes its result to a file this polls while it
     * lives. False when there's no root (Android's installer does it then).
     */
    private fun installAsRoot(apk: File): Boolean {
        val tmp = "/data/local/tmp/oceanfront-update.apk"
        val log = "/data/local/tmp/oceanfront-update.log"
        val staged = root.run("rm -f $log; cp '${apk.path}' $tmp && chmod 644 $tmp && echo staged", timeoutMs = 30_000) ?: return false
        if (!staged.contains("staged")) throw IOException("couldn't stage the APK for pm: ${staged.trim()}")
        // the activity by its class name, not ".MainActivity": that only names it while the package (applicationId)
        // is the code's namespace, and a build under another package would start nothing. setsid takes the shell out
        // of this app's process group, which Android kills when the install replaces it (plain sh where there's no
        // setsid); the pause lets the package settle.
        val main = "${context.packageName}/${MainActivity::class.java.name}"
        val script = "pm install -r $tmp > $log 2>&1; echo \"exit:\$?\" >> $log; rm -f $tmp; sleep 2; am start -n $main"
        root.run("S=\$(command -v setsid); \$S sh -c '$script' </dev/null >/dev/null 2>&1 &", timeoutMs = 5000)
            ?: throw IOException("the root shell went away")
        val deadline = nowMs() + ROOT_INSTALL_MS
        while (nowMs() < deadline) {
            Thread.sleep(1000)
            val out = root.run("cat $log 2>/dev/null", timeoutMs = 5000) ?: continue
            val code = Regex("exit:(\\d+)").find(out)?.groupValues?.get(1) ?: continue
            if (code == "0") return true   // installed (the restart is on its way)
            throw IOException("pm install failed: " + out.lines().firstOrNull { it.contains("Failure") || it.contains("Error") }.orEmpty().ifEmpty { "exit $code" })
        }
        throw IOException("pm install didn't finish")
    }

    /** Android's own installer: it asks on screen (and, the first time, to allow this app to install apps). */
    private fun installWithAndroid(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val action = "${context.packageName}.UPDATE_STATUS"
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    when (val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                        PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                            state = "confirm"
                            @Suppress("DEPRECATION")
                            val ask = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                            ask?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { runCatching { c.startActivity(it) }.onFailure { e -> fail("couldn't ask to install: ${e.message}") } }
                        }
                        PackageInstaller.STATUS_SUCCESS -> { state = "idle"; c.unregisterReceiver(this) }
                        else -> {
                            fail(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "the installer said no ($st)")
                            c.unregisterReceiver(this)
                        }
                    }
                }
            }
            if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
            else context.registerReceiver(receiver, IntentFilter(action))
            val pending = PendingIntent.getBroadcast(context, id, Intent(action).setPackage(context.packageName),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pending.intentSender)
        }
    }

    companion object {
        private const val TAG = "WebHud"
        const val REPO = "moistpope/oceanfront-view"
        private const val LATEST_URL = "https://api.github.com/repos/$REPO/releases/latest"
        private const val MOVING_MS = 1.0
        private const val ROOT_INSTALL_MS = 120_000L
        private val BUSY = setOf("downloading", "verifying", "installing", "confirm")

        /** The release GitHub's API describes, with its first .apk asset; null fields where it has none. */
        fun parseRelease(j: JSONObject): Release {
            val assets = j.optJSONArray("assets")
            val apk = (0 until (assets?.length() ?: 0)).map { assets!!.getJSONObject(it) }.firstOrNull { it.optString("name").endsWith(".apk", true) }
                ?: throw IOException("the latest release (${j.optString("tag_name")}) has no APK attached")
            val tag = j.getString("tag_name")
            return Release(
                tag = tag, version = tag.removePrefix("v").removePrefix("V"), name = j.optString("name").ifEmpty { tag },
                notes = j.optString("body"), published = j.optString("published_at"), page = j.optString("html_url"),
                apkName = apk.getString("name"), apkUrl = apk.getString("browser_download_url"), apkSize = apk.optLong("size"),
                sha256 = apk.optString("digest").takeIf { it.startsWith("sha256:") }?.removePrefix("sha256:")?.lowercase(),
            )
        }

        /** Dotted versions by their numbers ("1.10" > "1.9", "1.0" == "1"); anything after the numbers is ignored. */
        fun compareVersions(a: String, b: String): Int {
            fun parts(s: String) = Regex("^\\d+(\\.\\d+)*").find(s.trim())?.value?.split('.')?.map { it.toLong() }.orEmpty()
            val x = parts(a)
            val y = parts(b)
            for (i in 0 until maxOf(x.size, y.size)) {
                val c = (x.getOrNull(i) ?: 0).compareTo(y.getOrNull(i) ?: 0)
                if (c != 0) return c
            }
            return 0
        }

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
