package dev.selfstreamdeck

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PcsTest {
    private val usbA = "http://127.0.0.1:7878/?token=aaa111"
    private val wifiA = "https://192.168.0.10:7879/?token=aaa111&fp=AB12CD"
    private val usbB = "http://127.0.0.1:7878/?token=bbb222"
    private val wifiB = "https://192.168.0.20:7879/?token=bbb222&fp=EF34AB"

    @Test
    fun `the two addresses of one agent are one computer, found by the token they share`() {
        assertEquals(Pcs.idOf(usbA), Pcs.idOf(wifiA))
        assertTrue(Pcs.idOf(usbA) != Pcs.idOf(usbB))
        assertEquals(12, Pcs.idOf(usbA).length)
        assertTrue("the id is not the token", !Pcs.idOf(usbA).contains("aaa111"))
        assertEquals("192.168.0.10", Pcs.nameOf(usbA, wifiA))
        assertEquals("PC (USB)", Pcs.nameOf(usbA, null))
        assertNull(Pcs.pcOf(null, null))
    }

    @Test
    fun `a second address of a computer is merged into it, keeping the other, and a new computer is appended`() {
        val usbOnly = Pcs.upsert(emptyList(), Pcs.pcOf(usbA, null)!!)
        assertEquals("PC (USB)", usbOnly[0].name)
        val both = Pcs.upsert(usbOnly, Pcs.pcOf(null, wifiA)!!)
        assertEquals(1, both.size)
        assertEquals(usbA, both[0].url)
        assertEquals(wifiA, both[0].wifi)
        assertEquals("192.168.0.10", both[0].name)
        // a new USB address for the same token replaces the old one but keeps the Wi-Fi one
        val again = Pcs.upsert(both, Pcs.pcOf("http://127.0.0.1:7000/?token=aaa111", null)!!)
        assertEquals("http://127.0.0.1:7000/?token=aaa111", again[0].url)
        assertEquals(wifiA, again[0].wifi)
        assertEquals(2, Pcs.upsert(again, Pcs.pcOf(usbB, wifiB)!!).size)
    }

    @Test
    fun `forgetting removes only that computer and the active one falls back to the first`() {
        val list = listOf(Pcs.pcOf(usbA, wifiA)!!, Pcs.pcOf(usbB, wifiB)!!)
        val rest = Pcs.forget(list, list[0].id)
        assertEquals(listOf(list[1]), rest)
        assertEquals(list[1], Pcs.active(rest, list[0].id))
        assertEquals(list[1], Pcs.active(list, list[1].id))
        assertNull(Pcs.active(emptyList(), "x"))
    }

    @Test
    fun `every computer's cable address is tried first, the active one's before the others, then only the active one's Wi-Fi`() {
        val a = Pcs.pcOf(usbA, wifiA)!!
        val b = Pcs.pcOf(usbB, wifiB)!!
        val list = listOf(a, b)
        assertEquals(
            listOf(Candidate(b.id, usbB, null), Candidate(a.id, usbA, null), Candidate(b.id, wifiB, "ef34ab")),
            Pcs.candidates(list, b.id),
        )
        assertEquals(listOf(a.id, b.id, a.id), Pcs.candidates(list, a.id).map { it.pcId })
        assertEquals(wifiA, Pcs.candidates(list, a.id).last().address)
        assertEquals("ab12cd", Pcs.candidates(list, a.id).last().pin)
        assertTrue(Pcs.candidates(emptyList(), null).isEmpty())
    }

    @Test
    fun `a computer paired only over Wi-Fi still gets its cable address, made from its token`() {
        val only = Pcs.pcOf(null, wifiA)!!
        assertEquals(listOf("http://127.0.0.1:7878/?token=aaa111", wifiA), Pcs.candidates(listOf(only), only.id).map { it.address })
        val usbOnly = Pcs.pcOf(usbA, null)!!
        assertEquals(listOf(usbA), Pcs.candidates(listOf(usbOnly), usbOnly.id).map { it.address })
    }

    @Test
    fun `what the first versions stored becomes one computer, or two when the tokens differ`() {
        assertEquals(1, Pcs.fromLegacy(usbA, wifiA).size)
        assertEquals(2, Pcs.fromLegacy(usbA, wifiB).size)
        assertEquals(1, Pcs.fromLegacy(null, wifiA).size)
        assertTrue(Pcs.fromLegacy(null, null).isEmpty())
    }

    @Test
    fun `the list survives being written as text, with tabs and backslashes in a name, and a damaged line is skipped`() {
        val list = listOf(
            Pc("id1", "Mesa\tdo \\ escritório\nbaixo", usbA, wifiA),
            Pc("id2", "PC (USB)", usbB, null),
            Pc("id3", "só Wi-Fi", null, wifiB),
        )
        assertEquals(list, Pcs.decode(Pcs.encode(list)))
        assertEquals(emptyList<Pc>(), Pcs.decode(null))
        assertEquals(emptyList<Pc>(), Pcs.decode(""))
        assertEquals(listOf(list[1]), Pcs.decode("lixo\n${Pcs.encode(listOf(list[1]))}\n\ta\tb"))
    }
}
