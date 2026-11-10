package dev.selfstreamdeck

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlin.math.roundToInt

/** The colors of the deck's page (web/src/styles/style.css), so what the app draws itself looks like the page. */
object Palette {
    val BACKGROUND = Color.parseColor("#0B0C10") // --bg
    val SURFACE_2 = Color.parseColor("#181B22") // --surface-2
    val BORDER = Color.parseColor("#1C1F27") // --border
    val TEXT = Color.parseColor("#D7DAE3") // --text
    val MUTED = Color.parseColor("#7D8394") // --muted
    val ACCENT = Color.parseColor("#7C9CFF") // --accent
}

/**
 * Asks an address of the deck whether the PC is there, before the page is given the address: `GET /api/ping` answers 200 only from the agent.
 * That way the WebView is only pointed at an address that works, and the browser's own "Página da Web não disponível" never shows.
 * The home-network (https) address is checked against the paired certificate's SHA-256, as the page itself is.
 */
object Probe {
    private const val TIMEOUT_MS = 2500

    /** Blocks: call it off the main thread. */
    fun answers(address: String, pinnedFingerprint: String?): Boolean {
        return try {
            val uri = Uri.parse(address)
            val token = uri.getQueryParameter("token") ?: return false
            val connection = URL("${uri.scheme}://${uri.authority}/api/ping?token=$token").openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                connection.instanceFollowRedirects = false
                if (connection is HttpsURLConnection) {
                    val pin = pinnedFingerprint ?: return false
                    connection.sslSocketFactory = SSLContext.getInstance("TLS").apply { init(null, arrayOf(PinnedTrust(pin)), null) }.socketFactory
                    connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true } // the pin identifies the server, not its name
                }
                connection.responseCode == 200
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            false
        }
    }

    /** Trusts exactly one certificate: the one whose SHA-256 is the one the app was paired with. */
    private class PinnedTrust(private val fingerprint: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("no client certificates")

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val der = chain?.firstOrNull()?.encoded ?: throw CertificateException("no certificate")
            val seen = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }
            if (seen != fingerprint) throw CertificateException("not the certificate this app was paired with")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}

private fun Context.dp(value: Float): Int = (value * resources.displayMetrics.density).roundToInt()

private fun Context.label(text: String, sizeDp: Float, weight: Int, color: Int): TextView = TextView(this).apply {
    this.text = text
    setTextColor(color)
    setTextSize(TypedValue.COMPLEX_UNIT_DIP, sizeDp)
    typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, weight, false) else Typeface.DEFAULT
    gravity = Gravity.CENTER
    includeFontPadding = false
}

/** A button like the page's (`.overlay-close`): 48 high, rounded 12, the muted surface with a hairline border; the main one in the accent color. */
private fun Context.deckButton(text: String, main: Boolean, onClick: () -> Unit): Button = Button(this).apply {
    this.text = text
    isAllCaps = false
    stateListAnimator = null
    setTextColor(if (main) Palette.ACCENT else Palette.TEXT)
    setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12.8f)
    typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, 600, false) else Typeface.DEFAULT_BOLD
    background = GradientDrawable().apply {
        cornerRadius = dp(12f).toFloat()
        setColor(Palette.SURFACE_2)
        setStroke(dp(1f), if (main) Palette.ACCENT else Palette.BORDER)
    }
    minHeight = dp(48f)
    minimumHeight = dp(48f)
    setPadding(dp(16f), 0, dp(16f), 0)
    maxLines = 1
    setOnClickListener { onClick() }
}

private fun Context.status(text: String): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER
    addView(
        ProgressBar(this@status).apply { indeterminateTintList = ColorStateList.valueOf(Palette.MUTED) },
        LinearLayout.LayoutParams(dp(14f), dp(14f)).apply { marginEnd = dp(8f) },
    )
    addView(label(text, 11.5f, 500, Palette.MUTED))
}

private fun Context.column(vararg children: View): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER
    for (child in children) addView(child, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) })
}

private fun Context.screen(content: View): FrameLayout = FrameLayout(this).apply {
    setBackgroundColor(Palette.BACKGROUND)
    isClickable = true // it covers the page: touches must not reach it
    addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
}

private fun Context.icon(): ImageView = ImageView(this).apply {
    setImageResource(R.drawable.ic_no_connection)
    layoutParams = LinearLayout.LayoutParams(dp(52f), dp(52f))
}

/** While an address is being tried: the same background as the page, so the change into the deck is a fade-in, not a flash. */
fun connectingScreen(context: Context): View = with(context) {
    screen(column(label("Conectando ao PC…", 16f, 700, Palette.TEXT), status("Procurando o PC")))
}

/**
 * When no address answers: what happened, what to check, and what to do, in the deck's own look. It tries again by itself (the caller does),
 * so it also goes away by itself when the PC comes back.
 */
fun noConnectionScreen(context: Context, onTryNow: () -> Unit, onAddress: () -> Unit, onLock: () -> Unit): View = with(context) {
    val narrow = resources.displayMetrics.widthPixels / resources.displayMetrics.density < 520
    val buttons = LinearLayout(this).apply {
        orientation = if (narrow) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        if (!narrow) minimumWidth = dp(540f) // the three buttons side by side, each wide enough for its text on one line
        for ((index, button) in listOf(deckButton("Tentar agora", true, onTryNow), deckButton("Configurar endereço", false, onAddress), deckButton("Bloquear tela", false, onLock)).withIndex()) {
            val params = if (narrow) LinearLayout.LayoutParams(dp(260f), dp(48f)) else LinearLayout.LayoutParams(0, dp(48f), 1f)
            if (index > 0) { if (narrow) params.topMargin = dp(8f) else params.marginStart = dp(8f) }
            addView(button, params)
        }
    }
    val message = label("Confira se o agente está rodando (o ícone perto do relógio do PC) e se o celular está no mesmo Wi-Fi, ou plugue o cabo USB.", 12.8f, 400, Palette.MUTED)
        .apply { setLineSpacing(0f, 1.25f); maxWidth = dp(420f) }
    val body = column(icon(), label("Sem conexão com o PC", 18f, 700, Palette.TEXT), message, status("Tentando de novo a cada 5 segundos"), buttons)
    body.getChildAt(body.childCount - 1).let { (it.layoutParams as LinearLayout.LayoutParams).topMargin = dp(18f); it.layoutParams = it.layoutParams }
    screen(body)
}
