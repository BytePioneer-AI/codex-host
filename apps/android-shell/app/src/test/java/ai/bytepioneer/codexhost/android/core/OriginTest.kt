package ai.bytepioneer.codexhost.android.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginTest {
    private val selected = Origin.parse("https://desktop.example:4400")!!

    @Test fun `allows local preview resources but not local documents`() {
        listOf(
            "data:image/png;base64,AA==",
            "blob:https://desktop.example:4400/550e8400-e29b-41d4-a716-446655440000",
        ).forEach { url ->
            assertTrue(url, selected.allowsWebRequest(url, isMainFrame = false))
            assertFalse(url, selected.allowsWebRequest(url, isMainFrame = true))
        }

        val lan = Origin.parse("http://192.168.0.10:4400")!!
        assertTrue(lan.allowsWebRequest("blob:http://192.168.0.10:4400/id", isMainFrame = false))
    }

    @Test fun `blocks opaque and foreign preview origins`() {
        listOf(
            "blob:null/id", "blob:blob:https://desktop.example:4400/id",
            "blob:http://desktop.example:4400/id", "blob:https://desktop.example/id",
            "blob:https://other.example:4400/id", "blob:https://desktop.example:4400@other.example/id",
            "file:///preview.png", "content://provider/preview.png",
        ).forEach { url -> assertFalse(url, selected.allowsWebRequest(url, isMainFrame = false)) }
    }

    @Test fun `regular requests still require exact origin for documents and resources`() {
        for (isMainFrame in listOf(false, true)) {
            assertTrue(selected.allowsWebRequest("https://desktop.example:4400/chat", isMainFrame))
            assertFalse(selected.allowsWebRequest("https://desktop.example/chat", isMainFrame))
        }
    }
}
