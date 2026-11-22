package ai.bytepioneer.codexhost.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import com.google.android.material.button.MaterialButton

internal abstract class NativeActivity : AppCompatActivity() {
    protected val store by lazy { HostStore(this) }
    protected val uiExecutor by lazy { ContextCompat.getMainExecutor(this) }

    protected fun screen(includeIme: Boolean = false): LinearLayout {
        enableEdgeToEdge()
        val root = FrameLayout(this)
        val column = column()
        root.addView(column, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or
                if (includeIme) WindowInsetsCompat.Type.ime() else 0
            val safe = insets.getInsets(types)
            column.updateLayoutParams<FrameLayout.LayoutParams> {
                setMargins(safe.left, safe.top, safe.right, safe.bottom)
            }
            // The native container has applied these insets; do not let WebView apply them again.
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        return column
    }

    protected fun column(padding: Int = 0) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(padding), dp(padding), dp(padding), dp(padding))
    }

    protected fun label(textId: Int = 0, size: Float = 16f) = TextView(this).apply {
        textSize = size
        if (textId != 0) setText(textId)
    }

    protected fun button(textId: Int, action: () -> Unit) = MaterialButton(this).apply {
        setText(textId)
        setOnClickListener { action() }
    }

    protected fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    protected fun tell(text: Int) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    protected fun openInBrowser(rawUrl: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(rawUrl)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            tell(R.string.no_browser)
        }
    }
}
