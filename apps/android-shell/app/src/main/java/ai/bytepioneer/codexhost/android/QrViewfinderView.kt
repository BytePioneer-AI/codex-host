package ai.bytepioneer.codexhost.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import kotlin.math.min

internal class QrViewfinderView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val scrimColor = ContextCompat.getColor(context, R.color.scanner_scrim)
    private val density = resources.displayMetrics.density
    private val cornerRadius = 20f * density
    private val maxSize = 260f * density
    private val bracketLength = 22f * density

    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
        color = 0x38FFFFFF
    }

    private val bracketPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3.5f * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = ContextCompat.getColor(context, R.color.scanner_frame)
    }

    private val frameRect = RectF()
    private val cutoutPath = Path()
    private val cornerPath = Path()
    private val arcRect = RectF()

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return

        val side = min(min(width.toFloat(), height.toFloat()) * 0.66f, maxSize)
        val half = side / 2f
        val cx = width / 2f
        val cy = height / 2f
        frameRect.set(cx - half, cy - half, cx + half, cy + half)

        cutoutPath.reset()
        cutoutPath.addRoundRect(frameRect, cornerRadius, cornerRadius, Path.Direction.CW)

        canvas.save()
        canvas.clipOutPath(cutoutPath)
        canvas.drawColor(scrimColor)
        canvas.restore()

        canvas.drawRoundRect(frameRect, cornerRadius, cornerRadius, borderPaint)

        val d = cornerRadius * 2f
        val len = bracketLength

        // Top-left bracket
        cornerPath.reset()
        cornerPath.moveTo(frameRect.left, frameRect.top + cornerRadius + len)
        cornerPath.lineTo(frameRect.left, frameRect.top + cornerRadius)
        arcRect.set(frameRect.left, frameRect.top, frameRect.left + d, frameRect.top + d)
        cornerPath.arcTo(arcRect, 180f, 90f, false)
        cornerPath.lineTo(frameRect.left + cornerRadius + len, frameRect.top)
        canvas.drawPath(cornerPath, bracketPaint)

        // Top-right bracket
        cornerPath.reset()
        cornerPath.moveTo(frameRect.right - cornerRadius - len, frameRect.top)
        cornerPath.lineTo(frameRect.right - cornerRadius, frameRect.top)
        arcRect.set(frameRect.right - d, frameRect.top, frameRect.right, frameRect.top + d)
        cornerPath.arcTo(arcRect, 270f, 90f, false)
        cornerPath.lineTo(frameRect.right, frameRect.top + cornerRadius + len)
        canvas.drawPath(cornerPath, bracketPaint)

        // Bottom-right bracket
        cornerPath.reset()
        cornerPath.moveTo(frameRect.right, frameRect.bottom - cornerRadius - len)
        cornerPath.lineTo(frameRect.right, frameRect.bottom - cornerRadius)
        arcRect.set(frameRect.right - d, frameRect.bottom - d, frameRect.right, frameRect.bottom)
        cornerPath.arcTo(arcRect, 0f, 90f, false)
        cornerPath.lineTo(frameRect.right - cornerRadius - len, frameRect.bottom)
        canvas.drawPath(cornerPath, bracketPaint)

        // Bottom-left bracket
        cornerPath.reset()
        cornerPath.moveTo(frameRect.left + cornerRadius + len, frameRect.bottom)
        cornerPath.lineTo(frameRect.left + cornerRadius, frameRect.bottom)
        arcRect.set(frameRect.left, frameRect.bottom - d, frameRect.left + d, frameRect.bottom)
        cornerPath.arcTo(arcRect, 90f, 90f, false)
        cornerPath.lineTo(frameRect.left, frameRect.bottom - cornerRadius - len)
        canvas.drawPath(cornerPath, bracketPaint)
    }
}
