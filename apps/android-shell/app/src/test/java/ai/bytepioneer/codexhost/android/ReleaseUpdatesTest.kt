package ai.bytepioneer.codexhost.android

import java.io.File
import java.security.MessageDigest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ReleaseUpdatesTest {
    @Test
    fun parsesReleaseDigestAndComparesVersions() {
        assertTrue(ReleaseUpdates.isNewer("v0.25.0", "0.24.0"))
        assertTrue(ReleaseUpdates.isNewer("v0.24.0", "0.24.0-rc.1"))
        assertFalse(ReleaseUpdates.isNewer("v0.24.0", "0.24.0"))
        assertFalse(ReleaseUpdates.isNewer("v0.23.9", "0.24.0"))

        val hex = "a".repeat(64)
        assertEquals(hex, ReleaseUpdates.parseSha256Digest("sha256:${hex.uppercase()}"))
        assertNull(ReleaseUpdates.parseSha256Digest("md5:1234"))
        assertNull(ReleaseUpdates.parseSha256Digest(null))
    }

    @Test
    fun restrictsApkDownloadsToTrustedGithubHttpsHosts() {
        assertTrue(ReleaseUpdates.isAllowedDownloadUrl("https://github.com/BytePioneer-AI/codex-host/releases/download/v0.25.0/codexhost-0.25.0-android.apk".toHttpUrl()))
        assertTrue(ReleaseUpdates.isAllowedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/123".toHttpUrl()))
        assertTrue(ReleaseUpdates.isAllowedDownloadUrl("https://release-assets.githubusercontent.com/asset.apk".toHttpUrl()))
        assertFalse(ReleaseUpdates.isAllowedDownloadUrl("http://github.com/a.apk".toHttpUrl()))
        assertFalse(ReleaseUpdates.isAllowedDownloadUrl("https://evil.example.com/a.apk".toHttpUrl()))
        assertFalse(ReleaseUpdates.isAllowedDownloadUrl("https://github.com:8443/a.apk".toHttpUrl()))
    }

    @Test
    fun checksLatestEndpointAndExtractsApkMetadata() {
        val digest = "0123456789abcdef".repeat(4)
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setBody(
                    """
                    {
                      "tag_name": "v0.25.0",
                      "assets": [
                        {
                          "name": "codexhost-0.25.0-android.apk",
                          "browser_download_url": "https://github.com/BytePioneer-AI/codex-host/releases/download/v0.25.0/codexhost-0.25.0-android.apk",
                          "digest": "sha256:$digest"
                        }
                      ]
                    }
                    """.trimIndent(),
                ),
            )
            val available = ReleaseUpdates.checkFromEndpoint(
                installed = "0.24.0",
                endpointUrl = server.url("/latest").toString(),
                client = OkHttpClient(),
            )
            assertNotNull(available)
            assertEquals("v0.25.0", available!!.version)
            assertEquals(digest, available.apkSha256)
            assertTrue(available.apkUrl!!.endsWith("codexhost-0.25.0-android.apk"))
        }
    }

    @Test
    fun downloadsApkVerifiesSha256AndRejectsCorruptedPayloads() {
        val payload = "codexhost-apk-payload-bytes".toByteArray()
        val expectedSha = MessageDigest.getInstance("SHA-256")
            .digest(payload)
            .joinToString("") { "%02x".format(it) }
        val tempDir = File(System.getProperty("java.io.tmpdir"), "codexhost-update-test-${System.nanoTime()}")
        try {
            MockWebServer().use { server ->
                server.enqueue(
                    MockResponse()
                        .setResponseCode(302)
                        .addHeader("Location", server.url("/cdn/app.apk").toString()),
                )
                server.enqueue(MockResponse().setBody(String(payload)))

                var lastDownloaded = 0L
                val target = File(tempDir, "codexhost-0.25.0.apk")
                val file = ReleaseUpdates.downloadApk(
                    url = server.url("/download/app.apk").toString(),
                    expectedSha256 = expectedSha,
                    destination = target,
                    onProgress = { downloaded, _ -> lastDownloaded = downloaded },
                    client = OkHttpClient.Builder().followRedirects(false).build(),
                    validateUrl = { true },
                )
                assertArrayEquals(payload, file.readBytes())
                assertEquals(payload.size.toLong(), lastDownloaded)

                server.enqueue(MockResponse().setBody("corrupted-bytes"))
                try {
                    ReleaseUpdates.downloadApk(
                        url = server.url("/download/bad.apk").toString(),
                        expectedSha256 = expectedSha,
                        destination = File(tempDir, "bad.apk"),
                        onProgress = { _, _ -> },
                        client = OkHttpClient.Builder().followRedirects(false).build(),
                        validateUrl = { true },
                    )
                    fail("Expected ChecksumMismatchException")
                } catch (_: ReleaseUpdates.ChecksumMismatchException) {
                    assertFalse(File(tempDir, "bad.apk").exists())
                }
            }
        } finally {
            tempDir.deleteRecursively()
        }
    }
}
