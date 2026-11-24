package ai.bytepioneer.codexhost.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.LinearProgressIndicator
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal object ApkUpdater {
    private const val PREFS_NAME = "update_prefs"
    private const val KEY_DISMISSED_VERSION = "dismissed_version"
    private const val UPDATES_DIR = "apk_updates"

    private val startupChecked = AtomicBoolean(false)
    private var pendingInstallFile: File? = null
    private var pendingInstallVersion: String? = null

    fun checkOnStartup(activity: NativeActivity, openUrl: (String) -> Unit) {
        if (!startupChecked.compareAndSet(false, true)) return
        val prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        activity.lifecycleScope.launch {
            val update = runCatching {
                val installed = installedVersion(activity)
                withContext(Dispatchers.IO) { ReleaseUpdates.check(installed) }
            }.getOrNull() ?: return@launch
            if (update.apkUrl == null) return@launch
            if (prefs.getString(KEY_DISMISSED_VERSION, null) == update.version) return@launch
            if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@launch
            showUpdateDialog(activity, update, openUrl, recordDismiss = true)
        }
    }

    fun checkManually(
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
                val installed = installedVersion(activity)
                val update = withContext(Dispatchers.IO) { ReleaseUpdates.check(installed) }
                if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@launch
                if (update == null) {
                    activity.tell(R.string.update_current)
                } else {
                    showUpdateDialog(activity, update, openUrl, recordDismiss = false)
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

    fun resumePendingInstall(activity: NativeActivity) {
        val file = pendingInstallFile ?: return
        if (!file.isFile) {
            pendingInstallFile = null
            pendingInstallVersion = null
            return
        }
        if (activity.packageManager.canRequestPackageInstalls()) {
            pendingInstallFile = null
            pendingInstallVersion = null
            launchInstaller(activity, file)
        }
    }

    private fun showUpdateDialog(
        activity: NativeActivity,
        update: ReleaseUpdates.Available,
        openUrl: (String) -> Unit,
        recordDismiss: Boolean,
    ) {
        val apk = update.apkUrl
        val builder = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.update_title_available)
        if (apk == null) {
            builder
                .setMessage(activity.getString(R.string.update_no_apk, update.version))
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.view_release) { _, _ -> openUrl(update.releaseUrl) }
                .show()
            return
        }
        builder
            .setMessage(activity.getString(R.string.update_available, update.version))
            .setNegativeButton(R.string.update_later) { _, _ ->
                if (recordDismiss) {
                    activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit()
                        .putString(KEY_DISMISSED_VERSION, update.version)
                        .apply()
                }
            }
            .setPositiveButton(R.string.update_now) { _, _ ->
                downloadAndInstall(activity, update, openUrl)
            }
            .show()
    }

    private fun downloadAndInstall(
        activity: NativeActivity,
        update: ReleaseUpdates.Available,
        openUrl: (String) -> Unit,
    ) {
        val apkUrl = update.apkUrl ?: return
        val density = activity.resources.displayMetrics.density
        val dp = { value: Int -> (value * density + 0.5f).toInt() }
        val statusText = TextView(activity).apply {
            text = activity.getString(R.string.update_downloading, update.version)
            textSize = 14f
        }
        val progressBar = LinearProgressIndicator(activity).apply {
            isIndeterminate = true
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(14)
            }
        }
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(16), dp(24), dp(8))
            addView(statusText)
            addView(progressBar)
        }

        var job: Job? = null
        val dialog = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.update_title_available)
            .setView(container)
            .setCancelable(false)
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                job?.cancel()
            }
            .show()

        job = activity.lifecycleScope.launch {
            try {
                val safeVersion = update.version.replace(Regex("[^A-Za-z0-9._-]"), "_")
                val updatesDir = File(activity.cacheDir, UPDATES_DIR)
                val apkFile = withContext(Dispatchers.IO) {
                    updatesDir.listFiles()?.forEach { it.delete() }
                    val target = File(updatesDir, "codexhost-$safeVersion.apk")
                    var lastUiUpdateMs = 0L
                    ReleaseUpdates.downloadApk(
                        url = apkUrl,
                        expectedSha256 = update.apkSha256,
                        destination = target,
                        onProgress = { downloaded, total ->
                            val now = System.currentTimeMillis()
                            if (now - lastUiUpdateMs < 120 && downloaded < total) return@downloadApk
                            lastUiUpdateMs = now
                            activity.runOnUiThread {
                                if (!dialog.isShowing) return@runOnUiThread
                                val downloadedMb = downloaded / (1024.0 * 1024.0)
                                if (total > 0) {
                                    val percent = ((downloaded * 100L) / total).toInt().coerceIn(0, 100)
                                    val totalMb = total / (1024.0 * 1024.0)
                                    progressBar.isIndeterminate = false
                                    progressBar.setProgressCompat(percent, true)
                                    statusText.text = activity.getString(
                                        R.string.update_downloading_progress,
                                        percent,
                                        downloadedMb,
                                        totalMb,
                                    )
                                } else {
                                    progressBar.isIndeterminate = true
                                    statusText.text = activity.getString(
                                        R.string.update_downloading_bytes,
                                        downloadedMb,
                                    )
                                }
                            }
                        },
                    )
                }
                if (dialog.isShowing) dialog.dismiss()
                if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@launch
                installOrRequestPermission(activity, apkFile, update.version)
            } catch (cancelled: CancellationException) {
                if (dialog.isShowing) dialog.dismiss()
                throw cancelled
            } catch (checksum: ReleaseUpdates.ChecksumMismatchException) {
                if (dialog.isShowing) dialog.dismiss()
                activity.tell(R.string.update_verify_failed)
            } catch (_: Exception) {
                if (dialog.isShowing) dialog.dismiss()
                if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@launch
                MaterialAlertDialogBuilder(activity)
                    .setTitle(R.string.update_title_available)
                    .setMessage(R.string.update_download_failed)
                    .setNegativeButton(android.R.string.cancel, null)
                    .setNeutralButton(R.string.update_open_browser) { _, _ -> openUrl(apkUrl) }
                    .setPositiveButton(R.string.retry) { _, _ -> downloadAndInstall(activity, update, openUrl) }
                    .show()
            }
        }
    }

    private fun installOrRequestPermission(activity: NativeActivity, apkFile: File, version: String) {
        if (activity.packageManager.canRequestPackageInstalls()) {
            launchInstaller(activity, apkFile)
            return
        }
        pendingInstallFile = apkFile
        pendingInstallVersion = version
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.update_install_permission_title)
            .setMessage(activity.getString(R.string.update_install_permission_message, version))
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                pendingInstallFile = null
                pendingInstallVersion = null
            }
            .setPositiveButton(R.string.update_open_settings) { _, _ ->
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                )
                runCatching { activity.startActivity(intent) }
                    .onFailure { activity.tell(R.string.update_failed) }
            }
            .show()
    }

    private fun launchInstaller(activity: NativeActivity, apkFile: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.upload", apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { activity.startActivity(intent) }
            .onFailure { activity.tell(R.string.update_failed) }
    }

    private fun installedVersion(activity: NativeActivity): String =
        runCatching { activity.packageManager.getPackageInfo(activity.packageName, 0).versionName.orEmpty() }
            .getOrDefault("")
}
