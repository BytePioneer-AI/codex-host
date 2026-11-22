package ai.bytepioneer.codexhost.android.core

import org.junit.Assert.*
import org.junit.Test

class HostProfileTest {
    @Test fun `round trips metadata and credential without exposing the token in logs`() {
        val profile = HostProfile("host-1", "工作电脑 \"A\"", "https://desktop.example:4400", 1_700_000_000_000)
        val host = StoredHost(profile, "secret+\"value")
        val restored = StoredHost.deserialize(host.serialize())
        assertEquals(profile, restored.profile)
        assertEquals(host.token, restored.token)
        assertFalse(restored.toString().contains("secret"))
    }

    @Test fun `retains metadata when the token has been cleared`() {
        val profile = HostProfile("host-2", "Laptop", "http://100.64.0.2")
        val restored = StoredHost.deserialize(StoredHost(profile, null).serialize())
        assertEquals(profile, restored.profile)
        assertNull(restored.token)
    }
}
