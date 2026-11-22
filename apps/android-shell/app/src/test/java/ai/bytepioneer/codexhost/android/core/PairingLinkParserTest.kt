package ai.bytepioneer.codexhost.android.core

import org.junit.Assert.*
import org.junit.Test

class PairingLinkParserTest {
    @Test fun `normalizes origins and decodes share-link tokens`() {
        val link = PairingLinkParser.parse("  HTTPS://EXAMPLE.net:443/some/path?q=1#token=a%2Bb%3D\n")!!
        assertEquals("https://example.net", link.origin.address)
        assertEquals("a+b=", link.token)
        assertEquals("https://xn--bcher-kva.example", Origin.parse("https://bücher.example/")!!.address)
        assertEquals("http://[::1]:4400", Origin.parse("http://[0:0:0:0:0:0:0:1]:4400/")!!.address)
    }

    @Test fun `manual token works with a bare origin or a normal link`() {
        assertEquals("manual", PairingLinkParser.parse("http://192.168.1.4:4400", " manual ")!!.token)
        assertEquals("manual", PairingLinkParser.parse("https://desktop.example/a#view", "manual")!!.token)
        assertNull(PairingLinkParser.parse("https://desktop.example/#token=scan", "manual"))
    }

    @Test fun `rejects ambiguous credentials and malformed URLs`() {
        listOf(
            "https://example.net", "https://example.net/?token=x", "https://example.net/#token=",
            "https://example.net/#token=x&%74oken=y", "https://example.net/#token=%0Ax",
            "https://example.net/#token=%00", "https://example.net/#token=%FF", "https://example.net/#token=%xx",
            "https://user:pass@example.net/#token=x", "https://example.net%2f/#token=x",
            "https://example.net\\@evil.net/#token=x", "https://example.net:0/#token=x",
            "https://example.net:65536/#token=x", "https://example.net:/#token=x",
            "https:example.net#token=x", "//example.net/#token=x", "ftp://example.net/#token=x",
            "file:///etc/hosts#token=x", "http://[fe80::1%25eth0]/#token=x",
        ).forEach { assertNull(it, PairingLinkParser.parse(it)) }
    }
}
