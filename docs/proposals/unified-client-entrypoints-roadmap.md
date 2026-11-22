# 统一客户端入口、桌面原生壳与 Android 客户端路线图

> 状态：待评估路线图与架构方案（尚未实施，不代表当前能力）。方案确认后，各阶段将拆分为独立 OpenSpec 变更逐项实施。

本文评估如何收口当前分散在 Codex Desktop、本地控制台、浏览器 Web 与移动端之间的用户入口，并将 Web 端演进为**单安装包整合的自有桌面原生壳**与**独立分发的 Android 轻量原生 APK 壳**，同时明确 iOS 保持 PWA 路径与各阶段的工程边界。

---

## 1. 背景与问题诊断

### 1.1 四层入口碎片化与用户心智负担

随能力演进，codexhost 面向终端用户的交互表面已分化为四个独立入口（见 [独立 Web 应用](../product/standalone-web.md)、[codexhost 控制台](../operations/codexhost-console.md)、[Web 远程访问](../product/web-remote-access.md)）：

| 入口 | 端口 / 载体 | 当前职责与行为 | 用户困惑点 |
| --- | --- | --- | --- |
| **Codex Desktop 注入版** | 官方桌面窗口（CDP / Inspector 注入） | 宿主内聊天与交互主界面；安装包双击启动时同步拉起 4399 控制台与后台 4400 Web | 启动单一桌面应用却同时弹出浏览器页面并在后台开启多个服务，难以理解彼此关系 |
| **本地 Console** | `http://127.0.0.1:4399/`（免登录本机网页） | 启动诊断、更新、扩展急救及不依赖 Desktop 的部分设置 | 无法用于聊天；与 Web 设置大量重叠，却占用了独立端口与日常开机弹窗入口 |
| **独立会话 Web** | `http://127.0.0.1:4400/`（需令牌认证） | 低内存浏览器聊天界面、会话导入、会话树、壁纸等扩展能力 | 非桌面原生窗口，容易被浏览器标签页淹没并受快捷键冲突影响；缺少原生桌面入口感 |
| **移动端 Web / PWA** | 复用 `:4400` 响应式页面 | 通过局域网、Tailscale、Relay 等方式远程访问本机 Agent | 需要依次完成网络方式选择、HTTPS/Relay 配置、扫码、手动「添加到主屏幕」及开启推送的多步漏斗 |

### 1.2 能力不对称与工程术语泄露

当前实现还存在两类影响普通用户理解的问题：

1. **能力分布跨端不对称**：
   - 外观偏好仅保留在 Codex Desktop 设置页；
   - 本地会话导入引导前往会话 Web（Console 明确提示不在自身提供重复入口）；
   - 启动故障排障与禁用损坏扩展在 Console (`:4399`)；
   - SSH 远程主机配置依赖 Codex Desktop 进程运行；
   - 完全停止后台服务、查看运行状态仍需在终端执行 `codexhost stop` / `codexhost status`。
2. **内部架构概念暴露到界面层**：用户被迫在界面与使用引导中区分 `Host`、`Desktop`、`Web`、`Console`、`Launcher`、`Relay` 与 `Tailscale` 等工程概念，而不是只面对“一个本机应用 + 一个手机端”。

### 1.3 为什么桌面端不能拆分为两个独立安装包

将“自有桌面端（封装 Web 端）”与“Codex Desktop 增强版”作为两个独立安装包发布，会直接与共享后台及更新架构产生结构性冲突：

1. **95% 运行时资产重复**：两种形态共用内置 Node、共享 `AppServerHost`、预装 Harness 插件集合（见 [插件发行清单](../../scripts/release/harness-plugins.json)）、Mapping Store、Web 服务、Relay 客户端与原生更新器。拆包会导致用户安装并维护两份几乎相同的完整运行时。
2. **后台生命周期锁与存储锁冲突**：同一数据目录使用 `shared-host-lifecycle.lock` 串行管理 Host 生命周期，Mapping Store 使用 `store.lock` 独占写入（见 [GUI/Web 会话所有权架构概览](../architecture/gui-web-shared-state-design.md)）。同时，`crates/launcher/src/services.rs` 会检测运行中 Host 与当前可执行入口及版本是否一致，而 `crates/updater` 明确拒绝跨安装接管服务。若存在两份安装且版本稍有错配，后启动的一方会直接替换并中断另一方正在运行的 Turn。
3. **下载与选择成本前置**：在 GitHub Releases 同时提供两套桌面安装器会让新用户在安装前即陷入困惑。

