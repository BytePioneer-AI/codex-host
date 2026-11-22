package ai.bytepioneer.codexhost.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
import android.net.http.SslError
import android.os.Bundle
import android.os.Message
import android.os.SystemClock
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
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
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.view.GravityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import androidx.drawerlayout.widget.DrawerLayout
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import androidx.webkit.WebViewCompat
import ai.bytepioneer.codexhost.android.core.AuthResult
import ai.bytepioneer.codexhost.android.core.AuthSessionClient
import ai.bytepioneer.codexhost.android.core.HostProfile
import ai.bytepioneer.codexhost.android.core.NetworkSecurityPolicy
import ai.bytepioneer.codexhost.android.core.Origin
import ai.bytepioneer.codexhost.android.core.SessionAuthRecovery
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.CircularProgressIndicator
import kotlin.math.abs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class SessionWebActivity : NativeActivity() {
    private enum class SessionState { CONNECTING, CONNECTED, ERROR }

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
    private var deleting = false
    private var checkingUpdate = false
    private var imeVisible = false
    private var sessionState = SessionState.CONNECTING
    private lateinit var id: String
    private lateinit var drawerLayout: DrawerLayout
    private lateinit var contentContainer: FrameLayout
    private lateinit var pane: FrameLayout
    private lateinit var cover: LinearLayout
    private lateinit var coverIconTile: FrameLayout
    private lateinit var coverIcon: ImageView
    private lateinit var coverProgress: CircularProgressIndicator
    private lateinit var coverTitle: TextView
    private lateinit var coverMessage: TextView
    private lateinit var retry: MaterialButton
    private lateinit var drawerEdgeHandle: FrameLayout
    private lateinit var hostDrawer: LinearLayout
    private val drawerAdapter = DrawerHostRows()
    private var origin: Origin? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        id = intent.getStringExtra(EXTRA_ID).orEmpty()
        enableEdgeToEdge()
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        setContentView(R.layout.activity_session_web)

        drawerLayout = findViewById<DrawerLayout>(R.id.drawerLayout).apply {
            setScrimColor(0x66090B10)
        }
        contentContainer = findViewById(R.id.contentContainer)
        pane = findViewById(R.id.sessionPane)
        cover = findViewById(R.id.coverPanel)
        coverIconTile = findViewById(R.id.coverIconTile)
        coverIcon = findViewById(R.id.coverIcon)
        coverProgress = findViewById(R.id.coverProgress)
        coverTitle = findViewById(R.id.coverTitle)
        coverMessage = findViewById(R.id.coverMessage)
        retry = findViewById(R.id.retryButton)
        drawerEdgeHandle = findViewById(R.id.drawerEdgeHandle)
        hostDrawer = findViewById(R.id.hostDrawer)

        val initialDrawerTop = hostDrawer.paddingTop
        val initialDrawerBottom = hostDrawer.paddingBottom
        val initialDrawerRight = hostDrawer.paddingRight
        ViewCompat.setOnApplyWindowInsetsListener(drawerLayout) { _, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val imeAndBars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            contentContainer.updatePadding(
                left = imeAndBars.left,
                top = systemBars.top,
                right = imeAndBars.right,
                bottom = imeAndBars.bottom,
            )
            hostDrawer.updatePadding(
                top = initialDrawerTop + systemBars.top,
                right = initialDrawerRight + systemBars.right,
                bottom = initialDrawerBottom + systemBars.bottom,
            )
            updateEdgeHandleVisibility()
            WindowInsetsCompat.CONSUMED
        }

        findViewById<RecyclerView>(R.id.drawerHostList).apply {
            layoutManager = LinearLayoutManager(this@SessionWebActivity)
            adapter = drawerAdapter
            itemAnimator = null
        }

        findViewById<MaterialButton>(R.id.switchCoverButton).setOnClickListener { openDrawer() }
        findViewById<MaterialButton>(R.id.drawerAddHostButton).setOnClickListener {
            drawerLayout.closeDrawer(GravityCompat.END)
            if (!deleting) startActivity(Intent(this, PairHostActivity::class.java))
        }
        findViewById<MaterialButton>(R.id.drawerAllHostsButton).setOnClickListener { finish() }
        findViewById<MaterialButton>(R.id.drawerCheckUpdateButton).setOnClickListener {
            HostActions.checkForUpdates(this, { checkingUpdate }, { checkingUpdate = it }, ::openInBrowser)
        }
        retry.setOnClickListener { if (revoked) pairAgain() else connect() }

        installEdgeHandleGesture()
        drawerLayout.addDrawerListener(object : DrawerLayout.SimpleDrawerListener() {
            override fun onDrawerOpened(drawerView: View) {
                WindowCompat.getInsetsController(window, drawerLayout).hide(WindowInsetsCompat.Type.ime())
                refreshDrawerHosts()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    drawerLayout.isDrawerOpen(GravityCompat.END) -> drawerLayout.closeDrawer(GravityCompat.END)
                    !cover.isVisible && web?.canGoBack() == true -> web?.goBack()
                    else -> finish()
                }
            }
        })
        connectivity?.let {
            observingNetwork = runCatching { it.registerDefaultNetworkCallback(networkListener) }.isSuccess
        }
        refreshDrawerHosts()
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
        refreshDrawerHosts()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installEdgeHandleGesture() {
        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        val swipeThreshold = dp(12)
        var downX = 0f
        var downY = 0f
        var triggered = false

        drawerEdgeHandle.setOnClickListener { openDrawer() }
        drawerEdgeHandle.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    triggered = false
                    view.parent?.requestDisallowInterceptTouchEvent(true)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = downX - event.rawX
                    val dy = abs(event.rawY - downY)
                    if (!triggered && dx > swipeThreshold && dx > dy) {
                        triggered = true
                        openDrawer()
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    view.parent?.requestDisallowInterceptTouchEvent(false)
                    if (!triggered && abs(downX - event.rawX) <= touchSlop && abs(downY - event.rawY) <= touchSlop) {
                        view.performClick()
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    view.parent?.requestDisallowInterceptTouchEvent(false)
                    true
                }
                else -> false
            }
        }
        contentContainer.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            updateGestureExclusion()
        }
    }

    private fun updateEdgeHandleVisibility() {
        drawerEdgeHandle.isVisible = !cover.isVisible && !imeVisible
        updateGestureExclusion()
    }

    private fun updateGestureExclusion() {
        val width = contentContainer.width
        val height = contentContainer.height
        if (width <= 0 || height <= 0 || !drawerEdgeHandle.isVisible) {
            ViewCompat.setSystemGestureExclusionRects(contentContainer, emptyList())
            return
        }
        val stripHeight = dp(192).coerceAtMost(height)
        val centerY = height / 2 + drawerEdgeHandle.translationY.toInt()
        val top = (centerY - stripHeight / 2).coerceIn(0, (height - stripHeight).coerceAtLeast(0))
        val rect = Rect(
            (width - dp(36)).coerceAtLeast(0),
            top,
            width,
            (top + stripHeight).coerceAtMost(height),
        )
        ViewCompat.setSystemGestureExclusionRects(contentContainer, listOf(rect))
    }

    private fun openDrawer() {
        WindowCompat.getInsetsController(window, drawerLayout).hide(WindowInsetsCompat.Type.ime())
        refreshDrawerHosts()
        drawerLayout.openDrawer(GravityCompat.END)
    }

    private fun isOnline() = connectivity?.activeNetwork != null

    private fun refreshDrawerHosts() {
        runCatching { store.list() }
            .onSuccess { hosts -> drawerAdapter.submitList(hosts); drawerAdapter.notifyDataSetChanged() }
    }

    private fun switchToHost(targetId: String) {
        drawerLayout.closeDrawer(GravityCompat.END)
        if (targetId == id && !revoked && !failed) return
        connection?.cancel()
        connection = null
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
        connect()
        refreshDrawerHosts()
    }

    private fun connect(forceRefresh: Boolean = false) {
        if (connection?.isActive == true || revoked || isFinishing) return
        authRecovery = SessionAuthRecovery.Ready
        failed = false
        closeWebView() // Discard callbacks and script activity from the previous connection attempt.
        showConnectingCover()
        connection = lifecycleScope.launch {
            try {
                if (!BrowserBoundary.supported()) return@launch showError(R.string.webview_unsupported, false)
                val stored = store.get(id) ?: return@launch showError(R.string.storage_error, false)
                val selected = Origin.parse(stored.profile.origin)?.takeIf(NetworkSecurityPolicy::allows)
                    ?: return@launch showError(R.string.private_http_only, false)
                origin = selected
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
            sessionState = SessionState.CONNECTED
            view.isVisible = true
            cover.isVisible = false
            updateEdgeHandleVisibility()
            refreshDrawerHosts()
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

    private fun showConnectingCover() {
        sessionState = SessionState.CONNECTING
        web?.isVisible = false
        cover.isVisible = true
        updateEdgeHandleVisibility()
        coverIconTile.setBackgroundResource(R.drawable.bg_emblem_tile)
        coverIcon.clearColorFilter()
        coverIcon.setImageResource(R.drawable.ic_codexhost_mark)
        coverProgress.isVisible = true
        coverTitle.setText(R.string.session_connecting)
        coverMessage.setText(R.string.connecting_subtitle)
        retry.isVisible = false
        refreshDrawerHosts()
    }

    private fun showError(text: Int, canRetry: Boolean = true) {
        failed = true
        sessionState = SessionState.ERROR
        closePopup()
        web?.stopLoading()
        web?.isVisible = false
        cover.isVisible = true
        updateEdgeHandleVisibility()
        coverIconTile.setBackgroundResource(R.drawable.bg_error_tile)
        coverIcon.setImageResource(R.drawable.ic_alert)
        coverIcon.setColorFilter(ContextCompat.getColor(this, R.color.error_red))
        coverProgress.isVisible = false
        coverTitle.setText(if (revoked) R.string.token_revoked_title else R.string.connection_failed_title)
        coverMessage.setText(text)
        retry.isVisible = canRetry
        refreshDrawerHosts()
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
            refreshDrawerHosts()
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
                        BrowserBoundary.deleteProfileData(profile.id)
                        store.delete(profile.id)
                        val remaining = store.list()
                        if (deletingCurrent) {
                            if (remaining.isEmpty()) finish() else switchToHost(remaining.first().id)
                        } else {
                            refreshDrawerHosts()
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
        connection?.cancel()
        if (observingNetwork) connectivity?.unregisterNetworkCallback(networkListener)
        closeWebView()
        runCatching { BrowserBoundary.block(proxyOwner, uiExecutor) }
        super.onDestroy()
    }

    private inner class DrawerHostRows : ListAdapter<HostProfile, DrawerHostRow>(object : DiffUtil.ItemCallback<HostProfile>() {
        override fun areItemsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem.id == newItem.id
        override fun areContentsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem == newItem
    }) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): DrawerHostRow {
            val view = LayoutInflater.from(parent.context).inflate(R.layout.item_drawer_host, parent, false)
            return DrawerHostRow(view)
        }

        override fun onBindViewHolder(holder: DrawerHostRow, position: Int) = holder.bind(getItem(position))
    }

    private inner class DrawerHostRow(view: View) : RecyclerView.ViewHolder(view) {
        private val card: MaterialCardView = view.findViewById(R.id.drawerHostCard)
        private val iconTile: FrameLayout = view.findViewById(R.id.drawerHostIconTile)
        private val hostIcon: ImageView = view.findViewById(R.id.drawerHostIcon)
        private val hostName: TextView = view.findViewById(R.id.drawerHostName)
        private val activeBadge: TextView = view.findViewById(R.id.drawerActiveBadge)
        private val hostAddress: TextView = view.findViewById(R.id.drawerHostAddress)
        private val statusDot: View = view.findViewById(R.id.drawerStatusDot)
        private val transportPill: TextView = view.findViewById(R.id.drawerTransportPill)
        private val moreButton: ImageButton = view.findViewById(R.id.drawerMoreButton)
        private var profile: HostProfile? = null

        init {
            card.setOnClickListener {
                if (!deleting) profile?.let { switchToHost(it.id) }
            }
            card.setOnLongClickListener {
                showRowMenu()
                true
            }
            moreButton.setOnClickListener { showRowMenu() }
        }

        private fun showRowMenu() {
            val current = profile ?: return
            PopupMenu(this@SessionWebActivity, moreButton).apply {
                menu.add(0, MENU_RENAME, 0, R.string.rename)
                menu.add(0, MENU_DELETE, 1, R.string.delete)
                setOnMenuItemClickListener { item ->
                    when (item.itemId) {
                        MENU_RENAME -> renameHost(current)
                        MENU_DELETE -> deleteHost(current)
                    }
                    true
                }
                show()
            }
        }

        fun bind(value: HostProfile) {
            profile = value
            val isActive = value.id == id
            hostName.text = value.name
            hostAddress.text = value.origin
            activeBadge.isVisible = isActive

            card.strokeWidth = dp(if (isActive) 2 else 1)
            card.strokeColor = ContextCompat.getColor(
                this@SessionWebActivity,
                if (isActive) R.color.brand_emerald else R.color.border_hairline,
            )

            statusDot.isVisible = isActive
            if (isActive) {
                val dotColor = when (sessionState) {
                    SessionState.CONNECTED -> R.color.status_connected
                    SessionState.CONNECTING -> R.color.status_connecting
                    SessionState.ERROR -> R.color.status_error
                }
                statusDot.backgroundTintList = ColorStateList.valueOf(
                    ContextCompat.getColor(this@SessionWebActivity, dotColor),
                )
            }

            val secure = Origin.parse(value.origin)?.secure == true
            val accent = ContextCompat.getColor(
                this@SessionWebActivity,
                if (secure) R.color.brand_emerald_text else R.color.warn_amber,
            )
            iconTile.setBackgroundResource(if (secure) R.drawable.bg_card_icon_secure else R.drawable.bg_card_icon_local)
            hostIcon.setColorFilter(accent)
            transportPill.setBackgroundResource(if (secure) R.drawable.bg_pill_secure else R.drawable.bg_pill_local)
            transportPill.setTextColor(accent)
            transportPill.setText(if (secure) R.string.session_status_https else R.string.session_status_lan)
        }
    }

    companion object {
        private const val EXTRA_ID = "hostId"
        private const val MENU_RENAME = 1
        private const val MENU_DELETE = 2
        fun intent(context: Context, id: String) = Intent(context, SessionWebActivity::class.java).putExtra(EXTRA_ID, id)
    }
}
