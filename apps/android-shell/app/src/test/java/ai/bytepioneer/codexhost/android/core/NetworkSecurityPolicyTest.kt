package ai.bytepioneer.codexhost.android.core

import org.junit.Assert.*
import org.junit.Test

class NetworkSecurityPolicyTest {
    private fun allows(url: String) = Origin.parse(url)?.let(NetworkSecurityPolicy::allows) == true

    @Test fun `only specified private literal ranges and localhost allow HTTP`() {
        listOf(
            "LOCALHOST", "127.0.0.0", "127.255.255.255", "10.0.0.0", "10.255.255.255",
            "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255",
            "100.64.0.0", "100.127.255.255", "[::1]", "[fc00::]", "[fdff::1]", "[fe80::1]", "[febf::1]",
        ).forEach { assertTrue(it, allows("http://$it:4400")) }
    }

    @Test fun `rejects public ranges DNS names and ambiguous numeric aliases without DNS`() {
        listOf(
            "localhost.example", "localhost.", "dev.local", "device.tailnet.ts.net", "8.8.8.8", "0.0.0.0",
            "126.255.255.255", "128.0.0.1", "9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.0",
            "192.167.255.255", "192.169.0.0", "100.63.255.255", "100.128.0.0", "169.254.0.1",
            "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "192.168.004.001", "127.0.0.1.",
            "ｌｏｃａｌｈｏｓｔ", "１２７．０．０．１", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]",
            "[fbff::1]", "[fe00::1]", "[fe7f::1]", "[fec0::1]", "[2001:4860::1]",
        ).forEach { assertFalse(it, allows("http://$it")) }
    }

    @Test fun `permits HTTPS without requiring a private host`() {
        listOf("example.net", "8.8.8.8", "[2001:4860::1]", "192.168.1.10").forEach {
            assertTrue(it, allows("https://$it"))
        }
    }
}