因此，**电脑端必须保持单一安装包与单一共享后台**，在应用层收敛入口关系。

---

## 2. 目标端形态与入口收口蓝图

收口目标为**“用户只需认识一个产品、每台设备对应一个主入口”**：

```text
电脑端：单一安装包（codexhost）
  ├── 唯一共享后台：AppServerHost + web-server + 预装 Harness 插件
  ├── 系统托盘常驻总控：窗口唤起 / 模式切换 / 手机扫码 / 检查更新 / 诊断入口 / 完全退出
  ├── 主界面形态 A（自有桌面窗口）：系统 WebView 薄壳加载本机 web-server（低内存、不依赖官方客户端）
  └── 主界面形态 B（Codex Desktop 增强版）：保留现有官方桌面窗口与 CDP 注入路径
        └── A 与 B 可分别打开或同时开启，共用同一后台、Mapping Store 与官方 Codex 会话
  └── 本地 Console（:4399）：退居幕后，仅在启动/注入持续失败或用户从托盘点击「诊断与日志」时打开

移动端：差异化轻量策略
  ├── Android：轻量原生 APK 壳（GitHub Releases 分发，零商店费用与审核周期）
  └── iOS：保持 Safari「添加到主屏幕」PWA 独立窗口（不做原生 iOS App）

纯浏览器 Web：回归无 GUI 服务器、临时设备访问及 iOS PWA 载体
```

| 设备 / 场景 | 目标主入口 | 定位与边界 |
| --- | --- | --- |
| **桌面电脑（日常使用）** | 单一 `codexhost` 安装包（托盘 + 默认窗口） | 由用户首次选择或后续随时切换默认窗口形态（自有桌面窗口 / Codex Desktop 增强版） |
| **本地排障（主窗口不可用时）** | 本地 Console (`127.0.0.1:4399`) | 保留“不依赖主界面或 Codex Desktop 即可诊断启动阶段并执行更新”的独立救生舱职责（延续 [独立 Web 控制台方案](独立%20Web%20控制台方案.md) 设计底线） |
| **Android 手机** | `codexhost` Android 轻量 APK 壳 | 原生多主机管理、扫码配对、安全区键盘贴合与受控 WebView；电脑端提供下载二维码 |
| **iOS 手机** | Safari PWA（添加到主屏幕） | 规避 iOS 开发者年费、漫长审核周期及 WebView 远程控制壳过审风险；已实测独立窗口下可规避标签页键盘错位（见 [iOS 软键盘贴合说明](../product/web-ios-keyboard-composer-alignment.md)）并支持 Web Push |
| **无桌面环境 / 临时浏览器** | `codexhost web` 输出的访问链接 | 保持零安装远程/SSH 终端访问能力 |

---

## 3. 桌面端统一入口与交互设计

### 3.1 首次启动探测与一次性默认选择

桌面启动流程复用现有 `codexhost_platform::discover_codex_desktop` 探测能力（[crates/launcher/src/main.rs](../../crates/launcher/src/main.rs)）：

1. **未安装官方 Codex Desktop（含 Linux 等不支持环境）**：不弹出任何模式选择提示，直接拉起后台服务并打开**自有桌面窗口**。
2. **已安装官方 Codex Desktop**：仅在首次启动（尚未记录默认偏好时）弹出一次轻量二选一引导：
   - **CodexHost 桌面端**：轻量、低内存，包含多 Agent 协作、会话树、自定义界面扩展与内置诊断入口，不依赖官方客户端版本适配；
   - **官方 Codex Desktop（增强版）**：保留官方原版桌面界面与操作习惯，注入多 Harness 支持。
3. **后续日常启动**：直接按已保存的默认模式打开窗口，不再每次询问；用户可随时通过系统托盘或设置页切换默认方式。

