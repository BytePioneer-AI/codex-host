package ai.bytepioneer.codexhost.android

import android.content.Intent
import android.os.Bundle
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import ai.bytepioneer.codexhost.android.core.HostProfile
import ai.bytepioneer.codexhost.android.core.NetworkSecurityPolicy
import ai.bytepioneer.codexhost.android.core.Origin
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal class HostListActivity : NativeActivity() {
    private val adapter = ComputerRows()
    private lateinit var subtitleText: TextView
    private lateinit var errorBanner: View
    private lateinit var errorBannerText: TextView
    private lateinit var emptyContainer: View
    private lateinit var recyclerView: RecyclerView
    private lateinit var bottomCtaContainer: View
    private var deleting = false
    private var checking = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_host_list)

        val root = findViewById<View>(R.id.rootContainer)
        val topBar = findViewById<View>(R.id.topBar)
        installEdgeToEdge(root, topBar, root)

        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName.orEmpty() }
            .getOrDefault("")
        findViewById<TextView>(R.id.versionBadge).apply {
            isVisible = version.isNotBlank()
            text = getString(R.string.version_label, version)
        }

        subtitleText = findViewById(R.id.subtitleText)
        errorBanner = findViewById(R.id.errorBanner)
        errorBannerText = findViewById(R.id.errorBannerText)
        emptyContainer = findViewById(R.id.emptyContainer)
        bottomCtaContainer = findViewById(R.id.bottomCtaContainer)

        recyclerView = findViewById<RecyclerView>(R.id.hostRecyclerView).apply {
            layoutManager = LinearLayoutManager(this@HostListActivity)
            adapter = this@HostListActivity.adapter
        }

        val openPair = { if (!deleting) startActivity(Intent(this, PairHostActivity::class.java)) }
        findViewById<MaterialButton>(R.id.emptyAddButton).setOnClickListener { openPair() }
        findViewById<MaterialButton>(R.id.addHostButton).setOnClickListener { openPair() }
        findViewById<MaterialButton>(R.id.checkUpdateButton).setOnClickListener {
            HostActions.checkForUpdates(this, { checking }, { checking = it }, ::openInBrowser)
        }
        ApkUpdater.checkOnStartup(this, ::openInBrowser)
    }

    override fun onResume() {
        super.onResume()
        refresh()
        ApkUpdater.resumePendingInstall(this)
    }

    private fun refresh() {
        try {
            val hosts = store.list()
            adapter.submitList(hosts)
            errorBanner.isVisible = false
            val isEmpty = hosts.isEmpty()
            emptyContainer.isVisible = isEmpty
            recyclerView.isVisible = !isEmpty
            bottomCtaContainer.isVisible = !isEmpty
            subtitleText.isVisible = !isEmpty
        } catch (_: Exception) {
            adapter.submitList(emptyList())
            emptyContainer.isVisible = false
            recyclerView.isVisible = false
            bottomCtaContainer.isVisible = false
            subtitleText.isVisible = false
            errorBannerText.setText(R.string.storage_error)
            errorBanner.isVisible = true
        }
    }

    private fun rename(profile: HostProfile) {
        if (deleting) return
        HostActions.showRenameDialog(this, profile) { name ->
            if (runCatching { store.rename(profile.id, name) }.isFailure) tell(R.string.storage_error)
            refresh()
        }
    }

    private fun delete(profile: HostProfile) {
        if (deleting) return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.delete)
            .setMessage(getString(R.string.delete_host_message, profile.name))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                deleting = true
                lifecycleScope.launch {
                    try {
                        if (!BrowserBoundary.supported()) {
                            tell(R.string.webview_unsupported)
                            return@launch
                        }
                        BrowserBoundary.initialize(uiExecutor)
                        BrowserBoundary.deleteProfileData(profile.id)
                        store.delete(profile.id)
                        refresh()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        tell(R.string.storage_error)
                    } finally {
                        deleting = false
                    }
                }
            }
            .show()
    }

    private inner class ComputerRows : ListAdapter<HostProfile, ComputerRow>(object : DiffUtil.ItemCallback<HostProfile>() {
        override fun areItemsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem.id == newItem.id
        override fun areContentsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem == newItem
    }) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ComputerRow {
            val view = LayoutInflater.from(parent.context).inflate(R.layout.item_host_card, parent, false)
            return ComputerRow(view)
        }

        override fun onBindViewHolder(holder: ComputerRow, position: Int) = holder.bind(getItem(position))
    }

    private inner class ComputerRow(view: View) : RecyclerView.ViewHolder(view) {
        private val card: MaterialCardView = view.findViewById(R.id.hostCard)
        private val iconTile: FrameLayout = view.findViewById(R.id.hostIconTile)
        private val hostIcon: ImageView = view.findViewById(R.id.hostIcon)
        private val name: TextView = view.findViewById(R.id.hostName)
        private val address: TextView = view.findViewById(R.id.hostAddress)
        private val transportBadge: LinearLayout = view.findViewById(R.id.transportBadge)
        private val transportIcon: ImageView = view.findViewById(R.id.transportIcon)
        private val transportText: TextView = view.findViewById(R.id.transportText)
        private val lastOpenedText: TextView = view.findViewById(R.id.lastOpenedText)
        private val moreButton: ImageButton = view.findViewById(R.id.moreButton)
        private var profile: HostProfile? = null

        init {
            card.setOnClickListener {
                if (!deleting) profile?.let { startActivity(SessionWebActivity.intent(this@HostListActivity, it.id)) }
            }
            card.setOnLongClickListener {
                showRowMenu()
                true
            }
            moreButton.setOnClickListener { showRowMenu() }
        }

        private fun showRowMenu() {
            val current = profile ?: return
            PopupMenu(this@HostListActivity, moreButton).apply {
                menu.add(0, MENU_RENAME, 0, R.string.rename)
                menu.add(0, MENU_DELETE, 1, R.string.delete)
                setOnMenuItemClickListener { item ->
                    when (item.itemId) {
                        MENU_RENAME -> rename(current)
                        MENU_DELETE -> delete(current)
                    }
                    true
                }
                show()
            }
        }

        fun bind(value: HostProfile) {
            profile = value
            name.text = value.name
            address.text = value.origin

            val parsedOrigin = Origin.parse(value.origin)
            val secure = parsedOrigin?.secure == true
            val privateCleartext = parsedOrigin != null && !secure && NetworkSecurityPolicy.isPrivateOrLoopback(parsedOrigin)
            val accent = ContextCompat.getColor(
                this@HostListActivity,
                if (secure) R.color.brand_emerald_text else R.color.warn_amber,
            )
            iconTile.setBackgroundResource(if (secure) R.drawable.bg_card_icon_secure else R.drawable.bg_card_icon_local)
            hostIcon.setColorFilter(accent)
            transportBadge.setBackgroundResource(if (secure) R.drawable.bg_pill_secure else R.drawable.bg_pill_local)
            transportIcon.setImageResource(if (secure) R.drawable.ic_lock else R.drawable.ic_wifi)
            transportIcon.setColorFilter(accent)
            transportText.setTextColor(accent)
            transportText.setText(
                when {
                    secure -> R.string.secure_label
                    privateCleartext -> R.string.private_cleartext_label
                    else -> R.string.cleartext_label
                },
            )

            lastOpenedText.text = value.lastOpenedAtMillis?.let {
                getString(
                    R.string.last_opened,
                    DateUtils.getRelativeTimeSpanString(it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS),
                )
            } ?: getString(R.string.last_opened_never)
        }
    }

    private companion object {
        private const val MENU_RENAME = 1
        private const val MENU_DELETE = 2
    }
}
