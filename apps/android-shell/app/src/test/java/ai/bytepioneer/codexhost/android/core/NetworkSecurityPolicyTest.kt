package ai.bytepioneer.codexhost.android.core

import org.junit.Assert.*
import org.junit.Test

class NetworkSecurityPolicyTest {
    private fun isPrivate(url: String) = Origin.parse(url)?.let(NetworkSecurityPolicy::isPrivateOrLoopback) == true

    @Test fun `identifies private literal ranges and localhost for transport labeling`() {
        listOf(
            "LOCALHOST", "127.0.0.0", "127.255.255.255", "10.0.0.0", "10.255.255.255",
            "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255",
            "100.64.0.0", "100.127.255.255", "[::1]", "[fc00::]", "[fdff::1]", "[fe80::1]", "[febf::1]",
        ).forEach { assertTrue(it, isPrivate("http://$it:4400")) }
    }

    @Test fun `classifies public ranges and DNS names as non-private without DNS lookup`() {
        listOf(
            "localhost.example", "localhost.", "dev.local", "device.tailnet.ts.net", "8.8.8.8", "0.0.0.0",
            "126.255.255.255", "128.0.0.1", "9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.0",
            "192.167.255.255", "192.169.0.0", "100.63.255.255", "100.128.0.0", "169.254.0.1",
            "[::]", "[fbff::1]", "[fe00::1]", "[fe7f::1]", "[fec0::1]", "[2001:4860::1]",
        ).forEach { assertFalse(it, isPrivate("http://$it")) }
    }

    @Test fun `parses public HTTP and HTTPS origins including IDNA domains`() {
        listOf(
            "http://example.net:4400",
            "http://203.0.113.10:4400",
            "http://[2001:4860::1]:4400",
            "http://bücher.example:4400",
            "https://example.net",
            "https://8.8.8.8",
        ).forEach { assertNotNull(it, Origin.parse(it)) }
    }
}