### 3.2 偏好配置持久化草案

在 `$CODEXHOST_DATA_DIR`（默认 `~/.codexhost`）下新增独立启动偏好文件 `launch-preferences-v1.json`（Unix 权限 `0600`，写入采用临时文件同步加原子替换）：

```json
{
  "version": 1,
  "defaultDesktopSurface": "native-shell",
  "onboardingCompleted": true
}
```

- `defaultDesktopSurface` 仅允许 `"native-shell"`（自有桌面窗口）或 `"codex-desktop"`（官方 Codex Desktop 增强版）。
- 当保存值为 `"codex-desktop"` 但当前机器已找不到可用官方安装时，回退提示或引导切回 `"native-shell"`，不静默卡死。

### 3.3 系统托盘 / 菜单栏总控设计

引入跨平台系统托盘图标，将原本分散在终端命令、`:4399` 和 `:4400` 的高频入口收拢到一处：

- **运行状态概览（只读）**：展示当前状态及活跃 Turn 数量。
- **窗口与模式入口**：
  - `打开 CodexHost 窗口`（打开或前置自有桌面壳窗口）
  - `打开官方 Codex Desktop`（仅本机已安装时可用；若与自有窗口同时打开，共用同一后台 Host 与会话状态）
- **常用服务入口**：
  - `手机与远程连接`（直达已就绪的「连接设备」二维码与 Android APK 下载入口）
  - `默认启动方式 ▸`（切换下一次启动默认打开自有桌面窗口或官方 Codex Desktop）
- **维护与生命周期**：
  - `诊断与日志`（按需启动/打开 Console `:4399`）
  - `检查更新`
  - `完全退出 CodexHost`（停止托管的窗口、Web、Shared Host 与 Broker，替代普通用户记忆和执行 `codexhost stop`）

### 3.4 Console (`:4399`) 退居幕后的规则

延续 [codexhost 控制台](../operations/codexhost-console.md) 已有能力，仅调整自动弹窗策略与入口权重：

- **正常启动静默**：无论是打开自有桌面窗口还是 Codex Desktop，启动成功时不再默认打开系统浏览器跳转到 `:4399`。
- **失败自动救援**：当 Launcher 启动、Host 就绪或 Codex Desktop 注入持续失败时，自动打开 Console 总览页给出分阶段诊断和修复/更新入口。
- **日常设置减重**：将能在主客户端内完成的 Harness 安装/版本检查、连接设备与日志导出收拢至统一设置界面，减少用户跨端口跳转；仅当主界面或官方外壳损坏无法打开时，Console 承担完整离线管理职责。

### 3.5 CLI 兼容边界

保持既有脚本与自动化命令兼容，新增面向自有桌面壳的显式入口：

| 命令 | 规划行为 |
| --- | --- |
| `codexhost` | 图形桌面环境下按 `launch-preferences-v1.json` 启动默认窗口（无偏好且无官方安装时直接开自有桌面壳）；无图形环境或 SSH 会话保持原有回退至 `web` 的行为 |
| `codexhost app`（新增） | 显式确保后台就绪并打开自有桌面窗口，不启动官方 Codex Desktop |
| `codexhost launch` | 保持原有语义，显式以官方 Codex Desktop 注入模式启动 |
| `codexhost web` | 保持不变：确保后台与 Web 服务就绪，输出访问链接并在桌面环境下打开浏览器 |
| `codexhost console` | 保持不变：按需启动并打开本地诊断控制台 `:4399` |
| `codexhost status` / `stop` / `update` / `autostart` | 保持不变；其中 `stop` 需将自有桌面壳及托盘进程纳入停止范围 |

---

## 4. 自有桌面端技术架构（薄原生壳）

### 4.1 核心架构决策：加载本机 `web-server` 而非离线静态 SPA

对比 `packages/web-server/src/web-assets.ts` 与 `packages/web-server/src/auth.ts` 的现有实现，自有桌面壳**不应脱离 `web-server` 单独内嵌离线构建的静态前端页面**，而应作为系统 WebView 容器直接连接本机 `web-server`：

