package ai.bytepioneer.codexhost.android

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

internal object ReleaseUpdates {
    private const val REPOSITORY = "/BytePioneer-AI/codex-host/releases"
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(15, TimeUnit.SECONDS).build()
    private val json = Json { ignoreUnknownKeys = true }
    private val stableTag = Regex("v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")

    @Serializable
    private data class Asset(val name: String, val browser_download_url: String)

    @Serializable
    private data class Release(val tag_name: String, val assets: List<Asset> = emptyList())

    class Available(val version: String, val apkUrl: String?, val releaseUrl: String)

    fun check(installed: String): Available? {
        val request = Request.Builder().url("https://api.github.com/repos$REPOSITORY/latest")
            .header("Accept", "application/vnd.github+json").build()
        val release = client.newCall(request).execute().use { response ->
            if (response.code == 404) return null // No published release.
            if (!response.isSuccessful) throw IOException("Release API unavailable")
            json.decodeFromString<Release>(response.peekBody(512 * 1024).string())
        }
        if (!isNewer(release.tag_name, installed)) return null
        val apk = release.assets.firstNotNullOfOrNull { asset ->
            val url = asset.browser_download_url.toHttpUrlOrNull() ?: return@firstNotNullOfOrNull null
            url.takeIf {
                asset.name.endsWith(".apk", ignoreCase = true) && it.isHttps && it.host == "github.com" &&
                    it.port == 443 && it.username.isEmpty() && it.password.isEmpty() &&
                    it.encodedPath.startsWith("$REPOSITORY/download/") && it.pathSegments.last() == asset.name
            }?.toString()
        }
        return Available(release.tag_name, apk, "https://github.com$REPOSITORY/tag/${release.tag_name}")
    }

    private fun isNewer(latest: String, installed: String): Boolean {
        val next = stableTag.matchEntire(latest)?.groupValues?.drop(1)?.map(String::toBigInteger) ?: return false
        val current = stableTag.matchEntire(installed.substringBefore('-'))?.groupValues?.drop(1)
            ?.map(String::toBigInteger) ?: return false
        return next.zip(current).firstOrNull { (a, b) -> a != b }?.let { (a, b) -> a > b } ?: ('-' in installed)
    }
}
