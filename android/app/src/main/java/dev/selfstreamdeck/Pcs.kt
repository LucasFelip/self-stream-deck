package dev.selfstreamdeck

import java.net.URI
import java.security.MessageDigest

/**
 * A computer this phone is paired with. Its `id` comes from the pairing token, which the USB address and the home-network address of one agent
 * share, so pairing the second address of a PC adds to the same entry instead of making a new one.
 */
data class Pc(val id: String, val name: String, val url: String?, val wifi: String?) {
    /** The certificate the home-network address was paired with (lower-case hex), the only one the app trusts for it. */
    val pin: String? get() = wifi?.let { Pairing.fingerprintOf(it) }
}

/** One address to try: the computer it belongs to and, for https, the certificate to insist on. */
data class Candidate(val pcId: String, val address: String, val pin: String?)

/**
 * The list of paired computers and the order in which their addresses are tried, with no Android in it (tested in `app/src/test`).
 * A cable always wins: the address of a plugged-in computer answers at once and that computer becomes the active one. Without a cable only the
 * active computer's home-network address is tried, so the panel never jumps to another PC by itself.
 */
object Pcs {
    /** Stable, short, and not the token itself. */
    fun idOf(address: String): String {
        val seed = Pairing.queryParameter(address, "token") ?: address
        return MessageDigest.getInstance("SHA-256").digest(seed.toByteArray()).take(6).joinToString("") { "%02x".format(it) }
    }

    /** The name shown in the list: the home-network host (an IP or a name), else "PC (USB)". */
    fun nameOf(url: String?, wifi: String?): String {
        val host = try {
            wifi?.let { URI(it).host }
        } catch (e: Exception) {
            null
        }
        return host?.takeIf { it.isNotBlank() } ?: "PC (USB)"
    }

    /** What one pairing (an address or two) says about a computer; `null` when there is no address. */
    fun pcOf(url: String?, wifi: String?): Pc? {
        val key = wifi ?: url ?: return null
        return Pc(idOf(key), nameOf(url, wifi), url, wifi)
    }

    /** Adds a computer, or merges a new address into the one that has this id (the other address is kept). */
    fun upsert(list: List<Pc>, pc: Pc): List<Pc> {
        val old = list.firstOrNull { it.id == pc.id } ?: return list + pc
        val merged = Pc(
            id = old.id,
            name = if (pc.wifi != null) pc.name else old.name,
            url = pc.url ?: old.url,
            wifi = pc.wifi ?: old.wifi,
        )
        return list.map { if (it.id == old.id) merged else it }
    }

    fun forget(list: List<Pc>, id: String): List<Pc> = list.filter { it.id != id }

    /** The active computer: the one with this id, else the first. */
    fun active(list: List<Pc>, activeId: String?): Pc? = list.firstOrNull { it.id == activeId } ?: list.firstOrNull()

    /** What older versions of the app stored: one `url` (USB) and one `wifi` address, as separate keys. */
    fun fromLegacy(url: String?, wifi: String?): List<Pc> {
        var list = emptyList<Pc>()
        pcOf(url, null)?.let { list = upsert(list, it) }
        pcOf(null, wifi)?.let { list = upsert(list, it) }
        return list
    }

    /** The USB address of a computer: the one it was paired with, or one made from its token (the cable then works without pairing again). */
    private fun usbOf(pc: Pc): String? =
        pc.url ?: pc.wifi?.let { Pairing.queryParameter(it, "token") }?.let { "http://127.0.0.1:${Pairing.USB_PORT}/?token=$it" }

    /** The addresses to try, in order: every computer's USB address (the active one first), then the active computer's home network. */
    fun candidates(list: List<Pc>, activeId: String?): List<Candidate> {
        val active = active(list, activeId) ?: return emptyList()
        val ordered = listOf(active) + list.filter { it.id != active.id }
        val usb = ordered.mapNotNull { pc -> usbOf(pc)?.let { Candidate(pc.id, it, null) } }
        val wifi = active.wifi?.let { Candidate(active.id, it, active.pin) }
        return usb + listOfNotNull(wifi)
    }

    // ---- the list as one piece of text (SharedPreferences keeps a String); a line is `id TAB name TAB url TAB wifi`, TAB, line break and backslash escaped

    private fun escape(text: String): String = text.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")

    private fun unescape(text: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '\\' && i + 1 < text.length) {
                out.append(
                    when (text[i + 1]) {
                        't' -> '\t'
                        'n' -> '\n'
                        else -> text[i + 1]
                    },
                )
                i += 2
            } else {
                out.append(c)
                i += 1
            }
        }
        return out.toString()
    }

    fun encode(list: List<Pc>): String =
        list.joinToString("\n") { listOf(it.id, it.name, it.url.orEmpty(), it.wifi.orEmpty()).joinToString("\t") { part -> escape(part) } }

    /** A line that does not have the four fields is skipped, so a damaged value never takes the whole list with it. */
    fun decode(text: String?): List<Pc> =
        text.orEmpty().split("\n").mapNotNull { line ->
            val parts = line.split("\t")
            if (parts.size != 4 || parts[0].isEmpty()) return@mapNotNull null
            val (id, name, url, wifi) = parts.map { unescape(it) }
            Pc(id, name, url.ifEmpty { null }, wifi.ifEmpty { null })
        }
}
