package ai.bytepioneer.codexhost.android

import androidx.webkit.ProfileStore
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import ai.bytepioneer.codexhost.android.core.Origin
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executor
import kotlin.concurrent.thread
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

internal object BrowserBoundary {
    fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) &&
        WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    fun cookiesFor(id: String) = ProfileStore.getInstance().getOrCreateProfile(id).cookieManager

    suspend fun setCookie(id: String, origin: Origin, header: String): Boolean {
        val cookies = cookiesFor(id)
        val accepted = suspendCancellableCoroutine { continuation ->
            cookies.setCookie(origin.address, header) { result ->
                if (continuation.isActive) continuation.resume(result)
            }
        }
        cookies.flush()
        return accepted
    }

    suspend fun clearCookies(id: String) {
        val profile = ProfileStore.getInstance().getProfile(id) ?: return
        val cookies = profile.cookieManager
        suspendCancellableCoroutine { continuation ->
            cookies.removeAllCookies {
                if (continuation.isActive) continuation.resume(Unit)
            }
        }
        check(!cookies.hasCookies())
        cookies.flush()
    }

    suspend fun deleteProfileData(id: String) {
        val profiles = ProfileStore.getInstance()
        try {
            profiles.deleteProfile(id)
        } catch (_: IllegalStateException) {
            // Chromium cannot delete an already loaded profile. Clear its state and never reuse its id.
            clearCookies(id)
            profiles.getProfile(id)?.webStorage?.deleteAllData()
        }
    }

    // Chromium applies this proxy process-wide, including redirected resources, workers and
    // WebSockets. The proxy accepts no requests; only exact, validated bypass rules go direct.
    private val rejectPort by lazy {
        val socket = ServerSocket(0, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        thread(name = "webview-deny-proxy", isDaemon = true) {
            socket.use { while (true) it.accept().close() }
        }
        socket.localPort
    }

    private fun rules(origin: Origin? = null): ProxyConfig = ProxyConfig.Builder()
        .addProxyRule("http://127.0.0.1:$rejectPort")
        .removeImplicitRules()
        .apply {
            if (origin != null) {
                val authority = "${origin.socketHost}:${origin.url.port}"
                addBypassRule("${origin.url.scheme}://$authority")
                addBypassRule("${if (origin.secure) "wss" else "ws"}://$authority")
            }
        }.build()

    private var initialized = false
    private var owner: Any? = null // Accessed on the main thread; only the latest session may reset the proxy.

    suspend fun initialize(executor: Executor) {
        if (initialized) return
        // Install a default-deny policy before touching a persisted WebView profile.
        applyRules(rules(), executor)
        initialized = true
    }

    suspend fun allow(session: Any, origin: Origin, executor: Executor) {
        owner = session
        applyRules(rules(origin), executor)
    }

    private suspend fun applyRules(config: ProxyConfig, executor: Executor): Unit = suspendCancellableCoroutine { continuation ->
        ProxyController.getInstance().setProxyOverride(config, executor) {
            if (continuation.isActive) continuation.resume(Unit)
        }
    }

    fun block(session: Any, executor: Executor) {
        if (owner !== session) return
        owner = null
        ProxyController.getInstance().setProxyOverride(rules(), executor) {}
    }
}