1. **Web UI 扩展动态拼装依赖服务端**：`web-assets.ts` 会在运行时读取 DSH 兼容插件与原生 v2 扩展配置，动态生成 `index.html` 全局注入与 `/plugins/??...` 组合资源，并路由 `backend/invoke` 请求到单实例扩展 Node 后端。若桌面壳直接加载本地静态 HTML，会直接破坏现有 Web 扩展能力并被迫维护两套资源装配器。
2. **数据与本地缓存同源**：加载本机 `web-server`（回环地址）使得桌面壳与本地浏览器访问复用相同的 `127.0.0.1:<port>` origin，浏览器侧壁纸（IndexedDB）、会话标签与前端偏好天然互通，且前后端版本始终严格匹配。
3. **免手工登录实现现成可用**：
   - 桌面壳拉起时先复用 `host_service`（`host ensure`）与 `web_service::ensure` 确保共享后台与本地 Web 服务运行；
   - 随后读取数据目录下的 `web-service-ready.json`（见 [crates/launcher/src/web_service.rs](../../crates/launcher/src/web_service.rs)）获取本机 `loginUrl`（携带 `?token=<localToken>`）；
   - 如 [packages/web-server/src/auth.ts](../../packages/web-server/src/auth.ts) 已实现的边界，`localToken` 仅在 `isLocalConnection` 成立时有效，桌面壳可自动换取 `HttpOnly` 会话 Cookie 实现零弹窗秒开，同时不暴露给局域网或公网请求。

### 4.2 原生壳选型与边界约束

- **明确排除 Electron**：再引入一套 Electron 运行时会重新带来百兆级包体与高内存占用，丧失相对 Codex Desktop 的轻量优势。
- **候选方案（二选一，均复用现有 Rust 工具链）**：
  - **方案 A：Tauri v2 最小壳**：开箱即用的跨平台系统 WebView（macOS WKWebView、Windows WebView2、Linux WebKitGTK）、托盘 API、窗口状态、系统通知与文件拖放封装，开发与跨平台一致性成本最低；
  - **方案 B：纯 Rust `wry` + `tao` + `tray-icon`**：直接集成进现有 `crates/`（如新增 `crates/desktop-shell` 或合并进 `crates/launcher`），依赖树更可控、无需引入 Tauri 脚手架及前端 `@tauri-apps/*` 绑定。
- **架构边界铁律（遵循 [AGENTS.md](../../AGENTS.md)）**：无论是哪种壳，Rust 原生层**只拥有窗口生命周期、系统托盘、原生弹窗、文件/文件夹选择及子进程拉起**，绝不持有 Host 协议逻辑、Thread 状态或 Harness 业务语义；聊天、配置与客户端通道通信（[CH 客户端通道 v1](../architecture/host-client-channel.md)）全部留在 `apps/web-ui` 与 Node 服务层。

### 4.3 跨平台打包、进程管理与更新约束

结合仓库当前发布脚本与安装器，接入自有桌面壳必须同时解决以下工程边界：

1. **macOS 激活策略与代码签名**：
   - 当前 [scripts/release/macos/package.sh](../../scripts/release/macos/package.sh) 在 `codexhost.app/Contents/Info.plist` 中固定设置了 `<key>LSUIElement</key><true/>`，导致应用无 Dock 图标。
   - 引入自有桌面窗口与常驻托盘后，需要支持**动态切换应用激活策略**：仅托盘后台驻留时保持无 Dock 图标的 Accessory 模式；打开自有桌面窗口时切换为 Regular 模式以显示 Dock 图标与标准窗口菜单，关闭窗口时退回 Accessory。
   - 所有新增原生二进制必须纳入同一 `.app` Bundle 签名链路并通过 `codesign --verify --deep --strict`。
