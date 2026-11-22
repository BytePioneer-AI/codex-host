package ai.bytepioneer.codexhost.android

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import ai.bytepioneer.codexhost.android.core.HostProfile
import ai.bytepioneer.codexhost.android.core.Origin
import ai.bytepioneer.codexhost.android.core.StoredHost
import java.util.UUID

@Suppress("DEPRECATION") // EncryptedSharedPreferences is intentionally backed by a Keystore MasterKey.
internal class HostStore(context: Context) {
    private val entries = EncryptedSharedPreferences.create(
        context.applicationContext,
        "paired_computers",
        MasterKey.Builder(context.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private fun hosts() = entries.all.values.map { StoredHost.deserialize(it as String) }

    fun list(): List<HostProfile> = hosts().map { it.profile }.sortedByDescending { it.lastOpenedAtMillis }

    fun get(id: String): StoredHost? = entries.getString(id, null)?.let(StoredHost::deserialize)

    fun profileFor(origin: Origin): HostProfile =
        hosts().firstOrNull { it.profile.origin == origin.address }?.profile
            ?: HostProfile(UUID.randomUUID().toString(), origin.socketHost, origin.address)

    fun save(profile: HostProfile, token: String?) {
        check(entries.edit().putString(profile.id, StoredHost(profile, token).serialize()).commit())
    }

    fun rename(id: String, name: String) = edit(id) { it.profile.copy(name = name) }

    fun markOpened(id: String) = edit(id) { it.profile.copy(lastOpenedAtMillis = System.currentTimeMillis()) }

    private fun edit(id: String, change: (StoredHost) -> HostProfile) {
        val record = get(id) ?: return
        save(change(record), record.token)
    }

    fun clearToken(id: String) {
        get(id)?.let { save(it.profile, null) }
    }

    fun delete(id: String) {
        check(entries.edit().remove(id).commit())
    }
}
