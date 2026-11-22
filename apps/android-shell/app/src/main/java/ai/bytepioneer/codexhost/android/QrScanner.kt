package ai.bytepioneer.codexhost.android

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class QrScanner(private val owner: LifecycleOwner, private val view: PreviewView) {
    private val frames = Executors.newSingleThreadExecutor()
    private val main = ContextCompat.getMainExecutor(view.context)
    private var generation = 0
    private var unbind: (() -> Unit)? = null

    fun start(onCode: (String) -> Unit, onUnavailable: () -> Unit) {
        stop()
        val current = generation
        val future = ProcessCameraProvider.getInstance(view.context)
        future.addListener({
            if (current != generation) return@addListener
            val bound = runCatching {
                val provider = future.get()
                val preview = Preview.Builder().build().apply { surfaceProvider = view.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                val reader = QRCodeReader()
                val decoded = AtomicBoolean(false)
                analysis.setAnalyzer(frames) { image ->
                    try {
                        if (!decoded.get()) decode(reader, image)?.let { text ->
                            if (decoded.compareAndSet(false, true)) main.execute {
                                if (current == generation) onCode(text)
                            }
                        }
                    } finally {
                        image.close()
                    }
                }
                unbind = {
                    analysis.clearAnalyzer()
                    provider.unbind(preview, analysis)
                }
                val camera = if (provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                    CameraSelector.DEFAULT_BACK_CAMERA
                } else CameraSelector.DEFAULT_FRONT_CAMERA
                provider.bindToLifecycle(owner, camera, preview, analysis)
            }
            if (bound.isFailure) {
                stop()
                onUnavailable()
            }
        }, main)
    }

    fun stop() {
        generation++
        unbind?.invoke()
        unbind = null
    }

    fun close() {
        stop()
        frames.shutdown()
    }

    private fun decode(reader: QRCodeReader, image: ImageProxy): String? {
        val crop = image.cropRect
        val width = crop.width()
        val height = crop.height()
        val y = image.planes[0]
        val plane = y.buffer.duplicate()
        val pixels = ByteArray(width * height)
        for (row in 0 until height) {
            val offset = (row + crop.top) * y.rowStride + crop.left * y.pixelStride
            if (y.pixelStride == 1) {
                plane.position(offset)
                plane.get(pixels, row * width, width)
            } else {
                for (col in 0 until width) pixels[row * width + col] = plane.get(offset + col * y.pixelStride)
            }
        }
        val source = PlanarYUVLuminanceSource(pixels, width, height, 0, 0, width, height, false)
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: ReaderException) {
            null
        }
    }
}
