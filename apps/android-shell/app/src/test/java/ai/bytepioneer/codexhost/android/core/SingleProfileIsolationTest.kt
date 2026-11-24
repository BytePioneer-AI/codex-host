package ai.bytepioneer.codexhost.android.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SingleProfileIsolationTest {
    private class MemoryOwnerStore(var owner: String? = null) : SingleProfileOwnerStore {
        override fun readOwner(): String? = owner
        override fun writeOwner(hostId: String?) {
            owner = hostId
        }
    }

    @Test fun `first host preparation wipes default profile and records owner`() = runBlocking {
        val store = MemoryOwnerStore()
        val isolation = SingleProfileIsolation(store)
        var wipes = 0

        assertTrue(isolation.prepareHost("host-a") { wipes++ })
        assertEquals(1, wipes)
        assertEquals("host-a", store.owner)
    }

    @Test fun `reopening same host keeps existing default profile data`() = runBlocking {
        val store = MemoryOwnerStore(owner = "host-a")
        val isolation = SingleProfileIsolation(store)
        var wipes = 0

        assertFalse(isolation.prepareHost("host-a") { wipes++ })
        assertEquals(0, wipes)
        assertEquals("host-a", store.owner)
    }

    @Test fun `switching hosts wipes default profile before assigning new owner`() = runBlocking {
        val store = MemoryOwnerStore(owner = "host-a")
        val isolation = SingleProfileIsolation(store)
        val events = mutableListOf<String>()

        assertTrue(
            isolation.prepareHost("host-b") {
                events.add("owner-during-wipe=${store.owner}")
            },
        )
        assertEquals(listOf("owner-during-wipe=null"), events)
        assertEquals("host-b", store.owner)
    }

    @Test fun `failed wipe leaves owner unset so next open retries wiping`() = runBlocking {
        val store = MemoryOwnerStore(owner = "host-a")
        val isolation = SingleProfileIsolation(store)

        val failed = runCatching {
            isolation.prepareHost("host-b") {
                throw IllegalStateException("cookie store busy")
            }
        }
        assertTrue(failed.isFailure)
        assertNull(store.owner)

        var wipes = 0
        assertTrue(isolation.prepareHost("host-a") { wipes++ })
        assertEquals(1, wipes)
        assertEquals("host-a", store.owner)
    }

    @Test fun `deleting inactive host preserves active host data`() = runBlocking {
        val store = MemoryOwnerStore(owner = "host-b")
        val isolation = SingleProfileIsolation(store)
        var wipes = 0

        assertFalse(isolation.clearHostData("host-a") { wipes++ })
        assertEquals(0, wipes)
        assertEquals("host-b", store.owner)
    }

    @Test fun `deleting active host or unknown owner wipes default profile`() = runBlocking {
        val store = MemoryOwnerStore(owner = "host-a")
        val isolation = SingleProfileIsolation(store)
        var wipes = 0

        assertTrue(isolation.clearHostData("host-a") { wipes++ })
        assertEquals(1, wipes)
        assertNull(store.owner)

        assertTrue(isolation.clearHostData("host-b") { wipes++ })
        assertEquals(2, wipes)
        assertNull(store.owner)
    }
}
