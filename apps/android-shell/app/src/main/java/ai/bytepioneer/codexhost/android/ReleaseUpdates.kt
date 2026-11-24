package ai.bytepioneer.codexhost.android

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

internal object ReleaseUpdates {
    private const val REPOSITORY = "/BytePioneer-AI/codex-host/releases"
    private const val LATEST_API_URL = "https://api.github.com/repos$REPOSITORY/latest"
    private const val MAX_APK_BYTES = 100L * 1024L * 1024L
    private const val MAX_REDIRECTS = 5

    private val allowedDownloadHosts = setOf(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
    )

    private val apiClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    private val downloadClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.MINUTES)
        .build()

    private val json = Json { ignoreUnknownKeys = true }
    private val stableTag = Regex("v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")
    private val sha256Pattern = Regex("sha256:([0-9a-fA-F]{64})")

    @Serializable
    private data class Asset(
        val name: String,
        val browser_download_url: String,
        val digest: String? = null,
    )

    @Serializable
    private data class Release(val tag_name: String, val assets: List<Asset> = emptyList())

    class Available(
        val version: String,
        val apkUrl: String?,
        val apkSha256: String?,
        val releaseUrl: String,
    )

    class ChecksumMismatchException : IOException("APK checksum verification failed")

    fun check(installed: String): Available? = checkFromEndpoint(installed, LATEST_API_URL)

    internal fun checkFromEndpoint(
        installed: String,
        endpointUrl: String,
        client: OkHttpClient = apiClient,
    ): Available? {
        val request = Request.Builder()
            .url(endpointUrl)
            .header("Accept", "application/vnd.github+json")
            .build()
        val release = client.newCall(request).execute().use { response ->
            if (response.code == 404) return null
            if (!response.isSuccessful) throw IOException("Release API unavailable (${response.code})")
            json.decodeFromString<Release>(response.peekBody(512 * 1024).string())
        }
        if (!isNewer(release.tag_name, installed)) return null
        val matchedAsset = release.assets.firstNotNullOfOrNull { asset ->
            val url = asset.browser_download_url.toHttpUrlOrNull() ?: return@firstNotNullOfOrNull null
            if (
                asset.name.endsWith(".apk", ignoreCase = true) &&
                url.isHttps &&
                url.host == "github.com" &&
                url.port == 443 &&
                url.username.isEmpty() &&
                url.password.isEmpty() &&
                url.encodedPath.startsWith("$REPOSITORY/download/") &&
                url.pathSegments.last() == asset.name
            ) {
                asset to url.toString()
            } else {
                null
            }
        }
        return Available(
            version = release.tag_name,
            apkUrl = matchedAsset?.second,
            apkSha256 = matchedAsset?.first?.digest?.let(::parseSha256Digest),
            releaseUrl = "https://github.com$REPOSITORY/tag/${release.tag_name}",
        )
    }

    internal fun downloadApk(
        url: String,
        expectedSha256: String?,
        destination: File,
        onProgress: (downloaded: Long, total: Long) -> Unit,
        client: OkHttpClient = downloadClient,
        validateUrl: (HttpUrl) -> Boolean = ::isAllowedDownloadUrl,
    ): File {
        var currentUrl = url.toHttpUrlOrNull() ?: throw IOException("Invalid APK URL")
        if (!validateUrl(currentUrl)) throw IOException("Untrusted APK download URL")

        var redirects = 0
        while (true) {
            val request = Request.Builder().url(currentUrl).build()
            client.newCall(request).execute().use { response ->
                if (response.code in setOf(301, 302, 303, 307, 308)) {
                    val location = response.header("Location")
                        ?: throw IOException("Redirect missing Location")
                    redirects += 1
                    if (redirects > MAX_REDIRECTS) throw IOException("Too many redirects")
                    val nextUrl = currentUrl.resolve(location)
                        ?: throw IOException("Invalid redirect URL")
                    if (!validateUrl(nextUrl)) throw IOException("Untrusted redirect host")
                    currentUrl = nextUrl
                    return@use
                }
                if (!response.isSuccessful) {
                    throw IOException("APK download failed (${response.code})")
                }
                val body = response.body ?: throw IOException("Empty APK response")
                val totalBytes = body.contentLength()
                if (totalBytes > MAX_APK_BYTES) throw IOException("APK exceeds maximum allowed size")

                destination.parentFile?.mkdirs()
                val tempFile = File(destination.parentFile, "${destination.name}.part")
                tempFile.delete()
                val digest = MessageDigest.getInstance("SHA-256")
                var downloaded = 0L
                try {
                    body.byteStream().use { input ->
                        FileOutputStream(tempFile).use { output ->
                            val buffer = ByteArray(16 * 1024)
                            while (true) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                downloaded += read
                                if (downloaded > MAX_APK_BYTES) {
                                    throw IOException("APK exceeds maximum allowed size")
                                }
                                digest.update(buffer, 0, read)
                                output.write(buffer, 0, read)
                                onProgress(downloaded, totalBytes)
                            }
                            output.flush()
                        }
                    }
                    if (expectedSha256 != null) {
                        val actual = digest.digest().joinToString("") { "%02x".format(it) }
                        if (!actual.equals(expectedSha256, ignoreCase = true)) {
                            throw ChecksumMismatchException()
                        }
                    }
                    if (destination.exists()) destination.delete()
                    if (!tempFile.renameTo(destination)) {
                        tempFile.copyTo(destination, overwrite = true)
                        tempFile.delete()
                    }
                    return destination
                } catch (error: Throwable) {
                    tempFile.delete()
                    throw error
                }
            }
        }
    }

    internal fun isAllowedDownloadUrl(url: HttpUrl): Boolean =
        url.isHttps &&
            url.port == 443 &&
            url.username.isEmpty() &&
            url.password.isEmpty() &&
            url.host.lowercase() in allowedDownloadHosts

    internal fun parseSha256Digest(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        return sha256Pattern.matchEntire(raw.trim())?.groupValues?.get(1)?.lowercase()
    }

    internal fun isNewer(latest: String, installed: String): Boolean {
        val next = stableTag.matchEntire(latest)?.groupValues?.drop(1)?.map(String::toBigInteger) ?: return false
        val current = stableTag.matchEntire(installed.substringBefore('-'))?.groupValues?.drop(1)
            ?.map(String::toBigInteger) ?: return false
        return next.zip(current).firstOrNull { (a, b) -> a != b }?.let { (a, b) -> a > b } ?: ('-' in installed)
    }
}
