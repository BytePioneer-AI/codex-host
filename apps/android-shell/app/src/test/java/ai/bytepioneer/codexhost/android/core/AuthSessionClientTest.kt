package ai.bytepioneer.codexhost.android.core

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class AuthSessionClientTest {
    private val auth = AuthSessionClient()
    private val cookie = "codexhost_token=s%2B1; Path=/; HttpOnly; SameSite=Lax; Max-Age=60"

    @Test fun `login sends only native JSON and returns the complete Set-Cookie`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{\"ok\":true}")
                .addHeader("Set-Cookie", "other=value")
                .addHeader("Set-Cookie", cookie))
            val origin = Origin.parse(server.url("/irrelevant?x=y").toString())!!
            val result = auth.login(origin, "s+1") as AuthResult.Authenticated
            assertEquals(cookie, result.setCookie)
            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/auth/login", request.path)
            assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
            assertNull(request.getHeader("Origin"))
            assertNull(request.getHeader("Cookie"))
            assertEquals("{\"token\":\"s+1\"}", request.body.readUtf8())
        }
    }

    @Test fun `rejects redirects without sending the token to a second endpoint`() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", "/other"))
            server.enqueue(MockResponse())
            assertSame(AuthResult.Rejected, auth.login(Origin.parse(server.url("/").toString())!!, "secret"))
            assertEquals(1, server.requestCount)
        }
        assertSame(AuthResult.Rejected, auth.login(Origin.parse("http://example.net")!!, ""))
    }

    @Test fun `distinguishes revoked credentials rate limits and invalid responses`() {
        assertSame(AuthResult.TokenExpiredOrInvalid, parse(401))
        assertSame(AuthResult.RateLimited, parse(429))
        assertSame(AuthResult.Rejected, parse(503))
        assertSame(AuthResult.Rejected, parse(200, body = "{}", cookies = arrayOf(cookie)))
        assertSame(AuthResult.Rejected, parse(200, body = "{\"ok\":\"true\"}", cookies = arrayOf(cookie)))
        listOf(
            emptyArray(), arrayOf(cookie, cookie), arrayOf(cookie.replace("s%2B1", "")),
            arrayOf(cookie.replace("Max-Age=60", "Max-Age=0")), arrayOf(cookie.replace("Path=/", "Path=/api")),
            arrayOf(cookie.replace("; HttpOnly", "")), arrayOf("$cookie; Domain=localhost"), arrayOf("$cookie; Secure"),
        ).forEach { assertSame(AuthResult.Rejected, parse(200, cookies = it)) }
    }

    @Test fun `HTTPS requires a secure host-only cookie with the HTTPS name`() {
        val secureCookie = "__Host-$cookie; Secure"
        assertEquals(secureCookie, (parse(200, https = true, cookies = arrayOf(secureCookie)) as AuthResult.Authenticated).setCookie)
        assertSame(AuthResult.Rejected, parse(200, https = true, cookies = arrayOf("$cookie; Secure")))
        assertSame(AuthResult.Rejected, parse(200, https = true, cookies = arrayOf("__Host-$cookie")))
    }

    private fun parse(code: Int, https: Boolean = false, body: String = "{\"ok\":true}", cookies: Array<String> = emptyArray()): AuthResult {
        val origin = Origin.parse(if (https) "https://localhost" else "http://localhost")!!
        val response = Response.Builder().request(Request.Builder().url(origin.url).build())
            .protocol(Protocol.HTTP_1_1).code(code).message("Test").body(body.toResponseBody())
            .apply { cookies.forEach { addHeader("Set-Cookie", it) } }.build()
        return response.use { auth.parseResponse(origin, it) }
    }
}
