package ai.sunnypilot.webhud

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject

/**
 * The HUD, full screen. The page comes from the app's own [LocalServer] (its files are in the APK) and
 * runs from the car's own buses, with or without the comma: this activity loads it, nudges its WebSocket
 * when the comma is found, reloads it if it failed to load, and replaces the WebView if its renderer dies.
 * Nothing on screen waits for the comma or says it's missing.
 * It also hands the page what the head unit is playing and its next turn ([Infotainment]) and the
 * car's CAN state ([CanBridge]), and, when the page's position source is this screen, its location
 * ([DeviceLocation]). Back opens a small menu. [HudService] keeps the process alive.
 */
class MainActivity : Activity(), Link.Listener, Infotainment.Listener, CanBridge.Listener {

    private enum class Page { NONE, LOADING, LOADED, FAILED }

    private lateinit var link: Link
    private lateinit var holder: FrameLayout
    private lateinit var card: View
    private var web: WebView? = null

    private val ui = Handler(Looper.getMainLooper())
    private var connected: Device? = null
    private var page = Page.NONE
    private var staleAssets = false   // a file of the page failed to load: reload it once connected
    private var loadedAt = 0L         // when the page was last (re)loaded, on the elapsedRealtime clock
    private var reloads = 0           // reloads in a row, for backoff
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var forcedNight: Boolean? = null   // started in the page's own day/night instead of the car's
    private lateinit var location: DeviceLocation
    private var locationWanted = false         // the page's position source is this screen (PageBridge.setLocation)
    private var started = false                // between onStart and onStop: location updates run only then

    private val retryLoad = Runnable { load() }

