package ai.bytepioneer.codexhost.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import ai.bytepioneer.codexhost.android.core.AuthResult
import ai.bytepioneer.codexhost.android.core.AuthSessionClient
import ai.bytepioneer.codexhost.android.core.NetworkSecurityPolicy
import ai.bytepioneer.codexhost.android.core.PairingLink
import ai.bytepioneer.codexhost.android.core.PairingLinkParser
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class PairHostActivity : NativeActivity() {
    private lateinit var scanner: QrScanner
    private lateinit var scanPanel: LinearLayout
    private lateinit var manualPanel: ScrollView
    private lateinit var permit: MaterialButton
    private lateinit var status: TextView
    private lateinit var tabs: MaterialButtonToggleGroup
    private lateinit var scanTab: MaterialButton
    private lateinit var manualTab: MaterialButton
    private lateinit var verify: MaterialButton
    private lateinit var address: EditText
    private lateinit var token: EditText
    private var busy = false
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && scanPanel.isVisible) startCamera() else tabs.check(manualTab.id)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val screen = screen(includeIme = true)
        screen.addView(label(R.string.pair_title, 28f).apply { setPadding(dp(16), dp(12), dp(16), dp(8)) })
        scanTab = tab(R.string.scan_tab)
        manualTab = tab(R.string.manual_tab)
        tabs = MaterialButtonToggleGroup(this).apply {
            isSingleSelection = true
            isSelectionRequired = true
            addView(scanTab)
            addView(manualTab)
        }
        screen.addView(tabs)
        status = label().apply { setPadding(dp(16), dp(8), dp(16), dp(8)); isVisible = false }
        screen.addView(status)

        val preview = PreviewView(this).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
        scanner = QrScanner(this, preview)
        permit = button(R.string.camera_permission) { cameraPermission.launch(Manifest.permission.CAMERA) }
        scanPanel = column(16).apply {
            addView(label(R.string.scan_description))
            addView(permit)
            addView(preview, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        screen.addView(scanPanel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        address = field(R.string.connection_link, InputType.TYPE_TEXT_VARIATION_URI)
        token = field(R.string.access_token, InputType.TYPE_TEXT_VARIATION_PASSWORD)
        address.setText(intent.getStringExtra(EXTRA_ORIGIN).orEmpty())
        verify = button(R.string.pair_action) { submit(PairingLinkParser.parse(address.text.toString(), token.text.toString())) }
        manualPanel = ScrollView(this).apply {
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            addView(column(16).apply {
                isFocusableInTouchMode = true
                addView(address)
                addView(token)
                addView(verify)
                requestFocus()
            })
        }
        screen.addView(manualPanel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        tabs.addOnButtonCheckedListener { _, id, checked -> if (checked) showTab(id == scanTab.id) }
        val scan = savedInstanceState?.getBoolean(SCAN_MODE) ?: true
        tabs.check(if (scan) scanTab.id else manualTab.id)
        if (scan && savedInstanceState == null && !hasCameraPermission()) {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun tab(textId: Int) = MaterialButton(this).apply { id = View.generateViewId(); setText(textId) }

    private fun field(hintId: Int, variation: Int) = EditText(this).apply {
        setHint(hintId)
        setSingleLine()
        inputType = InputType.TYPE_CLASS_TEXT or variation
        imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        isSaveEnabled = false
    }

    private fun hasCameraPermission() = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun showTab(scan: Boolean) {
        scanPanel.isVisible = scan
        manualPanel.isVisible = !scan
        if (scan) {
            WindowCompat.getInsetsController(window, scanPanel).hide(WindowInsetsCompat.Type.ime())
            startCamera()
        } else scanner.stop()
    }

    private fun startCamera() {
        permit.isVisible = !hasCameraPermission()
        if (hasCameraPermission()) scanner.start({ text ->
            val link = PairingLinkParser.parse(text)
            tabs.check(manualTab.id)
            if (link != null) {
                address.setText(link.origin.address)
                token.setText(link.token)
            }
            submit(link)
        }, {
            tabs.check(manualTab.id)
            message(R.string.camera_unavailable)
        })
    }

    private fun message(id: Int) {
        status.setText(id)
        status.isVisible = true
    }

    private fun submit(link: PairingLink?) {
        if (busy) return
        if (link == null) return message(R.string.pair_invalid_link)
        if (!NetworkSecurityPolicy.allows(link.origin)) return message(R.string.private_http_only)
        if (!BrowserBoundary.supported()) return message(R.string.webview_unsupported)
        busy = true
        verify.isEnabled = false
        scanTab.isEnabled = false
        WindowCompat.getInsetsController(window, token).hide(WindowInsetsCompat.Type.ime())
        message(R.string.pair_connecting)
        lifecycleScope.launch {
            try {
                when (val result = withContext(Dispatchers.IO) { AuthSessionClient().login(link.origin, link.token) }) {
                    is AuthResult.Authenticated -> {
                        val profile = store.profileFor(link.origin)
                        store.save(profile, link.token)
                        BrowserBoundary.initialize(uiExecutor)
                        if (!BrowserBoundary.setCookie(profile.id, link.origin, result.setCookie)) {
                            message(R.string.cookie_error)
                            return@launch
                        }
                        token.text.clear()
                        address.text.clear()
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
        outState.putBoolean(SCAN_MODE, scanPanel.isVisible)
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
