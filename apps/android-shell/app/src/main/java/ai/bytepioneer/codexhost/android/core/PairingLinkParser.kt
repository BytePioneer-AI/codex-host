package ai.bytepioneer.codexhost.android.core

import java.net.URI
import java.net.URLDecoder

internal class PairingLink(val origin: Origin, val token: String)

internal object PairingLinkParser {
    fun parse(text: String, manualToken: String = ""): PairingLink? = try {
        parseLink(URI(text.trim()), manualToken.trim())
    } catch (_: Exception) {
        null
    }

    private fun parseLink(uri: URI, manualToken: String): PairingLink? {
        val origin = Origin.parseUri(uri) ?: return null
        val fragmentTokens = uri.rawFragment.orEmpty().split('&').mapNotNull { field ->
            val name = URLDecoder.decode(field.substringBefore('='), "UTF-8")
            if (name == "token") URLDecoder.decode(field.substringAfter('=', ""), "UTF-8") else null
        }
        if (fragmentTokens.size > 1) return null
        val fragmentToken = fragmentTokens.singleOrNull()
        if (manualToken.isNotEmpty() && fragmentToken != null && manualToken != fragmentToken) return null
        val token = fragmentToken ?: manualToken
        if (!isToken(token)) return null
        return PairingLink(origin, token)
    }
}

internal fun isToken(token: String): Boolean =
    token.length in 1..4096 && token.none { it.isWhitespace() || it.isISOControl() || it == '\uFFFD' }
