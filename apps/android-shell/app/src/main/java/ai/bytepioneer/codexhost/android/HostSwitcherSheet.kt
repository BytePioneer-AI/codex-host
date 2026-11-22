package ai.bytepioneer.codexhost.android

import android.content.res.ColorStateList
import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import ai.bytepioneer.codexhost.android.core.HostProfile
import ai.bytepioneer.codexhost.android.core.NetworkSecurityPolicy
import ai.bytepioneer.codexhost.android.core.Origin
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView

internal class HostSwitcherSheet(
    private val activity: NativeActivity,
    private val loadHosts: () -> List<HostProfile>,
    private val activeHostId: () -> String,
    private val statusColorRes: () -> Int,
    private val onSelect: (String) -> Unit,
    private val onRename: (HostProfile) -> Unit,
    private val onDelete: (HostProfile) -> Unit,
    private val onAddHost: () -> Unit,
    private val onAllHosts: () -> Unit,
    private val onCheckUpdates: () -> Unit,
) {
    private val contentView: View = LayoutInflater.from(activity).inflate(
        R.layout.sheet_host_switcher,
        FrameLayout(activity),
        false,
    )
    private val hostList: RecyclerView = contentView.findViewById(R.id.sheetHostList)
    private val adapter = HostRows()
    private val dialog = BottomSheetDialog(activity).apply {
        setContentView(contentView)
        window?.setBackgroundDrawableResource(android.R.color.transparent)
        setOnShowListener { dialogInterface ->
            val shown = dialogInterface as? BottomSheetDialog ?: return@setOnShowListener
            shown.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)?.let { sheet ->
                sheet.setBackgroundColor(Color.TRANSPARENT)
                BottomSheetBehavior.from(sheet).apply {
                    skipCollapsed = true
                    state = BottomSheetBehavior.STATE_EXPANDED
                }
            }
        }
    }

    val isShowing: Boolean
        get() = dialog.isShowing

    init {
        hostList.layoutManager = LinearLayoutManager(activity)
        hostList.adapter = adapter
        hostList.itemAnimator = null
        hostList.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                val maxHeight = (activity.resources.displayMetrics.heightPixels * 0.45f).toInt()
                if (maxHeight > 0 && hostList.height > maxHeight && hostList.layoutParams.height != maxHeight) {
                    hostList.layoutParams = hostList.layoutParams.apply { height = maxHeight }
                    hostList.requestLayout()
                    return false
                }
                return true
            }
        })
        contentView.findViewById<MaterialButton>(R.id.sheetCheckUpdateButton).setOnClickListener {
            onCheckUpdates()
        }
        contentView.findViewById<MaterialButton>(R.id.sheetAddHostButton).setOnClickListener {
            dismiss()
            onAddHost()
        }
        contentView.findViewById<MaterialButton>(R.id.sheetAllHostsButton).setOnClickListener {
            dismiss()
            onAllHosts()
        }
    }

    fun show() {
        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            .hide(WindowInsetsCompat.Type.ime())
        refresh()
        if (!dialog.isShowing && !activity.isFinishing && !activity.isDestroyed) {
            dialog.show()
        }
    }

    fun refresh() {
        val hosts = runCatching { loadHosts() }.getOrNull() ?: return
        if (hostList.layoutParams.height != ViewGroup.LayoutParams.WRAP_CONTENT) {
            hostList.layoutParams = hostList.layoutParams.apply {
                height = ViewGroup.LayoutParams.WRAP_CONTENT
            }
            hostList.requestLayout()
        }
        adapter.submitList(hosts)
        adapter.notifyDataSetChanged()
    }

    fun dismiss() {
        if (dialog.isShowing) {
            dialog.dismiss()
        }
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density + 0.5f).toInt()

    private inner class HostRows : ListAdapter<HostProfile, HostRow>(object : DiffUtil.ItemCallback<HostProfile>() {
        override fun areItemsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem.id == newItem.id
        override fun areContentsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem == newItem
    }) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): HostRow {
            val view = LayoutInflater.from(parent.context).inflate(R.layout.item_drawer_host, parent, false)
            return HostRow(view)
        }

        override fun onBindViewHolder(holder: HostRow, position: Int) = holder.bind(getItem(position))
    }

    private inner class HostRow(view: View) : RecyclerView.ViewHolder(view) {
        private val card: MaterialCardView = view.findViewById(R.id.drawerHostCard)
        private val iconTile: FrameLayout = view.findViewById(R.id.drawerHostIconTile)
        private val hostIcon: ImageView = view.findViewById(R.id.drawerHostIcon)
        private val hostName: TextView = view.findViewById(R.id.drawerHostName)
        private val activeBadge: TextView = view.findViewById(R.id.drawerActiveBadge)
        private val hostAddress: TextView = view.findViewById(R.id.drawerHostAddress)
        private val statusDot: View = view.findViewById(R.id.drawerStatusDot)
        private val transportPill: TextView = view.findViewById(R.id.drawerTransportPill)
        private val moreButton: ImageButton = view.findViewById(R.id.drawerMoreButton)
        private var profile: HostProfile? = null

        init {
            card.setOnClickListener {
                profile?.let { onSelect(it.id) }
            }
            card.setOnLongClickListener {
                showRowMenu()
                true
            }
            moreButton.setOnClickListener { showRowMenu() }
        }

        private fun showRowMenu() {
            val current = profile ?: return
            PopupMenu(activity, moreButton).apply {
                menu.add(0, MENU_RENAME, 0, R.string.rename)
                menu.add(0, MENU_DELETE, 1, R.string.delete)
                setOnMenuItemClickListener { item ->
                    when (item.itemId) {
                        MENU_RENAME -> onRename(current)
                        MENU_DELETE -> onDelete(current)
                    }
                    true
                }
                show()
            }
        }

        fun bind(value: HostProfile) {
            profile = value
            val isActive = value.id == activeHostId()
            hostName.text = value.name
            hostAddress.text = value.origin
            activeBadge.isVisible = isActive

            card.strokeWidth = dp(if (isActive) 2 else 1)
            card.strokeColor = ContextCompat.getColor(
                activity,
                if (isActive) R.color.brand_emerald else R.color.border_hairline,
            )

            statusDot.isVisible = isActive
            if (isActive) {
                statusDot.backgroundTintList = ColorStateList.valueOf(
                    ContextCompat.getColor(activity, statusColorRes()),
                )
            }

            val parsedOrigin = Origin.parse(value.origin)
            val secure = parsedOrigin?.secure == true
            val privateCleartext = parsedOrigin != null && !secure && NetworkSecurityPolicy.isPrivateOrLoopback(parsedOrigin)
            val accent = ContextCompat.getColor(
                activity,
                if (secure) R.color.brand_emerald_text else R.color.warn_amber,
            )
            iconTile.setBackgroundResource(if (secure) R.drawable.bg_card_icon_secure else R.drawable.bg_card_icon_local)
            hostIcon.setColorFilter(accent)
            transportPill.setBackgroundResource(if (secure) R.drawable.bg_pill_secure else R.drawable.bg_pill_local)
            transportPill.setTextColor(accent)
            transportPill.setText(
                when {
                    secure -> R.string.session_status_https
                    privateCleartext -> R.string.session_status_lan
                    else -> R.string.session_status_http
                },
            )
        }
    }

    private companion object {
        private const val MENU_RENAME = 1
        private const val MENU_DELETE = 2
    }
}
