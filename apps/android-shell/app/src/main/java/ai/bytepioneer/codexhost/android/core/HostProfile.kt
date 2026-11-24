package ai.bytepioneer.codexhost.android.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
internal data class HostProfile(
    val id: String,
    val name: String,
    val origin: String,
    val lastOpenedAtMillis: Long? = null,
)

@Serializable
internal class StoredHost(val profile: HostProfile, val token: String?) {
    fun serialize(): String = Json.encodeToString(this)

    companion object {
        fun deserialize(text: String): StoredHost = Json.decodeFromString(text)
    }
}
