package dev.selfstreamdeck

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
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
import android.widget.LinearLayout
import android.widget.TextView
import java.security.MessageDigest
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
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                // this address did not answer: try the next one before giving up
                if (candidateIndex + 1 < candidates.size) {
                    candidateIndex += 1
                    view.loadUrl(candidates[candidateIndex])
                } else {
                    showLoadError()
                }
            }

            // The home-network server's certificate is self-signed: accept it only if it is exactly the one paired with.
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (matchesPinnedCertificate(error.certificate)) handler.proceed() else handler.cancel()
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

        setContentView(view)
        view.loadUrl(candidates[0])
        hideSystemBars()
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

    private fun showLoadError() {
        val base = candidates.firstOrNull() ?: "about:blank"
        val html = "<body style='background:#0e0f13;color:#eceef4;font-family:sans-serif;text-align:center;padding:48px 16px'>" +
            "<h2>Sem conexão com o PC</h2>" +
            "<p style='color:#8b90a0'>Confira se o agente está rodando (ícone perto do relógio) e se o celular está na mesma rede Wi-Fi (ou plugue o cabo USB).</p>" +
            "<p><button style='font-size:1.1rem;padding:12px 24px' onclick='Android.retry()'>Tentar de novo</button></p>" +
            "<p><button style='font-size:1.1rem;padding:12px 24px' onclick='Android.openSettings()'>Configurar endereço</button></p>" +
            "</body>"
        web?.loadDataWithBaseURL(base, html, "text/html", "UTF-8", null)
    }

    private fun destroyWebView() {
        web?.destroy()
        web = null
    }

    /** What the page can call as `Android.…`; every method runs on a WebView thread, so the work goes to the UI thread. */
    private inner class Bridge {
        @JavascriptInterface
        fun openSettings() {
            runOnUiThread { showSetup() }
        }

        /** Starts over from the first address (the error screen's "try again"). */
        @JavascriptInterface
        fun retry() {
            runOnUiThread { showDeck() }
        }

        /** The page lost the PC for a while: try the other address (USB <-> Wi-Fi), if there is one. */
        @JavascriptInterface
        fun reconnect() {
            runOnUiThread {
                val view = web ?: return@runOnUiThread
                if (candidates.size < 2) return@runOnUiThread
                candidateIndex = (candidateIndex + 1) % candidates.size
                view.loadUrl(candidates[candidateIndex])
            }
        }

        /** Idle dimmer for the AMOLED screen: window brightness to the minimum, or back to the system value. */
        @JavascriptInterface
        fun setDim(on: Boolean) {
            runOnUiThread {
                val params = window.attributes
                params.screenBrightness = if (on) 0.01f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                window.attributes = params
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
        val BACKGROUND = Color.parseColor("#0E0F13")

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
