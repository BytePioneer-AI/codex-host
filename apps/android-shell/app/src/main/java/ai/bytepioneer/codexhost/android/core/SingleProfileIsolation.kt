package ai.bytepioneer.codexhost.android.core

internal interface SingleProfileOwnerStore {
    fun readOwner(): String?
    fun writeOwner(hostId: String?)
}

internal class SingleProfileIsolation(
    private val store: SingleProfileOwnerStore,
) {
    suspend fun prepareHost(hostId: String, clearDefaultProfile: suspend () -> Unit): Boolean {
        if (store.readOwner() == hostId) return false
        // Clear the recorded owner first so an interrupted wipe is retried on the next open.
        store.writeOwner(null)
        clearDefaultProfile()
        store.writeOwner(hostId)
        return true
    }

    suspend fun clearHostData(hostId: String, clearDefaultProfile: suspend () -> Unit): Boolean {
        val current = store.readOwner()
        if (current != null && current != hostId) return false
        store.writeOwner(null)
        clearDefaultProfile()
        return true
    }
}