2. **Windows 安装器与覆盖安装防护**：
   - [crates/launcher/src/start_menu.rs](../../crates/launcher/src/start_menu.rs) 中的 `codexhost-start.exe` 负责以 `windows_subsystem = "windows"` 无控制台闪烁启动。桌面入口继续经其统一路由。
   - [scripts/release/windows/Installer.iss](../../scripts/release/windows/Installer.iss) 的 `PrepareToInstall` 会调用 `codexhost-updater.exe prepare-install` 终止运行中的旧安装进程。桌面壳与托盘进程必须纳入 `prepare-install` 与 `stop-for-update` 清理范围，防止覆盖安装或应用内升级因可执行文件/WebView2 句柄被占用而失败。
   - 明确 Windows WebView2 运行时缺失时的友好引导（现代 Windows 10/11 多已预装，缺失时提示离线/引导安装而非静默崩溃）。
3. **停止、重启与 Web 热配置切换**：
   - `codexhost stop` 须覆盖桌面壳窗口与托盘常驻进程；
   - `codexhost-updater` 在完成升级后的服务恢复阶段（见 [crates/updater/src/main.rs](../../crates/updater/src/main.rs)），应记录更新前正在运行的界面模式（自有窗口 / Codex Desktop / 双开 / 纯 Web）并按原样恢复；
   - 当用户在设置中修改 Web 监听地址或启用/关闭局域网访问导致 `web-server` 以 `SETTINGS_CHANGED_EXIT_CODE`（退出码 `42`，见 [crates/launcher/src/web_service.rs](../../crates/launcher/src/web_service.rs)）触发监管进程重启时，桌面壳应在 WebView 加载层拦截短暂断连、等待新 `web-service-ready.json` 就绪后平滑重载，避免向用户暴露浏览器连接失败裸页。
4. **npm 分发包体控制**：
   - `@codexhost/cli` 各平台 npm 包当前面向终端与服务部署；需明确是否将桌面壳随 npm 平台包一并分发，或仅随 DMG / Windows Installer / WinGet 交付，而 npm 环境在未携带壳二进制时执行 `codexhost app` 回落系统默认浏览器打开。

---

## 5. Android 轻量原生 APK 壳架构

### 5.1 架构定位：多主机容器 + 受控全屏 WebView

Android 端聚焦解决浏览器手机访问的四大真实痛点：**每次都要重找链接/重新输入令牌、无法管理多台电脑、移动端浏览器手势与键盘遮挡、缺少标准安装包入口**。

与桌面端同理，Android 端同样**不将 `apps/web-ui` 静态代码锁死在 APK 内**，原因如下：
- 不同用户电脑上的 `web-server` 版本和已安装的 Web UI 扩展可能不同，由所连电脑下发对应版本的前端资源可天然保证前后端协议与扩展兼容；
- 若更新桌面端或扩展无需同步重装手机 APK，维护成本最低。

因此 Android APK 采用**“极薄原生多主机容器 + 受控全屏 WebView”**：

```text
Android APK 原生壳
  ├── 主机列表页（原生）：管理 1..N 台电脑连接（名称、来源 URL、连通状态、最后访问）
  ├── 扫码配对模块（原生）：识别电脑端二维码，换取并安全存储访问凭据
  └── 全屏受控 WebView：加载选中电脑的 web-server 会话界面，并注入轻量原生桥接
```

### 5.2 原生层核心职责边界

1. **多电脑管理与一键切换**：
   - 支持保存多台电脑（如“公司主力机”“家里 Mac”“Linux 编译机”），记录备注名、连接入口（Relay / Tailscale / 局域网）与独立凭据，无需反复扫码。
2. **原生扫码配对与凭据保管**：
   - 调用系统相机（或内置轻量扫码组件）扫描电脑端「连接设备」页面的二维码，解析目标 Origin 与访问令牌；
   - 通过受控请求向目标主机验证连通性并交换持久化会话凭据，将凭据加密保存于 Android Keystore / `EncryptedSharedPreferences`，不在明文日志或外部存储暴露；
   - 当电脑端执行“重新生成访问令牌”或返回 `401` 时，自动识别凭据失效并引导重新扫码，不保留死循环重试。