    /**
     * Start in the page's last theme setting when it's Day or Night rather than Auto, so the window,
     * the WebView behind the page and the starting card don't show the car's day/night colors and
     * then flip once the page has loaded. Auto follows the car (the page reads prefers-color-scheme,
     * which follows this configuration), so it's left alone. The page reports its setting through
     * [PageBridge].
     */
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        val night = when (base.getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_THEME, null)) {
            "dark" -> true
            "light" -> false
            else -> return
        }
        val uiMode = base.resources.configuration.uiMode
        val mode = if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        applyOverrideConfiguration(Configuration().apply { this.uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or mode })
        forcedNight = night
    }

    private fun carIsNight() =
        (applicationContext.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** Called by the page (window.WebHudApp), on its JavaBridge thread. */
    private inner class PageBridge {
        @JavascriptInterface
        fun setTheme(theme: String) {
            if (theme !in THEMES) return
            val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
            if (prefs.getString(PREF_THEME, null) == theme) return
            prefs.edit().putString(PREF_THEME, theme).apply()
            // switched to Auto while started in a fixed day/night the car isn't in: the page's
            // prefers-color-scheme would stay pinned to that until a restart, so restart now
            if (theme == "auto") ui.post { if (forcedNight.let { it != null && it != carIsNight() }) recreate() }
        }

        /** What's playing and the next turn, pictures included, as JSON: the page asks when it starts. */
        @JavascriptInterface
        fun infotainment(): String = Infotainment.snapshot()

        /** A button on the music card: toggle, next or prev. */
        @JavascriptInterface
        fun media(action: String) = Infotainment.command(action)

        /** The car's current state (IBUS frames) the page decodes, as JSON; the page asks on start. */
        @JavascriptInterface
        fun canState(): String = CanBridge.snapshot()

        /** The page's position source is this screen (true) or the car's telematics box: start or stop the location. */
        @JavascriptInterface
        fun setLocation(on: Boolean) {
            ui.post { setLocationWanted(on) }
        }

        /** The page's *Full speed in Ready* switch, when it starts and when it changes ([PerfBoost]). */
        @JavascriptInterface
        fun setPerfBoost(on: Boolean) = PerfBoost.setEnabled(applicationContext, on)

        /** What full speed in Ready is doing, as JSON, for the page's settings. */
        @JavascriptInterface
        fun perfStatus(): String = PerfBoost.status()

        /** The secret the page sends with its requests to the app's own API (/app/comma, CommaManager; /app/update, AppUpdater). */
        @JavascriptInterface
        fun appToken(): String = link.comma.token

        /**
         * Send a frame to the car: {bus, addr, data (hex), repeat?, gapMs?}. Only the head unit's control
         * messages on the allowlist go out (CanIds.TX, checked here and in the helper). Returns null when
         * queued, else why not; the page shows that.
         */
        @JavascriptInterface
        fun canSend(json: String): String? = try {
            val j = JSONObject(json)
            val data = j.getString("data").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            CanBridge.send(j.getString("bus"), j.getInt("addr"), data, j.optInt("repeat", 1), j.optLong("gapMs", 20))
        } catch (e: Exception) {
            "bad request: ${e.message}"
        }

        /**
         * Why a send might not reach the car, for the Signals tab's link check: the helper's answers to what
         * was sent, and the CAN interfaces as the kernel has them (state, listen-only, error counters, frames
         * sent) with the driver's parameters. Blocks on the root shell for a moment.
         */
        @JavascriptInterface
        fun canDiag(): String {
            val links = link.root.run(
                "for i in can1 can2; do ip -details -statistics link show \$i 2>&1; echo; done; " +
                    "for f in /sys/module/mcp251x/parameters/*; do echo \"\$(basename \$f) = \$(cat \$f 2>/dev/null)\"; done; " +
                    "echo; ps -A 2>/dev/null | grep -i -E 'can|pulse' | grep -v grep",
                waitMs = 4000, timeoutMs = 3000) ?: "(no root shell: the interfaces can't be read)"
            return CanBridge.txReport() + "\n\n" + links.trim()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        holder = findViewById(R.id.web_holder)
        card = findViewById(R.id.card)

        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { showMenu() }
        }
        WebView.setWebContentsDebuggingEnabled(true)   // chrome://inspect over adb, for work on the HUD itself

        link = Link.get(this)
        location = DeviceLocation(this) { json -> sendLocation(json) }
        HudListener.grantInBackground(this, link.root)
        HudService.start(this)   // also starts the CAN reader
        createWebView()
        hideSystemBars()
        load()                   // the page is local: up at once, connected or not
    }

    override fun onStart() {
        super.onStart()
        web?.resumeTimers()
        web?.onResume()
        link.resume()
        link.attach(this)
        Infotainment.addListener(this)
        CanBridge.addListener(this)
        if (page == Page.LOADED) reloadInfotainment()   // what changed while the HUD was away
        started = true
        if (locationWanted && location.hasPermission()) startLocation()
    }

    override fun onStop() {
        started = false
        location.stop()
        Infotainment.removeListener(this)
        CanBridge.removeListener(this)
        link.detach(this)
        link.pause()
        web?.onPause()
        web?.pauseTimers()
        super.onStop()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        destroyWebView()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Android 8-12 only: from 13 back goes to the OnBackInvokedCallback registered in onCreate
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Android 13+ uses the OnBackInvokedCallback registered in onCreate")
    override fun onBackPressed() = showMenu()

    // ---- Link.Listener ------------------------------------------------------------------------------

    override fun onConnected(device: Device) {
        connected = device
        if (page == Page.LOADED) reconnectPage()
    }

    // the comma is optional: its absence changes nothing on screen (the page drops its comma chip by itself)
    override fun onSearching(detail: String) {
        connected = null
    }

    // ---- Infotainment.Listener ----------------------------------------------------------------------

    override fun onInfotainment(kind: String, json: String) {
        if (page != Page.LOADED) return   // the page asks for it all when it starts
        web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('webhud:$kind',{detail:$json}))", null)
    }

    private fun reloadInfotainment() {
        web?.evaluateJavascript("window.dispatchEvent(new Event('webhud:infotainment'))", null)
    }

    // CanBridge calls this on its own reader thread; the WebView may only be touched on the main thread
    override fun onCanFrames(json: String) {
        ui.post {
            if (page == Page.LOADED) {   // the page asks for the current state when it starts
                web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('webhud:can',{detail:$json}))", null)
            }
        }
    }

    // ---- the screen's location ----------------------------------------------------------------------

    private fun setLocationWanted(on: Boolean) {
        locationWanted = on
        if (!on) {
            location.stop()
        } else if (!location.hasPermission()) {
            requestPermissions(DeviceLocation.PERMISSIONS, REQUEST_LOCATION)
        } else if (started) {
            startLocation()
        }
    }

    private fun startLocation() {
        location.start()?.let { sendLocation(DeviceLocation.error(it)) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_LOCATION || !locationWanted) return
        if (location.hasPermission()) {
            if (started) startLocation()
        } else {
            sendLocation(DeviceLocation.error("Location permission denied: allow it for the HUD app in the screen's settings."))
        }
    }

    // on the main thread (DeviceLocation's updates come on the main looper)
    private fun sendLocation(json: String) {
        if (page != Page.LOADED) return   // the page asks again (setLocation) when it starts
        web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('webhud:location',{detail:$json}))", null)
    }

    // ---- page ---------------------------------------------------------------------------------------

    private fun load() {
        ui.removeCallbacks(retryLoad)
        Infotainment.pageReset()
        staleAssets = false
        loadedAt = SystemClock.elapsedRealtime()
        page = Page.LOADING
        web?.loadUrl("http://$LOOPBACK:${link.server.port}/")
        updateCard()
    }

    /** Skip the page's retry backoff: the device is back. */
    private fun reconnectPage() {
        web?.evaluateJavascript("window.dispatchEvent(new Event('webhud:reconnect'))", null)
    }

    private fun scheduleReload() {
        ui.removeCallbacks(retryLoad)
        ui.postDelayed(retryLoad, minOf(MAX_RELOAD_DELAY_MS, 1000L shl minOf(reloads++, 5)))
    }

    /** Until the page is up: a spinner. The page is the app's own, so this is a moment at start. */
    private fun updateCard() {
        card.visibility = if (page == Page.LOADED) View.GONE else View.VISIBLE
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val w = WebView(this)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true   // the page keeps its settings in localStorage
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100             // the HUD sizes its own text
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
        }
        w.overScrollMode = View.OVER_SCROLL_NEVER
        w.isVerticalScrollBarEnabled = false
        w.isHorizontalScrollBarEnabled = false
        w.setBackgroundColor(getColor(R.color.background))
        w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        w.webViewClient = Client()
        w.webChromeClient = Chrome()
        w.addJavascriptInterface(PageBridge(), "WebHudApp")
        holder.addView(w, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        web = w
    }

    private fun destroyWebView() {
        web?.let {
            holder.removeView(it)
            it.destroy()
        }
        web = null
    }

    private inner class Client : WebViewClient() {
        // the car's screen has nowhere else to go
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.host != LOOPBACK

        override fun onPageFinished(view: WebView, url: String) {
            if (page != Page.LOADING) return
            page = Page.LOADED
            if (staleAssets) scheduleReload() else reloads = 0
            reloadInfotainment()   // anything that changed since the page first asked
            updateCard()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) {
                Log.w(TAG, "page failed to load: ${error.description}")
                failed()
            } else if (isPageAsset(request)) {
                // a script, style or model is missing: the HUD may be half drawn
                Log.w(TAG, "${request.url.path} failed to load: ${error.description}")
                staleAssets = true
                if (page == Page.LOADED) scheduleReload()
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) failed()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "WebView renderer gone (crashed: ${detail.didCrash()}), starting a new one")
            destroyWebView()
            createWebView()
            page = Page.NONE
            load()
            return true
        }

        /** What the page loads to start up: its scripts, styles and models (the model loads after the
         *  page does). Not API calls, which the page retries, nor anything fetched once it's running. */
        private fun isPageAsset(request: WebResourceRequest): Boolean {
            val path = request.url.path.orEmpty()
            return request.url.host == LOOPBACK && !path.startsWith("/api/") && !path.startsWith("/app/") && path != "/favicon.ico" &&
                SystemClock.elapsedRealtime() - loadedAt < ASSET_LOAD_WINDOW_MS
        }

        private fun failed() {
            page = Page.FAILED
            scheduleReload()
            updateCard()
        }
    }

    private inner class Chrome : WebChromeClient() {
        // Playback → upload a log
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(params.createIntent(), REQUEST_FILE)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }
    }

    @Deprecated("Only used for the WebView's file chooser")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_FILE) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        fileCallback = null
    }

    // ---- menu ---------------------------------------------------------------------------------------

    private fun showMenu() {
        val d = connected
        val title = if (d != null) getString(R.string.menu_connected, d.hostname, d.address) else getString(R.string.menu_no_comma)
        val items = arrayOf(
            getString(R.string.menu_reload),
            getString(R.string.menu_search),
            getString(R.string.menu_address),
            getString(R.string.menu_close),
        )
        AlertDialog.Builder(this).setTitle(title).setItems(items) { _, which ->
            when (which) {
                0 -> {
                    reloads = 0
                    load()
                }
                1 -> link.searchAgain()
                2 -> showAddressDialog()
                3 -> finish()
            }
        }.show()
    }

    private fun showAddressDialog() {
        val input = EditText(this).apply {
            setText(link.manual ?: link.lastSeen.orEmpty())
            hint = getString(R.string.address_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }
        val frame = FrameLayout(this).apply {
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.address_title)
            .setMessage(R.string.address_message)
            .setView(frame)
            .setPositiveButton(R.string.address_use, null)
            .setNeutralButton(R.string.address_automatic) { _, _ -> link.setManual(null) }
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val text = input.text.toString().trim()
                if (Net.parseAddress(text, Probe.PORT) == null) {
                    input.error = getString(R.string.address_invalid)
                } else {
                    link.setManual(text)
                    dialog.dismiss()
                }
            }
        }
        dialog.show()
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            @Suppress("DEPRECATION")   // a no-op from Android 15, where apps are always edge to edge
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        }
    }

    private companion object {
        const val TAG = "WebHud"
        const val LOOPBACK = "127.0.0.1"
        const val MAX_RELOAD_DELAY_MS = 30_000L
        const val ASSET_LOAD_WINDOW_MS = 30_000L
        const val REQUEST_FILE = 1
        const val REQUEST_LOCATION = 2
        const val PREFS = "page"
        const val PREF_THEME = "theme"   // the page's theme setting: auto, light or dark
        val THEMES = setOf("auto", "light", "dark")
    }
}
