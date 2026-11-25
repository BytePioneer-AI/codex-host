package ai.bytepioneer.codexhost.android

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ai.bytepioneer.codexhost.android.core.Origin
import ai.bytepioneer.codexhost.android.core.SingleProfileIsolation
import ai.bytepioneer.codexhost.android.core.SingleProfileOwnerStore
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executor
import kotlin.concurrent.thread
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

internal object BrowserBoundary {
    private const val SINGLE_PROFILE_PREFS = "browser_boundary"
    private const val ACTIVE_HOST_KEY = "single_profile_host_id"

    fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)

    fun supportsMultiProfile(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    fun attachProfile(view: WebView, id: String) {
        if (supportsMultiProfile()) {
            WebViewCompat.setProfile(view, id)
        }
    }

    fun installCompatPolyfills(view: WebView, origin: Origin) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addDocumentStartJavaScript(view, WEBVIEW_COMPAT_POLYFILL_JS, setOf(origin.address))
    }

    fun cookiesFor(id: String): CookieManager =
        if (supportsMultiProfile()) {
            ProfileStore.getInstance().getOrCreateProfile(id).cookieManager
        } else {
            CookieManager.getInstance()
        }

    suspend fun prepareHost(context: Context, id: String) {
        if (supportsMultiProfile()) return
        singleProfileIsolation(context).prepareHost(id) {
            clearDefaultProfileData()
        }
    }

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

    suspend fun clearCookies(context: Context, id: String) {
        if (supportsMultiProfile()) {
            val profile = ProfileStore.getInstance().getProfile(id) ?: return
            clearCookieManager(profile.cookieManager)
        } else {
            singleProfileIsolation(context).clearHostData(id) {
                clearDefaultProfileData()
            }
        }
    }

    suspend fun deleteProfileData(context: Context, id: String) {
        if (supportsMultiProfile()) {
            val profiles = ProfileStore.getInstance()
            try {
                profiles.deleteProfile(id)
            } catch (_: IllegalStateException) {
                // Chromium cannot delete an already loaded profile. Clear its state and never reuse its id.
                clearCookies(context, id)
                profiles.getProfile(id)?.webStorage?.deleteAllData()
            }
        } else {
            singleProfileIsolation(context).clearHostData(id) {
                clearDefaultProfileData()
            }
        }
    }

    private suspend fun clearCookieManager(cookies: CookieManager) {
        suspendCancellableCoroutine { continuation ->
            cookies.removeAllCookies {
                if (continuation.isActive) continuation.resume(Unit)
            }
        }
        check(!cookies.hasCookies())
        cookies.flush()
    }

    private suspend fun clearDefaultProfileData() {
        clearCookieManager(CookieManager.getInstance())
        WebStorage.getInstance().deleteAllData()
    }

    private fun singleProfileIsolation(context: Context): SingleProfileIsolation {
        val prefs = context.applicationContext.getSharedPreferences(SINGLE_PROFILE_PREFS, Context.MODE_PRIVATE)
        return SingleProfileIsolation(object : SingleProfileOwnerStore {
            override fun readOwner(): String? = prefs.getString(ACTIVE_HOST_KEY, null)

            override fun writeOwner(hostId: String?) {
                val editor = prefs.edit()
                if (hostId == null) editor.remove(ACTIVE_HOST_KEY) else editor.putString(ACTIVE_HOST_KEY, hostId)
                check(editor.commit())
            }
        })
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

    // Older vendor WebViews (such as HarmonyOS WebView based on Chromium 114) lack ES2024/Web APIs
    // used by the Web UI (e.g. AbortSignal.any in Chromium 116, Promise.withResolvers in Chromium 119).
    // Each shim is feature-detected so modern WebViews remain untouched.
    private val WEBVIEW_COMPAT_POLYFILL_JS = """
        (function () {
          if (typeof Promise === "function" && typeof Promise.withResolvers !== "function") {
            Promise.withResolvers = function withResolvers() {
              var resolve;
              var reject;
              var promise = new this(function (res, rej) {
                resolve = res;
                reject = rej;
              });
              return { promise: promise, resolve: resolve, reject: reject };
            };
          }
          if (typeof Promise === "function" && typeof Promise.try !== "function") {
            Promise.try = function promiseTry(fn) {
              var args = Array.prototype.slice.call(arguments, 1);
              return new this(function (resolve) {
                resolve(fn.apply(undefined, args));
              });
            };
          }
          if (typeof AbortSignal === "function" && typeof AbortSignal.any !== "function") {
            AbortSignal.any = function any(signals) {
              var list = Array.from(signals);
              for (var i = 0; i < list.length; i++) {
                var existing = list[i];
                if (!existing || typeof existing.aborted !== "boolean") {
                  throw new TypeError("Failed to execute 'any' on 'AbortSignal': member is not an AbortSignal.");
                }
                if (existing.aborted) {
                  if (typeof AbortSignal.abort === "function") return AbortSignal.abort(existing.reason);
                  var aborted = new AbortController();
                  aborted.abort(existing.reason);
                  return aborted.signal;
                }
              }
              var controller = new AbortController();
              var listeners = [];
              function cleanup() {
                for (var j = 0; j < listeners.length; j++) {
                  listeners[j][0].removeEventListener("abort", listeners[j][1]);
                }
                listeners.length = 0;
              }
              for (var k = 0; k < list.length; k++) {
                (function (sig) {
                  function onAbort() {
                    cleanup();
                    controller.abort(sig.reason);
                  }
                  listeners.push([sig, onAbort]);
                  sig.addEventListener("abort", onAbort, { once: true });
                })(list[k]);
              }
              return controller.signal;
            };
          }
          if (typeof Object.groupBy !== "function") {
            Object.groupBy = function groupBy(items, callbackFn) {
              var result = Object.create(null);
              var index = 0;
              for (var item of items) {
                var key = callbackFn(item, index++);
                if (result[key] === undefined) result[key] = [];
                result[key].push(item);
              }
              return result;
            };
          }
          if (typeof Map === "function" && typeof Map.groupBy !== "function") {
            Map.groupBy = function groupBy(items, callbackFn) {
              var result = new Map();
              var index = 0;
              for (var item of items) {
                var key = callbackFn(item, index++);
                var group = result.get(key);
                if (group === undefined) {
                  group = [];
                  result.set(key, group);
                }
                group.push(item);
              }
              return result;
            };
          }
          if (typeof URL === "function") {
            if (typeof URL.canParse !== "function") {
              URL.canParse = function canParse(url, base) {
                try {
                  if (arguments.length > 1 && base !== undefined) new URL(url, base);
                  else new URL(url);
                  return true;
                } catch (_e) {
                  return false;
                }
              };
            }
            if (typeof URL.parse !== "function") {
              URL.parse = function parse(url, base) {
                try {
                  return arguments.length > 1 && base !== undefined ? new URL(url, base) : new URL(url);
                } catch (_e) {
                  return null;
                }
              };
            }
          }
        })();
    """.trimIndent()
}
