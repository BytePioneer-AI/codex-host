package ai.bytepioneer.codexhost.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.view.View
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

internal abstract class NativeActivity : AppCompatActivity() {
    protected val store by lazy { HostStore(this) }
    protected val uiExecutor by lazy { ContextCompat.getMainExecutor(this) }

    protected fun installEdgeToEdge(
        root: View,
        topView: View,
        bottomView: View,
        includeIme: Boolean = false,
    ) {
        enableEdgeToEdge()
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        val initialRootLeft = root.paddingLeft
        val initialRootRight = root.paddingRight
        val initialTop = topView.paddingTop
        val initialBottom = bottomView.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or
                if (includeIme) WindowInsetsCompat.Type.ime() else 0
            val safe = insets.getInsets(types)
            root.updatePadding(
                left = initialRootLeft + safe.left,
                right = initialRootRight + safe.right,
            )
            topView.updatePadding(top = initialTop + safe.top)
            bottomView.updatePadding(bottom = initialBottom + safe.bottom)
            // The native container has applied these insets; do not let WebView apply them again.
            WindowInsetsCompat.CONSUMED
        }
    }

    protected fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    internal fun tell(text: Int) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    protected fun openInBrowser(rawUrl: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            tell(R.string.no_browser)
        }
    }
}
