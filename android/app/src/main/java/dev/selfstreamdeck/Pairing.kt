package dev.selfstreamdeck

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

/**
 * What the app knows about reaching the PC, with no Android in it (so it is tested on any machine, `app/src/test`): what a pairing address
 * may look like, which addresses to try and in which order, which page origins are the deck, and whether a certificate is the paired one.
 * The security of the Wi-Fi connection rests on the last one: the app trusts no certificate authority, only that SHA-256.
 */
object Pairing {
    /** The port of the agent on the PC, reached through the USB cable (`adb reverse`). */
    const val USB_PORT = 7878

    /** Accepts "ip:port/?token=x" without a scheme and rejects anything that is not http(s). */
    fun normalize(raw: String?): String? {
        var value = raw?.trim() ?: return null
        if (value.isEmpty()) return null
        if (!value.contains("://")) value = "http://$value"
        if (!value.startsWith("http://") && !value.startsWith("https://")) return null
        return value
    }

    /** One parameter of an address's query ("token", "fp"), decoded; null when the address has none or cannot be read. */
    fun queryParameter(address: String, name: String): String? {
        val query = try {
            URI(address).rawQuery
        } catch (e: Exception) {
            null
        } ?: return null
        for (part in query.split('&')) {
            val key = part.substringBefore('=')
            if (key == name && part.contains('=')) {
                return try {
                    URLDecoder.decode(part.substringAfter('='), "UTF-8")
                } catch (e: Exception) {
                    null
                }
            }
        }
        return null
    }

    /** The certificate fingerprint a home-network address carries (`&fp=`), as it is stored: lower-case hex. */
    fun fingerprintOf(wifi: String): String? = queryParameter(wifi, "fp")?.lowercase()

    /**
     * The addresses to try, in order: this PC / USB first, then the home network. With only a home-network address the USB one is derived
     * from its token, so plugging the cable works without pairing again.
     */
    fun candidates(url: String?, wifi: String?): List<String> {
        val list = ArrayList<String>()
        if (url != null) {
            list.add(url)
        } else if (wifi != null) {
            queryParameter(wifi, "token")?.let { list.add("http://127.0.0.1:$USB_PORT/?token=$it") }
        }
        if (wifi != null) list.add(wifi)
        return list
    }

    /** Is this origin (host and port of a page asking for something, like the camera) one of the deck's own addresses? */
    fun isDeckOrigin(host: String?, port: Int, candidates: List<String>): Boolean {
        if (host == null) return false
        return candidates.any { candidate ->
            val deck = try {
                URI(candidate)
            } catch (e: Exception) {
                return@any false
            }
            host.equals(deck.host, ignoreCase = true) && port == deck.port
        }
    }

    /** SHA-256 of a certificate's DER bytes, lower-case hex: the form the PC shows and the pairing link carries. */
    fun fingerprint(der: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /** Is this the certificate the app was paired with? Never true without a pin or without a certificate. */
    fun matchesPin(der: ByteArray?, pinned: String?): Boolean {
        if (der == null || pinned.isNullOrEmpty()) return false
        return fingerprint(der) == pinned
    }
}
