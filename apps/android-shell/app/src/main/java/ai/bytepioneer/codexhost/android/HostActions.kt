package ai.bytepioneer.codexhost.android

import android.text.InputFilter
import android.widget.LinearLayout
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import ai.bytepioneer.codexhost.android.core.HostProfile
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
        if (isBusy()) return
        setBusy(true)
        activity.tell(R.string.update_checking)
        activity.lifecycleScope.launch {
            try {
                val installed = activity.packageManager.getPackageInfo(activity.packageName, 0).versionName.orEmpty()
                val update = withContext(Dispatchers.IO) { ReleaseUpdates.check(installed) }
                if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@launch
                if (update == null) {
                    activity.tell(R.string.update_current)
                } else {
                    val apk = update.apkUrl
                    val dialog = MaterialAlertDialogBuilder(activity)
                        .setTitle(R.string.check_update)
                        .setNegativeButton(android.R.string.cancel, null)
                    if (apk == null) {
                        dialog.setMessage(activity.getString(R.string.update_no_apk, update.version))
                            .setPositiveButton(R.string.view_release) { _, _ -> openUrl(update.releaseUrl) }
                    } else {
                        dialog.setMessage(activity.getString(R.string.update_available, update.version))
                            .setPositiveButton(R.string.download_apk) { _, _ -> openUrl(apk) }
                    }
                    dialog.show()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                activity.tell(R.string.update_failed)
            } finally {
                setBusy(false)
            }
        }
    }
}
