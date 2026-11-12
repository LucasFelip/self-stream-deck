package dev.selfstreamdeck

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    private val usb = "http://127.0.0.1:7878/?token=abc123"
    private val wifi = "https://192.168.0.10:7879/?token=abc123&fp=AB12CD"

    @Test
    fun `an address without a scheme is http and anything that is not http or https is refused`() {
        assertEquals("http://192.168.0.10:7878/?token=x", Pairing.normalize(" 192.168.0.10:7878/?token=x "))
        assertEquals(wifi, Pairing.normalize(wifi))
        for (bad in listOf(null, "", "   ", "ftp://pc/", "javascript://alert(1)", "file:///sdcard/x", "intent://x")) {
            assertNull(bad, Pairing.normalize(bad))
        }
    }

    @Test
    fun `the token and the fingerprint are read from the address and the fingerprint is stored in lower case`() {
        assertEquals("abc123", Pairing.queryParameter(wifi, "token"))
        assertEquals("ab12cd", Pairing.fingerprintOf(wifi))
        assertNull(Pairing.fingerprintOf(usb))
        assertNull(Pairing.queryParameter("https://pc:7879/", "token"))
        assertNull(Pairing.queryParameter("https://pc:7879/?tokenx=1", "token"))
        assertNull(Pairing.queryParameter("not an address", "token"))
        assertEquals("a b", Pairing.queryParameter("http://pc/?token=a%20b", "token"))
    }

    @Test
    fun `usb comes first and with only the wifi address the usb one is made from its token`() {
        assertEquals(listOf(usb, wifi), Pairing.candidates(usb, wifi))
        assertEquals(listOf(usb), Pairing.candidates(usb, null))
        assertEquals(listOf("http://127.0.0.1:7878/?token=abc123", wifi), Pairing.candidates(null, wifi))
        assertEquals(emptyList<String>(), Pairing.candidates(null, null))
    }

    @Test
    fun `only the deck's own host and port count as the deck`() {
        val candidates = Pairing.candidates(usb, wifi)
        assertTrue(Pairing.isDeckOrigin("127.0.0.1", 7878, candidates))
        assertTrue(Pairing.isDeckOrigin("192.168.0.10", 7879, candidates))
        assertFalse("another port", Pairing.isDeckOrigin("192.168.0.10", 7878, candidates))
        assertFalse("another host", Pairing.isDeckOrigin("evil.example.com", 7879, candidates))
        assertFalse(Pairing.isDeckOrigin(null, 7879, candidates))
        assertFalse(Pairing.isDeckOrigin("127.0.0.1", 7878, emptyList()))
    }

    @Test
    fun `a certificate is trusted only when its sha-256 is the paired one`() {
        val der = "abc".toByteArray()
        val pin = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" // SHA-256("abc")
        assertEquals(pin, Pairing.fingerprint(der))
        assertTrue(Pairing.matchesPin(der, pin))
        assertFalse("another certificate", Pairing.matchesPin("abd".toByteArray(), pin))
        assertFalse("the stored pin is lower case", Pairing.matchesPin(der, pin.uppercase()))
        assertFalse("no pin: nothing is trusted", Pairing.matchesPin(der, null))
        assertFalse(Pairing.matchesPin(der, ""))
        assertFalse(Pairing.matchesPin(null, pin))
    }
}
