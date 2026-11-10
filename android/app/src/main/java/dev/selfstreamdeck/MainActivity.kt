package dev.selfstreamdeck

import android.Manifest
import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Thin shell around the web UI served by the PC (the Rust agent, agent/). All the deck logic lives on the
 * agent; this app only stores the pairing addresses, keeps the screen on and renders the page.
 *
 * It knows up to two addresses for the same PC: the USB tunnel (http://127.0.0.1:PORT, tried first because it fails at once
 * when no cable is plugged in) and the home network (https://IP:PORT). The home-network server uses a self-signed
 * certificate: the app trusts it only when its SHA-256 fingerprint is the one it was paired with.
 */
class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private var web: WebView? = null
    private var showingSetup = false
    private var pendingCamera: PermissionRequest? = null // a page asked for the camera while the system permission was still unknown

    private var candidates: List<String> = emptyList()
    private var candidateIndex = 0

    // What stands between the person and the page while the PC is being looked for: "Conectando…", or "Sem conexão com o PC". The WebView is
    // only given an address that answered (see Probe), so the browser's own error page never shows.
    private var frame: FrameLayout? = null
    private var overlay: View? = null
    private var connecting = false // an address answered and the page is loading: the overlay goes away when it is done
    private var noConnectionShown = false
    private var round = 0 // which search for the PC is current: an answer of an older one is ignored
    private val handler = Handler(Looper.getMainLooper())
    private val tryAgain = Runnable { if (noConnectionShown && !showingSetup) connect(quiet = true) }

    private var clock: LinearLayout? = null // the little clock over the deck: "14:35" and under it "07/11" (day/month)
    private var clockTime: TextView? = null
    private var clockDate: TextView? = null
    private val clockTick = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = updateClock()
    }

    override fun onStart() {
        super.onStart()
        // the system says when the minute (or the time, or the time zone) changes: no timer of ours to keep running
        registerReceiver(clockTick, IntentFilter().apply {
            addAction(Intent.ACTION_TIME_TICK)
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
        })
        updateClock()
        if (noConnectionShown) scheduleTryAgain()
    }

    override fun onStop() {
        handler.removeCallbacks(tryAgain)
        unregisterReceiver(clockTick)
        super.onStop()
    }

    /** 24-hour time (00:00 to 23:59) and the date as day/month, whatever the phone's language is. */
    private fun updateClock() {
        val now = Date()
        clockTime?.text = SimpleDateFormat("HH:mm", Locale.US).format(now)
        clockDate?.text = SimpleDateFormat("dd/MM", Locale.US).format(now)
    }

    /**
     * Built like one of the left rail's tabs of the page (web/src/styles/style.css, `.tab`): a slot as tall as a tab (48), the same
     * muted color, system font and weight, the big thing (the time, where a tab has its icon) over a small label (the date, 0.6rem).
     * Sizes are in dp, like the CSS pixels of the page.
     */
    private fun makeClock(): LinearLayout {
        val muted = Color.parseColor("#7D8394") // --muted of the deck
        fun label(size: Float, weight: Int) = TextView(this).apply {
            setTextColor(muted)
            setTextSize(TypedValue.COMPLEX_UNIT_DIP, size)
            // font weights as in the page's CSS; older Androids only have regular and bold
            typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, weight, false) else Typeface.DEFAULT_BOLD
            includeFontPadding = false
            gravity = Gravity.CENTER
            maxLines = 1
        }
        val time = label(CLOCK_TIME_DP, 700)
        val date = label(CLOCK_DATE_DP, 600)
        clockTime = time
        clockDate = date
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(time)
            addView(date, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
            // it only shows: touches go through it to the page below
            isClickable = false
            isFocusable = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        savePairingFromIntent(intent)

        if (buildCandidates().isEmpty()) showSetup() else showDeck()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (savePairingFromIntent(intent)) showDeck()
    }

    /**
     * The PC can pair the app over adb:
     * am start -n dev.selfstreamdeck/.MainActivity --es url "http://127.0.0.1:7878/?token=…" --es wifi "https://IP:7879/?token=…&fp=…"
     */
    private fun savePairingFromIntent(intent: Intent?): Boolean {
        if (intent == null) return false
        val url = normalize(intent.getStringExtra(KEY_URL))
        val wifi = normalize(intent.getStringExtra(KEY_WIFI))
        if (url == null && wifi == null) return false
        savePairing(url, wifi)
        return true
    }

    private fun savePairing(url: String?, wifi: String?) {
        val editor = prefs.edit()
        if (url != null) editor.putString(KEY_URL, url)
        if (wifi != null) {
            editor.putString(KEY_WIFI, wifi)
            Uri.parse(wifi).getQueryParameter("fp")?.let { editor.putString(KEY_FP, it.lowercase()) }
        }
        editor.apply()
    }

    /** The addresses to try, in order: this PC / USB first, then the home network. */
    private fun buildCandidates(): List<String> {
        val list = ArrayList<String>()
        val url = prefs.getString(KEY_URL, null)
        val wifi = prefs.getString(KEY_WIFI, null)
        if (url != null) {
            list.add(url)
        } else if (wifi != null) {
            Uri.parse(wifi).getQueryParameter("token")?.let { list.add("http://127.0.0.1:$USB_PORT/?token=$it") }
        }
        if (wifi != null) list.add(wifi)
        return list
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Deprecated("Back is handled by the page")
    override fun onBackPressed() {
        // The app never closes on Back: a stray press must not drop the deck. On the setup screen it returns to the deck
        // (if an address is saved); on the deck it asks the page to step back (close a sheet, the menu, an overlay, or go to
        // Apps). The page answers "true"/"false"; either way there is nothing more to do here, and an old page without
        // Deck.back() just raises an error that evaluateJavascript hands to the callback.
        if (showingSetup) {
            if (buildCandidates().isNotEmpty()) showDeck()
            return
        }
        web?.evaluateJavascript("Deck.back()") { }
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    // --- deck -----------------------------------------------------------------

    private fun showDeck() {
        showingSetup = false
        destroyWebView()
        candidates = buildCandidates()
        candidateIndex = 0

        val view = WebView(this)
        web = view
        view.setBackgroundColor(BACKGROUND)

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }

        view.addJavascriptInterface(Bridge(), "Android")
        view.webViewClient = object : WebViewClient() {
            // An address that answered the probe still failed to load: start over from the screen that says so.
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) runOnUiThread { showNoConnection() }
            }

            // The home-network server's certificate is self-signed: accept it only if it is exactly the one paired with.
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (matchesPinnedCertificate(error.certificate)) {
                    handler.proceed()
                } else {
                    handler.cancel()
                    runOnUiThread { showNoConnection() }
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (connecting) runOnUiThread { hideOverlay() }
            }
        }

        // The page can use the phone camera (the deck turns it into the PC's webcam), but only the paired PC's page.
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { answerCameraRequest(request) }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingCamera === request) pendingCamera = null
            }
        }

        // The page, and over it the clock in the rail's free slot, right after the last tab and above the settings gear. The page puts the rail
        // after the display cut-out (env(safe-area-inset-left)), so the clock does too, to sit exactly under the tabs.
        val frame = FrameLayout(this)
        this.frame = frame
        overlay = null
        noConnectionShown = false
        connecting = false
        frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val face = makeClock()
        clock = face
        val place = FrameLayout.LayoutParams(dp(RAIL_TAB_WIDTH_DP), dp(RAIL_TAB_HEIGHT_DP), Gravity.BOTTOM or Gravity.START)
            .apply { bottomMargin = dp(CLOCK_BOTTOM_DP); marginStart = dp(1) }
        frame.addView(face, place)
        frame.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            val cutout = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) insets.displayCutout?.safeInsetLeft ?: 0 else 0
            place.marginStart = cutout + dp(1)
            face.layoutParams = place
            insets
        }
        frame.requestApplyInsets()
        updateClock()
        setContentView(frame)
        hideSystemBars()
        connect()
    }

    /** Looks for the address that answers (USB first, then the home network), off the main thread, and only then gives it to the page. */
    private fun connect(quiet: Boolean = false) {
        val view = web ?: return
        val mine = ++round
        if (!quiet) showOverlay(connectingScreen(this))
        val list = candidates
        val pinned = prefs.getString(KEY_FP, null)
        Thread {
            val found = list.indexOfFirst { Probe.answers(it, pinned) }
            runOnUiThread {
                if (mine != round || web !== view) return@runOnUiThread
                if (found >= 0) {
                    candidateIndex = found
                    connecting = true
                    view.loadUrl(list[found])
                } else {
                    showNoConnection()
                }
            }
        }.start()
    }

    private fun showOverlay(screen: View) {
        val host = frame ?: return
        overlay?.let { host.removeView(it) }
        overlay = screen
        host.addView(screen, 1, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) // under the clock
    }

    private fun hideOverlay() {
        handler.removeCallbacks(tryAgain)
        overlay?.let { frame?.removeView(it) }
        overlay = null
        noConnectionShown = false
        connecting = false
    }

    private fun scheduleTryAgain() {
        handler.removeCallbacks(tryAgain)
        handler.postDelayed(tryAgain, RETRY_MS)
    }

    /** Nothing answered: say so in the deck's look, and keep looking by itself; the deck opens as soon as the PC is back. */
    private fun showNoConnection() {
        connecting = false
        if (!noConnectionShown) {
            noConnectionShown = true
            showOverlay(
                noConnectionScreen(
                    this,
                    onTryNow = { handler.removeCallbacks(tryAgain); connect() },
                    onAddress = { showSetup() },
                    onLock = { lockPhone() },
                ),
            )
        }
        scheduleTryAgain()
    }

    private fun matchesPinnedCertificate(certificate: SslCertificate?): Boolean {
        val pinned = prefs.getString(KEY_FP, null)
        if (pinned == null || certificate == null) return false
        return try {
            // saveState keeps the DER bytes of the certificate under this key on every Android version
            val der = SslCertificate.saveState(certificate).getByteArray("x509-certificate") ?: return false
            val digest = MessageDigest.getInstance("SHA-256").digest(der)
            digest.joinToString("") { "%02x".format(it) } == pinned
        } catch (e: Exception) {
            false
        }
    }

    private fun isDeckOrigin(origin: Uri?): Boolean {
        val host = origin?.host ?: return false
        return buildCandidates().any { candidate ->
            val deck = Uri.parse(candidate)
            host.equals(deck.host, ignoreCase = true) && origin.port == deck.port
        }
    }

    private fun answerCameraRequest(request: PermissionRequest) {
        val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
        if (!wantsCamera || !isDeckOrigin(request.origin)) {
            request.deny()
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            pendingCamera = request
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val request = pendingCamera
        if (requestCode != REQUEST_CAMERA || request == null) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else request.deny()
        pendingCamera = null
    }

    private val lockAdmin by lazy { ComponentName(this, LockAdmin::class.java) }

    /**
     * Locks the screen. Android only lets an app do it as a device administrator (just the `force-lock` policy, see LockAdmin): when the
     * role is not on yet, the system's own dialog asks for it, and the screen locks as soon as it is granted.
     */
    private fun lockPhone() {
        val policy = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (policy.isAdminActive(lockAdmin)) {
            policy.lockNow()
            return
        }
        startActivityForResult(
            Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, lockAdmin)
                .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Só para o botão \"Bloquear tela\": o Stream Deck poderá bloquear o celular, e nada mais."),
            REQUEST_ADMIN,
        )
    }

    @Deprecated("The result of the administrator dialog")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_ADMIN && resultCode == RESULT_OK) lockPhone()
    }

    private fun destroyWebView() {
        round += 1 // a search still going on is no longer wanted
        handler.removeCallbacks(tryAgain)
        overlay = null
        frame = null
        noConnectionShown = false
        connecting = false
        web?.destroy()
        web = null
    }

    /** What the page can call as `Android.…`; every method runs on a WebView thread, so the work goes to the UI thread. */
    private inner class Bridge {
        @JavascriptInterface
        fun openSettings() {
            runOnUiThread { showSetup() }
        }

        /** The page's "Bloquear tela" (in the bar that says the PC is gone): locks the phone; the first time, the system asks to turn the administrator role on. */
        @JavascriptInterface
        fun lockScreen() {
            runOnUiThread { lockPhone() }
        }

        /** The page lost the PC for a while: try the other address (USB <-> Wi-Fi), if there is one and it answers. */
        @JavascriptInterface
        fun reconnect() {
            runOnUiThread {
                val view = web ?: return@runOnUiThread
                if (candidates.size < 2) return@runOnUiThread
                val next = (candidateIndex + 1) % candidates.size
                val address = candidates[next]
                val pinned = prefs.getString(KEY_FP, null)
                Thread {
                    if (Probe.answers(address, pinned)) {
                        runOnUiThread {
                            if (web === view) {
                                candidateIndex = next
                                view.loadUrl(address)
                            }
                        }
                    }
                }.start()
            }
        }

        /** Idle dimmer for the AMOLED screen: window brightness to the minimum, or back to the system value. */
        @JavascriptInterface
        fun setDim(on: Boolean) {
            runOnUiThread {
                val params = window.attributes
                params.screenBrightness = if (on) 0.01f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                window.attributes = params
                // the dimmer is meant to be dark: the clock goes with it
                clock?.visibility = if (on) View.INVISIBLE else View.VISIBLE
            }
        }

        /** Short haptic tick for button presses; the page calls it through Deck.vibrate(). */
        @JavascriptInterface
        @Suppress("DEPRECATION")
        fun vibrate(milliseconds: Int) {
            val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
            if (!vibrator.hasVibrator()) return
            val duration = milliseconds.coerceIn(1, 500).toLong()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                vibrator.vibrate(duration)
            }
        }
    }

    // --- setup ----------------------------------------------------------------

    private fun showSetup() {
        showingSetup = true
        clock = null
        destroyWebView()

        val pad = dp(24)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(BACKGROUND)
        }

        val title = TextView(this).apply {
            text = "Conectar ao PC"
            setTextColor(Color.WHITE)
            textSize = 22f
        }

        val hint = TextView(this).apply {
            text = "Cole o endereço que o agente mostra (menu do ícone perto do relógio → Mostrar código de pareamento, ou o server.log):\n" +
                "Wi-Fi: https://IP:7879/?token=…&fp=…\nUSB: http://127.0.0.1:7878/?token=…"
            setTextColor(Color.parseColor("#8B90A0"))
            setPadding(0, dp(8), 0, dp(16))
        }

        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#555A6B"))
            this.hint = "https://192.168.0.10:7879/?token=...&fp=..."
            setText(prefs.getString(KEY_WIFI, prefs.getString(KEY_URL, "")))
        }

        val error = TextView(this).apply { setTextColor(Color.parseColor("#FF6B6B")) }

        val connect = Button(this).apply {
            text = "Conectar"
            setOnClickListener {
                val link = normalize(input.text.toString())
                if (link == null) {
                    error.text = "Endereço inválido. Use o formato https://IP:7879/?token=…&fp=… (Wi-Fi) ou http://127.0.0.1:7878/?token=… (USB)"
                    return@setOnClickListener
                }
                if (link.startsWith("https://")) {
                    if (Uri.parse(link).getQueryParameter("fp") == null) {
                        error.text = "Faltou o &fp=… no endereço Wi-Fi: copie o link completo do agente."
                        return@setOnClickListener
                    }
                    savePairing(null, link)
                } else {
                    savePairing(link, null)
                }
                showDeck()
            }
        }

        val wide = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        for (child in listOf(title, hint, input, error, connect)) root.addView(child, wide)

        setContentView(root)
        hideSystemBars()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

    private companion object {
        const val PREFS = "deck"
        const val KEY_URL = "url" // this PC / USB tunnel
        const val KEY_WIFI = "wifi" // home network (https)
        const val KEY_FP = "fp" // the certificate's SHA-256, lower-case hex
        const val USB_PORT = 7878
        const val REQUEST_CAMERA = 7
        const val REQUEST_ADMIN = 8
        const val RETRY_MS = 5000L // how often the "no connection" screen looks for the PC again
        const val RAIL_TAB_WIDTH_DP = 70 // a tab of the rail: 72 (--rail-w) minus its 1 px of padding on each side
        const val RAIL_TAB_HEIGHT_DP = 48 // --touch
        const val CLOCK_TIME_DP = 14f // where a tab has its 20 px icon
        const val CLOCK_DATE_DP = 11.5f // a little over the 9.6 of a tab's label, which was too small to read at a glance
        const val CLOCK_BOTTOM_DP = 65 // the slot after the sixth tab, above the settings gear (a 48 slot at the bottom)
        val BACKGROUND = Palette.BACKGROUND // the page's --bg, so the app's own screens and the page are one

        /** Accepts "ip:port/?token=x" without a scheme and rejects anything that is not http(s). */
        fun normalize(raw: String?): String? {
            var value = raw?.trim() ?: return null
            if (value.isEmpty()) return null
            if (!value.contains("://")) value = "http://$value"
            if (!value.startsWith("http://") && !value.startsWith("https://")) return null
            return value
        }
    }
}