3. **移动端 WebView 体验修补**：
   - **键盘与安全区**：通过原生 `WindowInsetsCompat` 精确响应软键盘高度与刘海/手势导航条安全区，彻底消除手机浏览器地址栏浮动导致的底部输入框遮挡与错位；
   - **返回键与手势**：将 Android 系统返回键/侧滑手势映射到 WebView 内部抽屉收起与路由回退，防止误触直接退出应用；
   - **原生文件与媒体接入**：覆写 `WebChromeClient.onShowFileChooser`，流畅支持相册图片、拍照与本地文档作为对话附件上传；
   - **外链与错误兜底**：仅允许已绑定主机 Origin 在应用内打开，Agent 回复中的外部链接自动唤起系统浏览器；网络断开或电脑休眠时展示友好的原生重连/切换主机卡片，替代系统默认错误页。
4. **分发与应用内更新**：
   - APK 随主仓库 Release 产出一并发布至 GitHub Releases，零商店费用与审核周期；
   - 在电脑端「连接设备」页面提供 Android APK 下载二维码（随版本号或发布页直链更新），方便用户首次装机；
   - APK 内置轻量版本检查（查询最新 Release 元数据），提示用户下载新版 APK 触发系统安装器升级。

### 5.3 推送与后台通知策略（务实分层）

考虑到国内及无 Google Play 服务（GMS）设备对 FCM 的不可用性，以及不自建中心化推送服务器的成本约束，Android 通知采用分阶段策略：

