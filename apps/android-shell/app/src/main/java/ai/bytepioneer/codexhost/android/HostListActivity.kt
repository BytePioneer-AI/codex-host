package ai.bytepioneer.codexhost.android

import android.content.Intent
import android.os.Bundle
import android.text.InputFilter
import android.text.format.DateUtils
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import ai.bytepioneer.codexhost.android.core.HostProfile
import ai.bytepioneer.codexhost.android.core.Origin
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class HostListActivity : NativeActivity() {
    private val adapter = ComputerRows()
    private lateinit var empty: android.widget.TextView
    private var deleting = false
    private var checking = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val screen = screen()
        val header = column(16)
        header.addView(label(R.string.host_list, 28f))
        header.addView(button(R.string.add_host) {
            if (!deleting) startActivity(Intent(this, PairHostActivity::class.java))
        })
        header.addView(button(R.string.check_update, ::checkUpdates))
        screen.addView(header)
        empty = label(R.string.host_list_empty).apply { setPadding(dp(16), 0, dp(16), 0) }
        screen.addView(empty)
        screen.addView(RecyclerView(this).also {
            it.layoutManager = LinearLayoutManager(this)
            it.adapter = adapter
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        try {
            val hosts = store.list()
            adapter.submitList(hosts)
            empty.setText(R.string.host_list_empty)
            empty.isVisible = hosts.isEmpty()
        } catch (_: Exception) {
            adapter.submitList(emptyList())
            empty.setText(R.string.storage_error)
            empty.isVisible = true
        }
    }

    private fun rename(profile: HostProfile) {
        if (deleting) return
        val input = EditText(this).apply {
            hint = getString(R.string.host_name)
            filters = arrayOf(InputFilter.LengthFilter(80))
            setSingleLine()
            setText(profile.name)
            selectAll()
        }
        MaterialAlertDialogBuilder(this).setTitle(R.string.rename)
            .setView(column(12).apply { addView(input) })
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotBlank()) {
                    if (runCatching { store.rename(profile.id, name) }.isFailure) tell(R.string.storage_error)
                    refresh()
                }
            }.show()
    }

    private fun delete(profile: HostProfile) {
        if (deleting) return
        MaterialAlertDialogBuilder(this).setMessage(getString(R.string.delete_host_message, profile.name))
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
            }.show()
    }

    private fun checkUpdates() {
        if (checking) return
        checking = true
        tell(R.string.update_checking)
        lifecycleScope.launch {
            try {
                val installed = packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
                val update = withContext(Dispatchers.IO) { ReleaseUpdates.check(installed) }
                if (!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) return@launch
                if (update == null) {
                    tell(R.string.update_current)
                } else {
                    val apk = update.apkUrl
                    val dialog = MaterialAlertDialogBuilder(this@HostListActivity).setTitle(R.string.check_update)
                        .setNegativeButton(android.R.string.cancel, null)
                    if (apk == null) {
                        dialog.setMessage(getString(R.string.update_no_apk, update.version))
                            .setPositiveButton(R.string.view_release) { _, _ -> openInBrowser(update.releaseUrl) }
                    } else {
                        dialog.setMessage(getString(R.string.update_available, update.version))
                            .setPositiveButton(R.string.download_apk) { _, _ -> openInBrowser(apk) }
                    }
                    dialog.show()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                tell(R.string.update_failed)
            } finally {
                checking = false
            }
        }
    }

    private inner class ComputerRows : ListAdapter<HostProfile, ComputerRow>(object : DiffUtil.ItemCallback<HostProfile>() {
        override fun areItemsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem.id == newItem.id
        override fun areContentsTheSame(oldItem: HostProfile, newItem: HostProfile) = oldItem == newItem
    }) {
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = ComputerRow(column(16))
        override fun onBindViewHolder(holder: ComputerRow, position: Int) = holder.bind(getItem(position))
    }

    private inner class ComputerRow(private val row: LinearLayout) : RecyclerView.ViewHolder(row) {
        private val name = label(size = 21f)
        private val address = label()
        private val details = label(size = 14f)
        private var profile: HostProfile? = null

        init {
            row.addView(name)
            row.addView(address)
            row.addView(details)
            row.addView(LinearLayout(this@HostListActivity).apply {
                addView(button(R.string.open_host) {
                    if (!deleting) profile?.let { startActivity(SessionWebActivity.intent(this@HostListActivity, it.id)) }
                })
                addView(button(R.string.rename) { profile?.let(::rename) })
                addView(button(R.string.delete) { profile?.let(::delete) })
            })
        }

        fun bind(value: HostProfile) {
            profile = value
            name.text = value.name
            address.text = value.origin
            val transport = getString(if (Origin.parse(value.origin)?.secure == true) R.string.secure_label else R.string.private_cleartext_label)
            val last = value.lastOpenedAtMillis?.let {
                getString(R.string.last_opened, DateUtils.getRelativeTimeSpanString(it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS))
            } ?: getString(R.string.last_opened_never)
            details.text = "$transport\n$last"
        }
    }
}
