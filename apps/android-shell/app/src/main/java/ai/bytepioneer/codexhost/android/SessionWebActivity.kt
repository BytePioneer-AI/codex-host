package ai.bytepioneer.codexhost.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.ConnectivityManager
import android.net.Network
import android.net.http.SslError
import android.os.Bundle
import android.os.Message
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.JavascriptInterface
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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import ai.bytepioneer.codexhost.android.core.AuthResult
import ai.bytepioneer.codexhost.android.core.AuthSessionClient
import ai.bytepioneer.codexhost.android.core.HostProfile
import ai.bytepioneer.codexhost.android.core.Origin
import ai.bytepioneer.codexhost.android.core.SessionAuthRecovery
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.CircularProgressIndicator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class SessionWebActivity : NativeActivity() {
    private enum class SessionState { CONNECTING, CONNECTED, ERROR }

    private inner class AndroidHostSwitcherBridge {
        @JavascriptInterface
        fun getCurrentHostName(): String = currentHostName

        @JavascriptInterface
        fun registerMounted() {
            runOnUiThread {
                if (!isFinishing && !isDestroyed) {
                    bridgeMounted = true
                    fallbackJob?.cancel()
                    fallbackPillBar.isVisible = false
                }
            }
        }

        @JavascriptInterface
        fun openHostSwitcher() {
            runOnUiThread {
                if (!isFinishing && !isDestroyed) switcherSheet.show()
            }
        }
    }

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
    private var fallbackJob: Job? = null
    private var web: WebView? = null
    private var popup: WebView? = null
    private var failed = false
    private var authRecovery: SessionAuthRecovery = SessionAuthRecovery.Ready
    private var revoked = false
    private var opened = false
    private var deleting = false
    private var checkingUpdate = false
    @Volatile
    private var bridgeMounted = false
    @Volatile
    private var currentHostName = ""
    private var sessionState = SessionState.CONNECTING
    private lateinit var id: String
    private lateinit var fallbackPillBar: View
    private lateinit var pillStatusDot: View
    private lateinit var pillHostName: TextView
    private lateinit var pane: FrameLayout
    private lateinit var cover: LinearLayout
    private lateinit var coverIconTile: FrameLayout
    private lateinit var coverIcon: ImageView
    private lateinit var coverProgress: CircularProgressIndicator
    private lateinit var coverTitle: TextView
    private lateinit var coverMessage: TextView
    private lateinit var retry: MaterialButton
    private lateinit var switcherSheet: HostSwitcherSheet
    private var origin: Origin? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        id = intent.getStringExtra(EXTRA_ID).orEmpty()
        setContentView(R.layout.activity_session_web)

        val root = findViewById<View>(R.id.rootContainer)
        installEdgeToEdge(root, root, root, includeIme = true)

        fallbackPillBar = findViewById(R.id.fallbackPillBar)
        pillStatusDot = findViewById(R.id.pillStatusDot)
        pillHostName = findViewById(R.id.pillHostName)
        pane = findViewById(R.id.sessionPane)
        cover = findViewById(R.id.coverPanel)
        coverIconTile = findViewById(R.id.coverIconTile)
        coverIcon = findViewById(R.id.coverIcon)
        coverProgress = findViewById(R.id.coverProgress)
        coverTitle = findViewById(R.id.coverTitle)
        coverMessage = findViewById(R.id.coverMessage)
        retry = findViewById(R.id.retryButton)

        switcherSheet = HostSwitcherSheet(
            activity = this,
            loadHosts = { store.list() },
            activeHostId = { id },
            statusColorRes = ::sessionStatusColorRes,
            onSelect = { targetId -> if (!deleting) switchToHost(targetId) },
            onRename = ::renameHost,
            onDelete = ::deleteHost,
            onAddHost = { if (!deleting) startActivity(Intent(this, PairHostActivity::class.java)) },
            onAllHosts = { finish() },
            onCheckUpdates = {
                HostActions.checkForUpdates(this, { checkingUpdate }, { checkingUpdate = it }, ::openInBrowser)
            },
        )

        findViewById<View>(R.id.hostPill).setOnClickListener { switcherSheet.show() }
        findViewById<MaterialButton>(R.id.switchCoverButton).setOnClickListener { switcherSheet.show() }
        retry.setOnClickListener { if (revoked) pairAgain() else connect() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!cover.isVisible && web?.canGoBack() == true) web?.goBack() else finish()
            }
        })
        connectivity?.let {
            observingNetwork = runCatching { it.registerDefaultNetworkCallback(networkListener) }.isSuccess
        }
        updatePillStatusDot()
        refreshHostUi()
        connect()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val targetId = intent.getStringExtra(EXTRA_ID).orEmpty()
        if (targetId.isNotBlank()) switchToHost(targetId)
    }

    override fun onResume() {
        super.onResume()
        refreshHostUi()
        ApkUpdater.resumePendingInstall(this)
    }

    private fun isOnline() = connectivity?.activeNetwork != null

    private fun sessionStatusColorRes(): Int = when (sessionState) {
        SessionState.CONNECTED -> R.color.status_connected
        SessionState.CONNECTING -> R.color.status_connecting
        SessionState.ERROR -> R.color.status_error
    }

    private fun updatePillStatusDot() {
        pillStatusDot.backgroundTintList = ColorStateList.valueOf(
            ContextCompat.getColor(this, sessionStatusColorRes()),
        )
    }

    private fun updateHostNameCache() {
        runCatching { store.get(id)?.profile?.name }
            .getOrNull()
            ?.let {
                currentHostName = it
                pillHostName.text = it
            }
    }

    private fun refreshHostUi() {
        updateHostNameCache()
        if (switcherSheet.isShowing) switcherSheet.refresh()
    }

    private fun switchToHost(targetId: String) {
        switcherSheet.dismiss()
        if (targetId == id && !revoked && !failed) return
        connection?.cancel()
        connection = null
        fallbackJob?.cancel()
        fallbackJob = null
        bridgeMounted = false
        fallbackPillBar.isVisible = false
        closeWebView()
        if (networkConfigured) {
            runCatching { BrowserBoundary.block(proxyOwner, uiExecutor) }
            networkConfigured = false
        }
        id = targetId
        intent.putExtra(EXTRA_ID, targetId)
        origin = null
        revoked = false
        opened = false
        failed = false
        authRecovery = SessionAuthRecovery.Ready
        retry.setText(R.string.retry)
        updateHostNameCache()
        connect()
        refreshHostUi()
    }

    private fun connect(forceRefresh: Boolean = false) {
        if (connection?.isActive == true || revoked || isFinishing) return
        authRecovery = SessionAuthRecovery.Ready
        failed = false
        bridgeMounted = false
        fallbackJob?.cancel()
        fallbackJob = null
        fallbackPillBar.isVisible = false
        closeWebView() // Discard callbacks and script activity from the previous connection attempt.
        showConnectingCover()
        connection = lifecycleScope.launch {
            try {
                if (!BrowserBoundary.supported()) return@launch showError(R.string.webview_unsupported, false)
                val stored = store.get(id) ?: return@launch showError(R.string.storage_error, false)
                currentHostName = stored.profile.name
                pillHostName.text = stored.profile.name
                val selected = Origin.parse(stored.profile.origin)
                    ?: return@launch showError(R.string.storage_error, false)
                origin = selected
                val token = stored.token
                if (token == null) return@launch showRevoked()
                if (!isOnline()) return@launch showError(R.string.offline)
                BrowserBoundary.initialize(uiExecutor)
                BrowserBoundary.prepareHost(applicationContext, id)
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
                                BrowserBoundary.clearCookies(applicationContext, id)
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
        BrowserBoundary.attachProfile(view, id)
        BrowserBoundary.installCompatPolyfills(view, selected)
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
        view.addJavascriptInterface(AndroidHostSwitcherBridge(), BRIDGE_NAME)
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

    private fun scheduleFallbackPillIfUnmounted() {
        fallbackJob?.cancel()
        if (bridgeMounted) return
        fallbackJob = lifecycleScope.launch {
            delay(FALLBACK_WAIT_MS)
            if (!bridgeMounted && !cover.isVisible && !isFinishing && !isDestroyed) {
                fallbackPillBar.isVisible = true
            }
        }
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
            sessionState = SessionState.CONNECTED
            updatePillStatusDot()
            view.isVisible = true
            cover.isVisible = false
            refreshHostUi()
            scheduleFallbackPillIfUnmounted()
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
        BrowserBoundary.attachProfile(child, id)
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

    private fun showConnectingCover() {
        sessionState = SessionState.CONNECTING
        updatePillStatusDot()
        web?.isVisible = false
        cover.isVisible = true
        coverIconTile.setBackgroundResource(R.drawable.bg_emblem_tile)
        coverIcon.clearColorFilter()
        coverIcon.setImageResource(R.drawable.ic_codexhost_mark)
        coverProgress.isVisible = true
        coverTitle.setText(R.string.session_connecting)
        coverMessage.setText(R.string.connecting_subtitle)
        retry.isVisible = false
        refreshHostUi()
    }

    private fun showError(text: Int, canRetry: Boolean = true) {
        failed = true
        sessionState = SessionState.ERROR
        updatePillStatusDot()
        fallbackJob?.cancel()
        fallbackJob = null
        fallbackPillBar.isVisible = false
        closePopup()
        web?.stopLoading()
        web?.isVisible = false
        cover.isVisible = true
        coverIconTile.setBackgroundResource(R.drawable.bg_error_tile)
        coverIcon.setImageResource(R.drawable.ic_alert)
        coverIcon.setColorFilter(ContextCompat.getColor(this, R.color.error_red))
        coverProgress.isVisible = false
        coverTitle.setText(if (revoked) R.string.token_revoked_title else R.string.connection_failed_title)
        coverMessage.setText(text)
        retry.isVisible = canRetry
        refreshHostUi()
    }

    private fun showRevoked() {
        revoked = true
        retry.setText(R.string.scan_again)
        showError(R.string.token_invalid)
        if (!isFinishing && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.token_revoked_title)
                .setMessage(R.string.token_invalid)
                .setPositiveButton(R.string.scan_again) { _, _ -> pairAgain() }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    private fun pairAgain() {
        startActivity(Intent(this, PairHostActivity::class.java).putExtra(PairHostActivity.EXTRA_ORIGIN, origin?.address))
        finish()
    }

    private fun renameHost(profile: HostProfile) {
        if (deleting) return
        HostActions.showRenameDialog(this, profile) { name ->
            if (runCatching { store.rename(profile.id, name) }.isFailure) tell(R.string.storage_error)
            refreshHostUi()
        }
    }

    private fun deleteHost(profile: HostProfile) {
        if (deleting) return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.delete)
            .setMessage(getString(R.string.delete_host_message, profile.name))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                deleting = true
                lifecycleScope.launch {
                    try {
                        if (!BrowserBoundary.supported()) {
                            tell(R.string.webview_unsupported)
                            return@launch
                        }
                        val deletingCurrent = profile.id == id
                        if (deletingCurrent) {
                            connection?.cancel()
                            connection = null
                            closeWebView()
                            if (networkConfigured) {
                                runCatching { BrowserBoundary.block(proxyOwner, uiExecutor) }
                                networkConfigured = false
                            }
                        }
                        BrowserBoundary.initialize(uiExecutor)
                        BrowserBoundary.deleteProfileData(applicationContext, profile.id)
                        store.delete(profile.id)
                        val remaining = store.list()
                        if (deletingCurrent) {
                            if (remaining.isEmpty()) {
                                switcherSheet.dismiss()
                                finish()
                            } else {
                                switchToHost(remaining.first().id)
                            }
                        } else {
                            refreshHostUi()
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        tell(R.string.storage_error)
                    } finally {
                        deleting = false
                    }
                }
            }
            .show()
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
        switcherSheet.dismiss()
        fallbackJob?.cancel()
        connection?.cancel()
        if (observingNetwork) connectivity?.unregisterNetworkCallback(networkListener)
        closeWebView()
        runCatching { BrowserBoundary.block(proxyOwner, uiExecutor) }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ID = "hostId"
        private const val BRIDGE_NAME = "__codexhostAndroidHostSwitcher"
        private const val FALLBACK_WAIT_MS = 1800L
        fun intent(context: Context, id: String) = Intent(context, SessionWebActivity::class.java).putExtra(EXTRA_ID, id)
    }
}
