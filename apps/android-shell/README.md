# codexhost Android

A standalone Kotlin APK for switching between paired codexhost computers. It loads the selected computer’s live Web UI; it does not bundle a copy of the Web UI or require Google Play Services. CameraX and ZXing decode connection QR codes locally.

## Build and install

Requires JDK 17 and Android SDK Platform 35 / Build-Tools 35.0.0. From the repository root:

```sh
cd apps/android-shell
./gradlew testDebugUnitTest assembleDebug
```

Install `app/build/outputs/apk/debug/app-debug.apk` directly or download the `codexhost-android-debug` CI artifact. The app targets SDK 35 and requires Android 8.0 or newer. Its installed WebView provider must support AndroidX WebKit `PROXY_OVERRIDE`; without this capability the app refuses to open a session rather than using an unisolated WebView. When AndroidX WebKit `MULTI_PROFILE` is also available (Chromium 119+), each saved computer uses a dedicated WebView profile; on devices whose vendor WebView supports `PROXY_OVERRIDE` without `MULTI_PROFILE` (for example, HarmonyOS WebView based on Chromium 114), the app falls back to the default WebView profile and wipes default cookies and WebStorage whenever switching to another computer or deleting the active computer. When `DOCUMENT_START_SCRIPT` is supported, the shell also injects feature-detected ES2024/Web API compatibility shims (such as `AbortSignal.any` and `Promise.withResolvers`) scoped to the active origin so older vendor WebViews can boot the live Web UI. This does not require the Play Store; an up-to-date provider supplied by the device vendor also works.

The app version comes from the repository root `package.json`. Release builds read `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` to sign `app/build/outputs/apk/release/app-release.apk` (published on GitHub Releases as `codexhost-<version>-android.apk`). On cold start and on manual **Check for updates**, the app checks the latest stable GitHub Release, downloads the attached APK over trusted GitHub HTTPS hosts with progress and SHA-256 verification (when a release digest is present), and opens Android's package installer via `FileProvider` using `REQUEST_INSTALL_PACKAGES`. Upgrades that preserve app data require an APK with the same application ID and signing key.

Inside a session, the WebView runs full-bleed with zero swipe-gesture conflicts; the left Web sidebar footer exposes a **Switch computer** action via a minimal zero-credential JavaScript bridge (`__codexhostAndroidHostSwitcher`) that opens the native host-switcher bottom sheet (falling back to a slim top micro-pill when connected to an older Web server without the sidebar action).

## Pairing and security

- Scan the computer’s `<origin>#token=<secret>` QR code or enter its address and token manually. Native login sends `POST /api/auth/login` as JSON without redirects or an `Origin` header. The token never becomes a WebView URL. A successful response must include the expected host-only, HttpOnly sign-in cookie. `401` means the token is invalid; `429` prompts the user to wait.
- The device stores the name, origin, last visit and token in `EncryptedSharedPreferences` protected by an Android Keystore key. When the WebView supports `MULTI_PROFILE`, each saved origin has a dedicated WebView profile (cookies are normally host-scoped, not port-scoped) and deleting a computer removes its credential and clears its profile’s cookies. On WebViews without `MULTI_PROFILE`, the shell uses the default profile and clears default cookies and WebStorage whenever switching to another saved origin or deleting the active computer. If a cookie is missing or a loaded session returns `401`, the shell exchanges the saved token. A `401` received before the replacement page settles (five seconds after its first visible commit) stops the automatic reload instead of triggering a loop. A later `401` can trigger another exchange; if login rejects the token, the shell erases it and prompts for a new scan.
- HTTPS uses platform certificate verification. Unencrypted HTTP is also allowed for any valid origin (private or public) at the user’s discretion; the computer list and switcher clearly label HTTP connections as unencrypted (`Local network · Unencrypted HTTP` for private/loopback literals and `Unencrypted HTTP` otherwise). Prefer HTTPS on public networks.
- Android Network Security Config permits cleartext HTTP so both private and user-selected HTTP origins work. The native login client does not follow redirects; the GitHub update client uses only HTTPS. The WebView separately checks navigation and request URLs and waits for a Chromium proxy policy with exact scheme/host/port bypass rules for the approved origin and its WebSocket transport. Everything else is routed to a local listener that closes connections without forwarding; this also covers resource redirects and WebSockets that URL interception alone cannot enforce. External HTTP(S) links open in the system browser. Third-party embedded resources do not load inside the session.

## Device checks

JVM tests cover URL and token parsing, private/public transport classification, login requests and cookie/status handling, and profile serialization. On a device, verify CameraX scan and manual fallback, relaunch after cookie expiry and token rotation, switching between two origins, IME/gesture insets, browser handoff, reconnect, and photo/camera/file uploads. Test both an HTTPS connection and an HTTP connection; check that a foreign redirect or subresource never loads inside the shell.
