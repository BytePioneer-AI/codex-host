package ai.bytepioneer.codexhost.android.core

import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Cookie
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

internal sealed interface AuthResult {
    class Authenticated(val setCookie: String) : AuthResult
    data object TokenExpiredOrInvalid : AuthResult
    data object RateLimited : AuthResult
    data object Unavailable : AuthResult
    data object Rejected : AuthResult
}

internal class AuthSessionClient {
    fun login(origin: Origin, token: String): AuthResult {
        if (!isToken(token)) return AuthResult.Rejected
        val json = buildJsonObject { put("token", token) }.toString()
        val request = Request.Builder()
            .url(origin.url.resolve("/api/auth/login")!!)
            .header("Cache-Control", "no-store")
            .post(json.toRequestBody("application/json".toMediaType()))
            .build()
        return try {
            client.newCall(request).execute().use { parseResponse(origin, it) }
        } catch (_: IOException) {
            AuthResult.Unavailable
        }
    }

    internal fun parseResponse(origin: Origin, response: Response): AuthResult = when (response.code) {
        401 -> AuthResult.TokenExpiredOrInvalid
        429 -> AuthResult.RateLimited
        200 -> {
            val cookie = response.headers("Set-Cookie").mapNotNull { header ->
                val parsed = Cookie.parse(origin.url, header)
                header.takeIf {
                    parsed != null && parsed.name == origin.cookieName && parsed.value.isNotEmpty() &&
                        parsed.secure == origin.secure && parsed.httpOnly && parsed.hostOnly &&
                        parsed.path == "/" && parsed.expiresAt > System.currentTimeMillis()
                }
            }.singleOrNull()
            val ok = runCatching {
                (Json.parseToJsonElement(response.peekBody(4096).string()) as? JsonObject)
                    ?.get("ok") == JsonPrimitive(true)
            }.getOrDefault(false)
            if (cookie != null && ok) AuthResult.Authenticated(cookie) else AuthResult.Rejected
        }
        else -> AuthResult.Rejected
    }

    companion object {
        private val client = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .proxy(Proxy.NO_PROXY)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname == "localhost") listOf(InetAddress.getByName("127.0.0.1"), InetAddress.getByName("::1"))
                    else Dns.SYSTEM.lookup(hostname)
            })
            .callTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}
