# Design

## Context

- 现有 Web 认证协议（`packages/web-server/src/auth.ts` 与 `request-trust.ts`）：
  - 电脑端连接二维码（`apps/web-ui/packages/client/ui-codexhost/src/client/ConnectionCard.tsx`）生成的链接格式为 `<origin>#token=<secret>`。
  - `POST /api/auth/login` 接受 JSON `{"token": "<secret>"}`；`RequestTrust.sameOrigin` 允许无 `Origin` 请求头或同源请求头访问，验证通过后返回 `200 {"ok": true}` 并通过 `Set-Cookie` 下发 `codexhost_token`（或 HTTPS 下 `__Host-codexhost_token`）；无效令牌返回 `401 {"error": {"code": "auth/invalid-token"}}`，触发限流返回 `429`。
- 移动端渲染与扩展：`packages/web-server/src/web-assets.ts` 运行时动态下发前端资源与用户启用的 Web UI 扩展。

## Decisions

- **纯 Kotlin + Jetpack 工程结构（`apps/android-shell/`）**：
  - 采用 Gradle Kotlin DSL（`minSdk = 26`、`targetSdk = 35`），无 GMS/Firebase 依赖；
  - 核心页面：主机列表（`HostListActivity` / Compose 或 RecyclerView + ViewBinding）、扫码配对（`ScannerActivity`，基于 CameraX + ZXing Core 解码）、会话容器（`WebSessionActivity`）。
- **配对与会话同步流程**：
  1. 解析二维码或手动输入链接中的 Origin（`scheme://host[:port]`）与 `#token=` 后的密钥（若未包含 `#token=` 则要求补输访问令牌）；
  2. 校验证书与网络安全边界：仅允许 `https://` 或经 `isPrivateOrLoopbackHost` 校验通过的局域网/Tailscale CGNAT 私网 `http://`（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`100.64.0.0/10`、`fc00::/7`、`fe80::/10`）；
  3. 原生 HTTP 客户端向 `<origin>/api/auth/login` 发送 `POST {"token": "..."}`，成功后提取响应 `Set-Cookie` 写入 Android `CookieManager`，并将主机元数据与令牌加密保存于 `EncryptedSharedPreferences`（基于 Android Keystore MasterKey）；
  4. 打开 `WebSessionActivity` 前先将持久凭据同步或重新交换为对应 Origin 的 WebView Cookie，再加载 `<origin>/`。遇到 `401` 或鉴权页退回时先尝试用已存令牌静默换取一次 Cookie，若 `/api/auth/login` 返回 `401` 则判定令牌已失效，清空该主机的有效状态并提示重新扫码。
- **推送与保活边界**：
  - 首版不集成 FCM/GMS，也不维护中心化中转推送网关；后续按需再评估独立可选的前台服务事件监听模式。
- **CI 构建工作流（`.github/workflows/android-apk.yml`）**：
  - 运行 JVM 单元测试（`./gradlew testDebugUnitTest`）与 APK 打包（`assembleDebug` / `assembleRelease`），供本地未安装 Android SDK 时的权威构建与发行产物生成。

## Risks / Trade-offs

- **不同本地环境可能缺少 Android SDK / Gradle** → 将纯链接解析、私网校验与主机模型设计为无 Android 依赖的纯 JVM 单元测试，并在 CI 工作流提供完整的 Gradle 构建环境；未配置统一发布签名密钥前，CI 产出未签名或调试签名 APK，正式签名配置后续在仓库 Secrets 补充。
