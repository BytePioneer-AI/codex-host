# Proposal

## Why

Android 手机通过浏览器使用 codexhost 会话 Web 时，面临多次查找登录链接、无法在多个电脑主机间快捷切换、地址栏遮挡/返回手势直退应用以及缺乏独立桌面图标等问题；同时，iOS 端由于开发者年费、审核周期与套壳限制，已明确保持 Safari PWA 路径，无需原生 iOS 封装。现在需要为 Android 提供免应用商店审核、轻量直装的原生 APK 壳。

## What Changes

- 新增独立 Android 原生工程（`apps/android-shell/`），作为多主机管理容器与受控全屏 WebView 外壳连接目标电脑的 `web-server`。
- 实现多台电脑连接配置管理、原生相机扫码配对（识别电脑端连接二维码中的来源与令牌，验证后加密存储会话凭据）、系统软键盘与安全区贴合、返回键路由、原生文件/图片选择、非同源外链转系统浏览器及断线重连卡片。
- 实现网络安全约束（允许 HTTPS 与局域网私网明文 HTTP，拒绝公网明文 HTTP）及基于 GitHub Releases 的应用内版本更新检查。
- 新增 Android APK 构建与单元测试 CI 工作流（`.github/workflows/android-apk.yml`），产出的 APK 随发行流程分发。

## Decisions

- **采用纯 Kotlin 原生容器，不采用 Capacitor**：原生逻辑仅包含主机列表、扫码页和受控 WebView 宿主，纯 Kotlin 安装包体积最小且对键盘 Insets、返回手势、文件上传与 Android Keystore 控制最直接。
- **动态加载目标电脑 `web-server`，不将 `apps/web-ui` 静态锁死在 APK 内**：保证不同电脑端版本与服务端动态加载的 Web UI 扩展天然兼容，电脑升级时无需强迫重装手机 APK。
- **不绑定 Google Play 服务（GMS）与中心化推送服务器**：使用不依赖 GMS 的扫码库，首期专注前台保活与断线重连，确保国内与无 GMS 设备开箱即用。

## Capabilities

### New Capabilities

- `android-companion-shell`: Android 轻量原生多主机壳的配对认证、受控 WebView 交互、网络安全策略、多机管理与应用更新检查。

## Impact

新增 `apps/android-shell/` 原生 Android 工程及 `.github/workflows/android-apk.yml`；不修改根目录 Rust/npm workspace 依赖，不改动现有 `packages/web-server` 认证协议，不新增 iOS 原生工程。
