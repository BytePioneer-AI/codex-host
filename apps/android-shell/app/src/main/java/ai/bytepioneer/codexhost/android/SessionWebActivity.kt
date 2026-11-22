package ai.bytepioneer.codexhost.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.http.SslError
import android.os.Bundle
import android.os.Message
import android.os.SystemClock
import android.text.TextUtils
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import ai.bytepioneer.codexhost.android.core.AuthResult
import ai.bytepioneer.codexhost.android.core.AuthSessionClient
import ai.bytepioneer.codexhost.android.core.NetworkSecurityPolicy
import ai.bytepioneer.codexhost.android.core.Origin
import ai.bytepioneer.codexhost.android.core.SessionAuthRecovery
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class SessionWebActivity : NativeActivity() {
    private val uploads = AttachmentPicker(this) { tell(R.string.picker_error) }
    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private val networkListener = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(network: Network) = runOnUiThread {
            if (!isFinishing && !isDestroyed && !revoked && isOnline().not()) {
                connection?.cancel()
                showError(R.string.offline)
            }
        }
    }
    private var observingNetwork = false
    private val proxyOwner = Any()
    private var networkConfigured = false
    private var connection: Job? = null
    private var web: WebView? = null
    private var popup: WebView? = null
    private var failed = false
    private var authRecovery: SessionAuthRecovery = SessionAuthRecovery.Ready
    private var revoked = false
    private var opened = false
    private lateinit var id: String
    private lateinit var pane: FrameLayout
    private lateinit var cover: LinearLayout
    private lateinit var message: TextView
    private lateinit var title: TextView
    private lateinit var retry: MaterialButton
    private var origin: Origin? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        id = intent.getStringExtra(EXTRA_ID).orEmpty()
        val screen = screen(includeIme = true)
        title = label(size = 15f).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        screen.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(8), 0)
            addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(button(R.string.switch_host) { finish() }.apply { textSize = 12f; minimumHeight = dp(40) })
        })
        pane = FrameLayout(this)
        message = label()
        retry = button(R.string.retry) { if (revoked) pairAgain() else connect() }
        cover = column(20).apply {
            gravity = Gravity.CENTER
            addView(message)
            addView(retry)
            addView(button(R.string.switch_host) { finish() })
        }
        pane.addView(cover, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        screen.addView(pane, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val current = web
                if (!cover.isVisible && current?.canGoBack() == true) current.goBack() else finish()
            }
        })
        connectivity?.let {
            observingNetwork = runCatching { it.registerDefaultNetworkCallback(networkListener) }.isSuccess
        }
        connect()
    }

    private fun isOnline() = connectivity?.activeNetwork != null

    private fun connect(forceRefresh: Boolean = false) {
        if (connection?.isActive == true || revoked || isFinishing) return
        authRecovery = SessionAuthRecovery.Ready
        failed = false
        closeWebView() // Discard callbacks and script activity from the previous connection attempt.
        showCover(R.string.session_connecting)
        retry.isVisible = false
        connection = lifecycleScope.launch {
            try {
                if (!BrowserBoundary.supported()) return@launch showError(R.string.webview_unsupported, false)
                val stored = store.get(id) ?: return@launch showError(R.string.storage_error, false)
                val selected = Origin.parse(stored.profile.origin)?.takeIf(NetworkSecurityPolicy::allows)
                    ?: return@launch showError(R.string.private_http_only, false)
                origin = selected
                title.text = stored.profile.name
                val token = stored.token
                if (token == null) return@launch showRevoked()
                if (!isOnline()) return@launch showError(R.string.offline)
                BrowserBoundary.initialize(uiExecutor)
                val cookies = BrowserBoundary.cookiesFor(id)
                val hasCookie = cookies.getCookie(selected.address).orEmpty().split(';').any { part ->
                    part.substringBefore('=').trim() == selected.cookieName && part.substringAfter('=', "").isNotEmpty()
                }
                if (!hasCookie || forceRefresh) {
                    when (val auth = withContext(Dispatchers.IO) { AuthSessionClient().login(selected, token) }) {
                        is AuthResult.Authenticated -> {
                            if (!BrowserBoundary.setCookie(id, selected, auth.setCookie)) {
                                return@launch showError(R.string.cookie_error)
                            }
                            authRecovery = SessionAuthRecovery.LoadingWithFreshCookie
                        }
                        AuthResult.TokenExpiredOrInvalid -> {
                            closeWebView()
                            runCatching { BrowserBoundary.block(proxyOwner, uiExecutor) }
                            // Persist the revocation independently of WebView's cookie operations.
                            val persisted = runCatching { store.clearToken(id) }.isSuccess
                            showRevoked()
                            try {
                                BrowserBoundary.clearCookies(id)
                            } finally {
                                if (!persisted) tell(R.string.storage_error)
                            }
                            return@launch
                        }
                        AuthResult.RateLimited -> return@launch showError(R.string.rate_limited)
                        AuthResult.Unavailable -> return@launch showError(if (isOnline()) R.string.host_unreachable else R.string.offline)
                        AuthResult.Rejected -> return@launch showError(R.string.host_rejected)
                    }
                }
                if (!networkConfigured) {
                    BrowserBoundary.allow(proxyOwner, selected, uiExecutor)
                    networkConfigured = true
                }
                if (!isOnline()) return@launch showError(R.string.offline)
                val browser = web ?: createWebView(selected)
                browser.loadUrl(selected.url.toString())
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (!revoked) showError(R.string.web_session_error) else tell(R.string.storage_error)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // Only the paired codexhost origin can run inside this WebView.
    private fun createWebView(selected: Origin): WebView = WebView(this).also { view ->
        web = view
        WebViewCompat.setProfile(view, id)
        BrowserBoundary.cookiesFor(id).setAcceptThirdPartyCookies(view, false)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)
        }
        view.webViewClient = SessionClient(selected)
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<android.net.Uri>>, params: FileChooserParams): Boolean {
                if (failed || cover.isVisible || web !== view) callback.onReceiveValue(null) else uploads.choose(callback, params)
                return true
            }

            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean =
                isUserGesture && !failed && openPopup(selected, resultMsg)
        }
        pane.addView(view, 0, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        view.isVisible = false
    }

    private inner class SessionClient(private val selected: Origin) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (failed || web !== view) return true
            val target = request.url.toString()
            if (Origin.parse(target) == selected) return false
            if (request.isForMainFrame && Origin.parse(target) != null) {
                if (cover.isVisible) showError(R.string.web_session_error)
                openInBrowser(target)
            }
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            blockForeignRequest(request, selected)

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (web !== view || failed || Origin.parse(url) != selected) return
            authRecovery = authRecovery.onPageVisible(SystemClock.elapsedRealtime())
            view.isVisible = true
            cover.isVisible = false
            if (!opened) {
                opened = true
                if (runCatching { store.markOpened(id) }.isFailure) tell(R.string.storage_error)
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, error: WebResourceResponse) {
            if (failed || web !== view || Origin.parse(request.url.toString()) != selected) return
            if (!request.isForMainFrame && request.url.path != "/api/auth/status") return
            when (error.statusCode) {
                401 -> if (authRecovery.canRefreshAfterUnauthorized(SystemClock.elapsedRealtime())) {
                    connect(forceRefresh = true)
                } else {
                    showError(R.string.host_rejected)
                }
                429 -> showError(R.string.rate_limited)
                else -> if (request.isForMainFrame) showError(R.string.web_session_error)
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (web === view && !failed && request.isForMainFrame) {
                showError(if (isOnline()) R.string.host_unreachable else R.string.offline)
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (web === view && !failed && Origin.parse(error.url) == selected) showError(R.string.untrusted_tls)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (web === view) {
                closeWebView()
                showError(R.string.web_session_error)
            }
            return true
        }
    }

    private fun blockForeignRequest(request: WebResourceRequest, selected: Origin): WebResourceResponse? =
        if (selected.allowsWebRequest(request.url.toString(), request.isForMainFrame)) null else
            WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), null)

    private fun openPopup(selected: Origin, resultMsg: Message): Boolean {
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        closePopup()
        val child = WebView(this)
        popup = child
        WebViewCompat.setProfile(child, id)
        child.settings.allowFileAccess = false
        child.settings.allowContentAccess = false
        child.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url == "about:blank") return false // Some pages open a blank window before setting its URL.
                if (request.isForMainFrame && !failed) {
                    val target = Origin.parse(url)
                    if (target == selected) web?.loadUrl(url) else if (target != null) openInBrowser(url)
                    pane.post { if (popup === view) closePopup() }
                }
                return true
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                blockForeignRequest(request, selected)

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (popup === view) closePopup()
                return true
            }
        }
        transport.webView = child
        resultMsg.sendToTarget()
        return true
    }

    private fun showCover(text: Int) {
        web?.isVisible = false
        cover.isVisible = true
        message.setText(text)
    }

    private fun showError(text: Int, canRetry: Boolean = true) {
        failed = true
        closePopup()
        web?.stopLoading()
        showCover(text)
        retry.isVisible = canRetry
    }

    private fun showRevoked() {
        revoked = true
        retry.setText(R.string.scan_again)
        showError(R.string.token_invalid)
        if (!isFinishing && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
            MaterialAlertDialogBuilder(this).setMessage(R.string.token_invalid)
                .setPositiveButton(R.string.scan_again) { _, _ -> pairAgain() }
                .setNegativeButton(android.R.string.cancel, null).show()
        }
    }

    private fun pairAgain() {
        startActivity(Intent(this, PairHostActivity::class.java).putExtra(PairHostActivity.EXTRA_ORIGIN, origin?.address))
        finish()
    }

    private fun closePopup() {
        val child = popup ?: return
        popup = null
        child.destroy()
    }

    private fun closeWebView() {
        closePopup()
        uploads.close()
        val browser = web ?: return
        web = null
        pane.removeView(browser)
        browser.destroy()
    }

    override fun onDestroy() {
        connection?.cancel()
        if (observingNetwork) connectivity?.unregisterNetworkCallback(networkListener)
        closeWebView()
        runCatching { BrowserBoundary.block(proxyOwner, uiExecutor) }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ID = "hostId"
        fun intent(context: Context, id: String) = Intent(context, SessionWebActivity::class.java).putExtra(EXTRA_ID, id)
    }
}
