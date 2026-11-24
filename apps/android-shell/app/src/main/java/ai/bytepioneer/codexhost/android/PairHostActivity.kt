package ai.bytepioneer.codexhost.android

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import ai.bytepioneer.codexhost.android.core.AuthResult
import ai.bytepioneer.codexhost.android.core.AuthSessionClient
import ai.bytepioneer.codexhost.android.core.PairingLink
import ai.bytepioneer.codexhost.android.core.PairingLinkParser
import com.google.android.material.button.MaterialButton
import com.google.android.material.progressindicator.CircularProgressIndicator
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class PairHostActivity : NativeActivity() {
    private lateinit var scanner: QrScanner
    private lateinit var scanPanel: LinearLayout
    private lateinit var manualPanel: ScrollView
    private lateinit var permissionOverlay: View
    private lateinit var statusBanner: View
    private lateinit var statusIcon: ImageView
    private lateinit var statusProgress: CircularProgressIndicator
    private lateinit var statusText: TextView
    private lateinit var scanTab: LinearLayout
    private lateinit var scanTabIcon: ImageView
    private lateinit var scanTabText: TextView
    private lateinit var manualTab: LinearLayout
    private lateinit var manualTabIcon: ImageView
    private lateinit var manualTabText: TextView
    private lateinit var verify: MaterialButton
    private lateinit var address: TextInputEditText
    private lateinit var token: TextInputEditText
    private var scanMode = true
    private var busy = false

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && scanMode) startCamera() else showTab(false)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_pair_host)

        val root = findViewById<View>(R.id.rootContainer)
        val topBar = findViewById<View>(R.id.topBar)
        installEdgeToEdge(root, topBar, root, includeIme = true)

        findViewById<ImageButton>(R.id.backButton).setOnClickListener { finish() }

        scanTab = findViewById(R.id.scanTab)
        scanTabIcon = findViewById(R.id.scanTabIcon)
        scanTabText = findViewById(R.id.scanTabText)
        manualTab = findViewById(R.id.manualTab)
        manualTabIcon = findViewById(R.id.manualTabIcon)
        manualTabText = findViewById(R.id.manualTabText)

        statusBanner = findViewById(R.id.statusBanner)
        statusIcon = findViewById(R.id.statusIcon)
        statusProgress = findViewById(R.id.statusProgress)
        statusText = findViewById(R.id.statusText)

        scanPanel = findViewById(R.id.scanPanel)
        manualPanel = findViewById(R.id.manualPanel)
        permissionOverlay = findViewById(R.id.permissionOverlay)

        val preview = findViewById<PreviewView>(R.id.cameraPreview).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        scanner = QrScanner(this, preview)

        findViewById<MaterialButton>(R.id.permitCameraButton).setOnClickListener {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
        findViewById<MaterialButton>(R.id.switchToManualButton).setOnClickListener {
            showTab(false)
        }

        address = findViewById<TextInputEditText>(R.id.addressInput).apply {
            imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            isSaveEnabled = false
            setText(intent.getStringExtra(EXTRA_ORIGIN).orEmpty())
        }
        token = findViewById<TextInputEditText>(R.id.tokenInput).apply {
            imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            isSaveEnabled = false
        }
        verify = findViewById<MaterialButton>(R.id.verifyButton).apply {
            setOnClickListener {
                submit(PairingLinkParser.parse(address.text?.toString().orEmpty(), token.text?.toString().orEmpty()))
            }
        }
        findViewById<View>(R.id.manualCardContent).requestFocus()

        scanTab.setOnClickListener {
            if (!busy) showTab(true)
        }
        manualTab.setOnClickListener {
            showTab(false)
        }

        val scan = savedInstanceState?.getBoolean(SCAN_MODE) ?: true
        showTab(scan)
        if (scan && savedInstanceState == null && !hasCameraPermission()) {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun hasCameraPermission() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun showTab(scan: Boolean) {
        scanMode = scan
        scanPanel.isVisible = scan
        manualPanel.isVisible = !scan
        updateTabStyles(scan)
        if (scan) {
            WindowCompat.getInsetsController(window, scanPanel).hide(WindowInsetsCompat.Type.ime())
            startCamera()
        } else {
            scanner.stop()
        }
    }

    private fun updateTabStyles(scan: Boolean) {
        val activeText = ContextCompat.getColor(this, R.color.text_primary)
        val inactiveText = ContextCompat.getColor(this, R.color.text_secondary)
        val activeWeight = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        val regularWeight = Typeface.create("sans-serif", Typeface.NORMAL)

        scanTab.setBackgroundResource(if (scan) R.drawable.bg_segment_active else 0)
        scanTabIcon.setColorFilter(if (scan) activeText else inactiveText)
        scanTabText.setTextColor(if (scan) activeText else inactiveText)
        scanTabText.typeface = if (scan) activeWeight else regularWeight

        manualTab.setBackgroundResource(if (!scan) R.drawable.bg_segment_active else 0)
        manualTabIcon.setColorFilter(if (!scan) activeText else inactiveText)
        manualTabText.setTextColor(if (!scan) activeText else inactiveText)
        manualTabText.typeface = if (!scan) activeWeight else regularWeight
    }

    private fun startCamera() {
        val permitted = hasCameraPermission()
        permissionOverlay.isVisible = !permitted
        if (permitted) {
            scanner.start({ text ->
                val link = PairingLinkParser.parse(text)
                showTab(false)
                if (link != null) {
                    address.setText(link.origin.address)
                    token.setText(link.token)
                }
                submit(link)
            }, {
                showTab(false)
                message(R.string.camera_unavailable)
            })
        }
    }

    private fun message(id: Int, inProgress: Boolean = false) {
        statusBanner.setBackgroundResource(if (inProgress) R.drawable.bg_banner_info else R.drawable.bg_banner_error)
        statusIcon.isVisible = !inProgress
        statusProgress.isVisible = inProgress
        statusText.setTextColor(
            ContextCompat.getColor(this, if (inProgress) R.color.brand_emerald_text else R.color.error_red),
        )
        statusText.setText(id)
        statusBanner.isVisible = true
    }

    private fun submit(link: PairingLink?) {
        if (busy) return
        if (link == null) return message(R.string.pair_invalid_link)
        if (!BrowserBoundary.supported()) return message(R.string.webview_unsupported)
        busy = true
        verify.isEnabled = false
        scanTab.isEnabled = false
        WindowCompat.getInsetsController(window, token).hide(WindowInsetsCompat.Type.ime())
        message(R.string.pair_connecting, inProgress = true)
        lifecycleScope.launch {
            try {
                when (val result = withContext(Dispatchers.IO) { AuthSessionClient().login(link.origin, link.token) }) {
                    is AuthResult.Authenticated -> {
                        val profile = store.profileFor(link.origin)
                        store.save(profile, link.token)
                        if (BrowserBoundary.supportsMultiProfile()) {
                            BrowserBoundary.initialize(uiExecutor)
                            if (!BrowserBoundary.setCookie(profile.id, link.origin, result.setCookie)) {
                                message(R.string.cookie_error)
                                return@launch
                            }
                        }
                        token.text?.clear()
                        address.text?.clear()
                        startActivity(SessionWebActivity.intent(this@PairHostActivity, profile.id))
                        finish()
                    }
                    AuthResult.TokenExpiredOrInvalid -> message(R.string.token_invalid)
                    AuthResult.RateLimited -> message(R.string.rate_limited)
                    AuthResult.Unavailable -> message(R.string.host_unreachable)
                    AuthResult.Rejected -> message(R.string.host_rejected)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                message(R.string.storage_error)
            } finally {
                busy = false
                verify.isEnabled = true
                scanTab.isEnabled = true
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(SCAN_MODE, scanMode)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        scanner.close()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ORIGIN = "origin"
        private const val SCAN_MODE = "scanMode"
    }
}
