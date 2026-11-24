package ai.bytepioneer.codexhost.android.core

import java.net.IDN
import java.net.URI
import java.util.Locale
import okhttp3.HttpUrl

@ConsistentCopyVisibility
internal data class Origin private constructor(val url: HttpUrl) {
    val address: String get() = url.toString().removeSuffix("/")
    val secure: Boolean get() = url.isHttps
    val cookieName: String get() = if (secure) "__Host-codexhost_token" else "codexhost_token"
    val socketHost: String get() = if (':' in url.host) "[${url.host}]" else url.host

    fun allowsWebRequest(target: String, isMainFrame: Boolean): Boolean {
        // Previews use local data and object URLs, not additional document origins.
        if (!isMainFrame) {
            if (target.startsWith("data:", ignoreCase = true)) return true
            if (target.startsWith("blob:", ignoreCase = true)) return parse(target.substring(5)) == this
        }
        return parse(target) == this
    }

    companion object {
        fun parse(text: String): Origin? = try {
            parseUri(URI(text))
        } catch (_: Exception) {
            null
        }

        fun parseUri(uri: URI): Origin? {
            val scheme = uri.scheme?.lowercase(Locale.ROOT)
            if (scheme != "http" && scheme != "https") return null
            val authority = uri.rawAuthority ?: return null
            if (authority.endsWith(':') || authority.any { it == '%' || it == '@' }) return null
            // URI recognizes bracketed IPv6 and ASCII DNS. Convert Unicode DNS to IDNA separately.
            val server = if (uri.host != null) uri else {
                val dns = authority.substringBefore(':')
                if (dns == authority && ('[' in dns || ']' in dns)) return null
                URI("$scheme://${IDN.toASCII(dns, IDN.USE_STD3_ASCII_RULES)}${authority.removePrefix(dns)}")
            }
            val host = server.host ?: return null
            if (server.port != -1 && server.port !in 1..65535) return null
            val url = HttpUrl.Builder().scheme(scheme).host(host).apply {
                if (server.port != -1) port(server.port)
            }.build()
            return Origin(url)
        }
    }
}
