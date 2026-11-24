package ai.bytepioneer.codexhost.android

import android.Manifest
import android.app.Dialog
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.io.File

internal class AttachmentPicker(private val activity: NativeActivity, private val onError: () -> Unit) {
    private var result: ValueCallback<Array<Uri>>? = null
    private var dialog: Dialog? = null
    private var photo: Pair<File, Uri>? = null

    private val openOne = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        finish(listOfNotNull(uri))
    }
    private val openMany = activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), ::finish)
    private val pickOne = activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        finish(listOfNotNull(uri))
    }
    private val pickMany = activity.registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(), ::finish)
    private val takePhoto = activity.registerForActivityResult(object : ActivityResultContracts.TakePicture() {
        override fun createIntent(context: Context, input: Uri): Intent = super.createIntent(context, input)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            .apply { clipData = ClipData.newRawUri("photo", input) }
    }) { success ->
        val captured = photo
        photo = null
        if (success && captured != null && captured.first.length() > 0) {
            // Only this app-created URI may bypass the external picker grant check.
            deliver(arrayOf(captured.second))
        } else {
            captured?.first?.delete()
            deliver(null)
        }
    }
    private val permission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (result != null) {
            if (granted) launchCamera() else fail()
        }
    }

    fun choose(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams) {
        if (result != null || (params.mode != WebChromeClient.FileChooserParams.MODE_OPEN &&
                params.mode != WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)) {
            callback.onReceiveValue(null)
            return
        }
        result = callback
        val types = params.acceptTypes.flatMap { it.split(',') }.mapNotNull { raw ->
            val type = raw.trim().lowercase()
            when {
                type.startsWith('.') -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.drop(1))
                '/' in type -> type
                else -> null
            }
        }.distinct().ifEmpty { listOf("*/*") }.toTypedArray()
        val multiple = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val images = types.any { it == "*/*" || it == "image/*" || it == "image/jpeg" || it == "image/jpg" }
        if (images && params.isCaptureEnabled) return requestCamera()
        val actions = mutableListOf<Pair<Int, () -> Unit>>()
        // The photo picker returns any image format, so use SAF for narrow MIME filters.
        if (types.any { it == "image/*" || it == "*/*" }) {
            actions += R.string.choose_photo to {
                val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                if (multiple) pickMany.launch(request) else pickOne.launch(request)
            }
        }
        if (images) actions += R.string.take_photo to ::requestCamera
        actions += R.string.choose_file to { if (multiple) openMany.launch(types) else openOne.launch(types) }
        if (actions.size == 1) return runPicker(actions.single().second)
        dialog = MaterialAlertDialogBuilder(activity).setTitle(R.string.upload_title)
            .setItems(actions.map { activity.getString(it.first) }.toTypedArray()) { _, index ->
                dialog = null
                runPicker(actions[index].second)
            }
            .setOnCancelListener { deliver(null) }.show()
    }

    private fun requestCamera() = runPicker {
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchCamera()
        } else permission.launch(Manifest.permission.CAMERA)
    }

    private fun launchCamera() = runPicker {
        val directory = File(activity.cacheDir, "camera_uploads").apply { mkdirs() }
        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
        val output = File.createTempFile("upload-", ".jpg", directory)
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.upload", output)
            photo = output to uri
            takePhoto.launch(uri)
        } catch (error: Exception) {
            output.delete()
            throw error
        }
    }

    private fun runPicker(action: () -> Unit) {
        try {
            action()
        } catch (_: Exception) {
            fail()
        }
    }

    private fun finish(uris: List<Uri>) {
        val safe = uris.distinct().filter { uri ->
            uri.scheme == "content" && uri.authority != "${activity.packageName}.upload" &&
                activity.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
                PackageManager.PERMISSION_GRANTED
        }
        deliver(safe.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    private fun fail() {
        photo?.first?.delete()
        photo = null
        deliver(null)
        onError()
    }

    private fun deliver(uris: Array<Uri>?) {
        dialog = null
        val callback = result
        result = null
        callback?.onReceiveValue(uris)
    }

    fun close() {
        dialog?.dismiss()
        photo?.first?.delete()
        photo = null
        deliver(null)
    }
}
