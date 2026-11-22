package ai.bytepioneer.codexhost.android

import android.text.InputFilter
import android.widget.LinearLayout
import ai.bytepioneer.codexhost.android.core.HostProfile
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

internal object HostActions {
    fun showRenameDialog(
        activity: NativeActivity,
        profile: HostProfile,
        onSave: (String) -> Unit,
    ) {
        val density = activity.resources.displayMetrics.density
        val dp = { value: Int -> (value * density + 0.5f).toInt() }
        val input = TextInputEditText(activity).apply {
            filters = arrayOf(InputFilter.LengthFilter(80))
            setSingleLine()
            setText(profile.name)
            selectAll()
        }
        val inputLayout = TextInputLayout(activity).apply {
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            val radius = dp(12).toFloat()
            setBoxCornerRadii(radius, radius, radius, radius)
            hint = activity.getString(R.string.host_name)
            addView(input)
        }
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(12), dp(20), 0)
            addView(inputLayout)
        }
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.rename)
            .setView(container)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val name = input.text?.toString()?.trim().orEmpty()
                if (name.isNotBlank()) onSave(name)
            }
            .show()
    }

    fun checkForUpdates(
        activity: NativeActivity,
        isBusy: () -> Boolean,
        setBusy: (Boolean) -> Unit,
        openUrl: (String) -> Unit,
    ) {
        ApkUpdater.checkManually(activity, isBusy, setBusy, openUrl)
    }
}