- **第一阶段（随 APK 首版交付）**：聚焦前台连接保活、锁屏恢复秒连（复用 [独立 Web 应用手机连接与恢复](../product/standalone-web.md#手机连接与恢复) 的心跳与游标续接机制）及切回前台的快速快照同步，**不引入中心化推送基础设施**。
- **第二阶段（按用户反馈按需评估）**：对于确实需要离开 App 后仍收到“Agent 完成 / 等待审批”系统通知的场景，评估在 APK 中提供一个**默认关闭、用户显式开启的轻量连接保活开关**（通过 Android 前台服务维持与目标主机的 `/api/ch/v1/events` 或事件流连接并触发本地系统通知，明确提示电量消耗与系统杀后台限制）。

### 5.4 传输与网络安全约束

- 在原生网络配置（`network_security_config.xml`）与界面提示中区分传输安全性：
  - **推荐路径**：Relay HTTPS 与 Tailscale HTTPS（严格校验系统信任证书链，不跳过 TLS 校验）；
  - **局域网明文 HTTP**：仅在本地私有网段（RFC1918 / `100.64.0.0/10` 等非公网地址）下允许连接，并在主机卡片给出“明文局域网连接”提示；禁止向公网域名或公网 IP 建立明文 HTTP 连接。

### 5.5 Android 技术栈选择

- **候选 1：纯 Kotlin + Jetpack（WebView + CameraX/MLKit 或 ZXing + EncryptedSharedPreferences）**：包体最小（通常仅数 MB）、对 `WindowInsets`、WebView 生命周期、文件选择与安全策略掌控最直接，无额外 JS 桥接层维护开销。
- **候选 2：Capacitor 薄壳**：可沿用部分前端工具链，但多一层插件桥与版本同步成本，且多主机管理/密钥保管仍需写 Android 原生插件代码。

鉴于原生界面仅包含“主机管理页 + 扫码页 + 受控 WebView 容器”，纯 Kotlin 方案复杂度可控且包体最轻。

---

## 6. 分阶段实施路线图与 OpenSpec 拆分建议

建议按**“先减法收口 → 再桌面合并 → 后移动补齐”**的节奏演进，每阶段各自对应独立的 OpenSpec 变更并独立验收：

### Phase 0：现有入口减法与能力对齐（零新增原生二进制）

- **目标**：在不引入新桌面壳或 APK 的前提下，先消除用户最直接的“一启动弹一堆东西”的割裂感。
- **关键事项**：
  1. 调整 `crates/launcher` 正常启动行为：双击或常规启动成功时不再默认在浏览器打开 Console (`:4399`)，仅在启动/注入持续失败时自动弹出排障；
  2. 核对并补齐 `apps/web-ui` 相对 Console 的日常管理设置（如启动诊断摘要入口、自启或常用状态查看），减少用户在 `:4399` 与 `:4400` 间切换；
  3. 优化「连接设备」页面信息层级（默认聚焦“推荐方式 + 一键扫码”，将进阶自建/隧道选项收进二级展开）并改善 iOS Safari「添加到主屏幕」引导卡片。
- **预期 OpenSpec 拆分**：`simplify-user-entrypoints-phase0`（或拆分为启动行为调整与连接引导优化两项小变更）。

### Phase 1：桌面端单安装包收口（自有薄壳 + 系统托盘 + 首次模式选择）

- **目标**：让电脑端收敛为“一个 `codexhost` 安装包 + 一个系统托盘 + 双窗口模式按需切换”。
- **关键事项**：
  1. 完成桌面壳原型验证并接入 Rust 构建与发布打包流程（macOS `codexhost.app` 动态激活策略与签名、Windows Inno Setup 与 `codexhost-updater` 停服/恢复联动、Linux 目标支持）；
  2. 实现系统托盘菜单、`launch-preferences-v1.json` 持久化、首次检测到官方 Codex Desktop 时的一次性模式引导，以及 `codexhost app` 子命令；
  3. 实现 `web-server` 退出码 `42` 重启时的桌面壳无感等待与重连重载。
- **预期 OpenSpec 拆分**：`add-desktop-tray-and-native-shell`（属于跨 Rust / TS / 打包脚本架构变更，需要 `proposal.md`、`specs/` 与 `design.md`）。

### Phase 2：自有桌面端主力体验打磨

- **目标**：缩小自有桌面窗口与官方 Codex Desktop 在原生桌面交互上的体验差距，让不安装或不想使用官方桌面端的用户也能把自有窗口作为主力工作台。
- **关键事项**：
  1. 窗口位置/尺寸记忆与多窗口行为规范；
  2. 桌面级快捷键防冲突（如关闭标签/新建会话/搜索不触发浏览器残留行为）；
  3. 增强本地文件/目录拖拽进对话、在系统文件管理器中揭示路径、Diff 审查视图效率打磨。

### Phase 3：Android 轻量原生 APK 壳

- **目标**：交付独立 Android 安装包，覆盖无应用商店依赖的移动端高频访问。
- **关键事项**：
  1. 建立独立 Android 工程目录（如 `apps/android-shell/`）及 CI Release APK 自动打包签名流水线（使用固定构建 keystore 保证覆盖升级兼容）；
  2. 实现多主机管理、扫码配对、安全存储、`WindowInsets` 贴合、返回键处理、附件选择与断线引导；
  3. 在电脑端「连接设备」设置页新增 Android App 下载入口及对应二维码。
- **预期 OpenSpec 拆分**：`add-android-companion-app`。

---

## 7. 编码前待确认决策清单

在正式起草 Phase 1 与 Phase 3 的 OpenSpec 提案前，需与维护者明确以下 5 项决策：

| 序号 | 决策项 | 可选方向 | 影响范围 |
| --- | --- | --- | --- |
| 1 | **自有桌面壳技术选型** | A. Tauri v2 最小壳<br>B. 纯 Rust `wry + tao + tray-icon` | `crates/` 依赖体积、系统菜单/托盘维护成本、CI 工具链要求 |
| 2 | **npm 包（`@codexhost/cli`）是否携带桌面壳** | A. 随平台包携带完整桌面壳<br>B. 仅 DMG / Windows Installer / WinGet 携带，npm 未内置壳时 `codexhost app` 回落系统浏览器 | `scripts/release/prepare-npm.mjs` 包体积与 npm 发布限制 |
| 3 | **Windows 开始菜单快捷方式清理** | A. 移除独立 `codexhost console` 快捷方式（由托盘及错误自救承接）<br>B. 保留作为极端故障快捷入口 | `scripts/release/windows/Installer.iss` |
| 4 | **Android 原生壳技术选型** | A. 纯 Kotlin + Jetpack WebView（推荐）<br>B. Capacitor 薄壳 | 独立构建工具链（Gradle/Android SDK）、APK 体积、键盘与密钥库控制力 |
| 5 | **Android 离屏本地通知优先级** | A. 首期不做后台常驻通知，先打磨前台连接与断线重连<br>B. 首期即提供可选的前台服务事件监听通知 | 电池优化兼容与 Android 13+ 通知/前台服务权限声明 |
