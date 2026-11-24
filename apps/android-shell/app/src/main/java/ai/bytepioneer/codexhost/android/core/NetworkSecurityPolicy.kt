package ai.bytepioneer.codexhost.android.core

import java.net.Inet6Address
import java.net.InetAddress

internal object NetworkSecurityPolicy {
    fun isPrivateOrLoopback(origin: Origin): Boolean = isPrivateOrLoopbackHost(origin.url.host)

    private val ipv4 = Regex("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")

    private fun isPrivateOrLoopbackHost(host: String): Boolean {
        if (host == "localhost") return true
        if (ipv4.matches(host)) {
            val octets = host.split('.').map(String::toInt)
            if (octets.any { it > 255 }) return false
            val (a, b) = octets
            return a == 127 || a == 10 || (a == 172 && b in 16..31) ||
                (a == 192 && b == 168) || (a == 100 && b in 64..127)
        }
        // Only numeric IPv6 literals reach InetAddress; there is no DNS lookup for policy decisions.
        if (':' !in host) return false
        val ip = InetAddress.getByName(host) as? Inet6Address ?: return false
        val a = ip.address[0].toInt() and 255
        val b = ip.address[1].toInt() and 255
        return ip.isLoopbackAddress || a in 0xfc..0xfd || (a == 0xfe && b in 0x80..0xbf)
    }
}
