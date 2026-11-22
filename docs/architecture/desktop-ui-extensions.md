# Host 扩展架构（Desktop / Web 跨端统一）

codexhost 扩展是可选的受信任代码，由共享 `codexhost Host`（`host-runtime`）唯一托管。插件在整机只安装一份、配置与数据只存一份、可选的 Node 后端只在共享 Host 内运行唯一一个子进程实例；Desktop 与 Web 是两个平等的前端渲染壳，都通过 Host RPC 读取列表、变更配置、获取资产与调用后端。

- **后端独立于前端存活**：只要共享 Host 运行且扩展处于启用状态，含 `backend` 入口的扩展就在 Host 维持唯一的子进程实例，不依赖 Desktop 或 Web 是否打开；双端同时打开时连接同一个后端实例并读写同一份数据。
- **纯前端零后端**：未声明 `backend` 的扩展不会启动任何 Node 后端子进程。
- **按需组合五种入口**：`page`（跨端独立管理页）、`widget`（跨端主窗口挂件）、`desktop`（Desktop 宿主 DOM 注入）、`web`（Web/PWA 宿主 DOM 注入）和 `backend`（共享 Host 单实例 Node 后端）。五种入口均可选，至少声明其一。

## 安装目录与数据存储

```text
$CODEXHOST_DATA_DIR/                       # 默认 ~/.codexhost/
  host-extensions/                         # 唯一插件安装根
    enabled.json                           # 启用顺序与配置修订号（原子替换）
    <id>/
      current.json                         # 当前激活代次 { activationId, digest, installedAt, source? }
      generations/<activationId>/          # 不可变代次内容目录（原子切换）
        manifest.json
        page/index.mjs                     # 可选：跨端独立管理页
        page/style.css                     # 可选
        widget/index.mjs / widget/style.css # 可选：跨端主窗口挂件
        desktop.js / desktop.css           # 可选：Desktop 宿主注入
        web/index.mjs / web/style.css      # 可选：Web 宿主注入
        backend/index.mjs                  # 可选：Host 单实例 Node 后端
        assets/...                         # 可选：包内静态资源
  host-extension-data/
    <id>/
      settings.json                        # 独立持久化设置与设置修订号（原子替换）
      ...                                  # 后端自由写入的扩展数据目录（ctx.dataDir）
```

- `host-extensions/` 独立于 Harness 插件目录，发现和安装不执行任何扩展代码；必须显式启用才会激活。
- 安装、更新与卸载都在代次目录上原子完成；更新生成新的 `activationId` 与 `digest`，保留已有启用状态与 `host-extension-data/<id>/` 中的独立设置和数据。
- 路径穿越、`..`、符号链接越界和 POSIX 组/他用户可写权限均会被发现和安装校验拒绝。

## 清单格式（`manifestVersion: 2`）

TypeScript 类型与 Zod 校验以 [`packages/shared-contracts/src/host-extensions.ts`](../../packages/shared-contracts/src/host-extensions.ts) 为准。

```json
{
  "manifestVersion": 2,
  "id": "prompt-vault",
  "name": { "en": "Prompt Vault", "zh-CN": "本地提示词库" },
  "version": "1.0.0",
  "description": {
    "en": "Local Markdown prompt library backed by shared Host",
    "zh-CN": "基于共享 Host 的本机 Markdown 提示词库"
  },
  "details": {
    "en": "Store and search reusable Markdown prompts directly on disk.",
    "zh-CN": "直接在本机磁盘读写与检索 Markdown 提示词。"
  },
  "categories": ["tools", "workflow"],
  "icon": "assets/icon.png",
  "screenshots": ["assets/preview.png"],
  "settingsSchema": [
    {
      "key": "vaultDir",
      "type": "string",
      "label": { "en": "Vault Directory", "zh-CN": "提示词目录" }
    }
  ],
  "page": {
    "apiVersion": 1,
    "entry": "page/index.mjs",
    "style": "page/style.css",
    "title": { "en": "Prompt Vault", "zh-CN": "本地提示词库" }
  },
  "backend": {
    "apiVersion": 1,
    "entry": "backend/index.mjs"
  }
}
```

- **`id`**：匹配 `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`（最长 128 字符）。
- **双语文案**：`name` 与 `description` 为 `{ en, "zh-CN" }`；`details`、`page.title` 可选双语对象。UI 通过 `resolveLocalizedExtensionText(value, locale)` 按语言回退显示。
- **五种可选入口**（至少声明其一；`backend.entry` 不得与 `page.entry`、`widget.entry` 或 `web.entry` 重合）：
  - `page`：`{ apiVersion: 1, entry: "*.mjs", style?: "*.css", title?: LocalizedText }`
  - `widget`：`{ apiVersion: 1, entry: "*.mjs", style?: "*.css" }`
  - `desktop`：`{ apiVersion: 1, script: "*.js", style?: "*.css" }`；可配合可选 `slots`（`sidebar.thread-badge`、`sidebar.thread-layout`、`appearance.theme`）声明 Desktop 独占槽位。
  - `web`：`{ apiVersion: 1, entry?: "*.mjs", style?: "*.css" }`（至少声明 `entry` 或 `style` 之一）。
  - `backend`：`{ apiVersion: 1, entry: "*.mjs" }`。
- **能力与目标推导**：`hostExtensionCapabilities(manifest)` 推导 `{ hasPage, hasWidget, hasDesktop, hasWeb, hasBackend }`；`hostExtensionTargets(manifest)` 推导适用端（含 `page`、`widget` 或仅 `backend` 时为 `["desktop", "web"]`，否则按声明的 `desktop` / `web` 推导）。
- **展示元数据**：`author`、`repository`（HTTP(S)）、`categories`（`appearance` / `interface` / `workflow` / `analytics` / `integrations` / `tools`）、`icon`（≤ 128 KiB PNG/JPEG/WebP）、`screenshots`（最多 4 张，单张 ≤ 512 KiB，合计 ≤ 2 MiB）。
- **兼容解析**：`parseHostExtensionManifest` 同时支持将 `manifestVersion: 1` 清单规范化解析为 v2 形态；高于 v2 的清单标记为 `incompatible`。

## 跨端独立管理页（`page`）

声明 `page` 的插件只需编写一份标准 ESM 前端代码。Desktop 在设置中以 Shadow DOM 打开；Web 左侧一级导航只有一行「插件」入口，进入主工作区后可在顶部切页栏切换「插件中心」与已启用的独立页。没有可打开的独立页时，主工作区直接展示插件中心。

- 入口模块导出 `mount(root: HTMLElement, api: HostExtensionPageApi)`，可返回同步或异步清理函数。
- 宿主在容器上暴露统一的主题 CSS 变量（`HOST_EXTENSION_PAGE_CSS_VARIABLES`）：
  `--cx-page-bg`、`--cx-page-surface`、`--cx-page-text`、`--cx-page-text-muted`、`--cx-page-border`、`--cx-page-accent`、`--cx-page-danger`、`--cx-page-radius`。
- `HostExtensionPageApi` 契约：

| 属性 / 方法 | 说明 |
| --- | --- |
| `api.id` / `api.apiVersion` / `api.hostTarget` | 扩展 ID、Page API 版本（`1`）与当前渲染壳标识（`"desktop"` \| `"web"`）。 |
| `api.locale` / `api.onLocaleChange(cb)` | 当前界面语言与切换订阅。 |
| `api.colorScheme` / `api.onColorSchemeChange(cb)` | 当前浅/深色主题（`"light"` \| `"dark"`）与切换订阅。 |
| `api.signal` | 页面关闭、扩展禁用、卸载或代次更新时立即触发的 `AbortSignal`。 |
| `api.assets.url(relativePath)` | 解析包内公开静态资源 URL（Desktop 返回 `data:` URL，Web 返回基于 `document.baseURI` 解析的受鉴权资产 URL）。 |
| `api.storage.get()` / `set(values)` / `onChange(cb)` | 读写共享 Host 维护的独立 `settings.json` 并监听修订变更（自动处理修订号冲突重试）。 |
| `api.backend.invoke(method, params?)` | 调用共享 Host 单实例 Node 后端通过 `ctx.handle` 注册的方法；未声明 `backend` 时直接拒绝。 |

### Desktop 与 Web 的模块加载

- **Desktop**：Controller 仅为已启用代次链接 `manifest.page.entry` / `manifest.widget.entry`。入口及递归依赖均通过 `readHostExtensionAsset` 校验路径、当前代次和内容完整性；禁止越界、访问 `backend.entry`、裸包名、外部 URL 和动态 `import()`。静态导入和重导出可引用包内 `.mjs`（例如 `../shared/timer.mjs`）。`import.meta.url` 提供带代次的 `codexhost-extension:` 标识，不是可请求的资产 URL；读取图片、字体等资源请用 `api.assets.url()`。
- Controller 使用纯 JS 链接器生成自包含工厂，并用 `vm.Script` 逐个预检；Node 不执行插件代码。工厂随 CDP 快照注入 `app://-/index.html` 主框架，当前文档用 `Runtime.evaluate` 更新。加载不依赖 `app://` 虚拟资产或网络拦截，不改变 CSP，也不在 Renderer 编译字符串。每个入口模块图内的共享模块只求值一次，同一入口代次的重复挂载复用已求值的模块。
- Renderer 按扩展 ID、入口、`activationId` 与 `digest` 匹配工厂。先打开的页面等待就绪；挂件在快照与工厂都到齐后自动挂载。代次替换、禁用或卸载时回收旧工厂和挂载，且不重载 Desktop。链接、求值和挂载错误会显示在页面错误提示，或写入 Desktop 扩展诊断的 `surfaces`（键为 `<id>:page` / `<id>:widget`）。失败的挂件不会在同一份快照上反复尝试。
- **CH Web**：浏览器原生 `import()` 使用原有经鉴权的 `/api/extensions/assets/...` HTTP 路径，不使用 Desktop 工厂表。

## 跨端主窗口挂件（`widget`）

`widget.entry` 同样导出 `mount(root, api)`，一份代码在 Desktop 和 Web 主页面自动运行，不需要打开设置或独立页。双端在 `body` 下各用一个 Shadow DOM 容器挂载，提供可选样式、`--cx-page-*` 和语言/主题订阅；只在交互区域设置 `pointer-events: auto`。`page` 与 `widget` 可以从入口相对导入同一个包内 `.mjs`，例如 `../shared/timer.mjs`。

Web 与 `web` 入口共用 `extensions-changed` 订阅和快照对账；Desktop 监听本地扩展变更，并在窗口可见时每 5 秒补读快照。同一代次的设置变更通知 `storage.onChange`，保留挂件 DOM；禁用、卸载、更换代次或宿主销毁时，中止 `api.signal`、调用清理函数并移除容器。挂载和清理错误按实例隔离。

## 宿主页面注入（`desktop` 与 `web`）

### Desktop 注入（`desktop`）

- 经典脚本（非 ESM），加载时同步调用一次 `define({ activate(api) { … } })`，运行在 Codex Desktop 主窗口；激活超时 5 秒。
- `packages/desktop-control` 的 `RendererDesktopExtensions` 扫描 `$CODEXHOST_DATA_DIR/host-extensions/`，仅注入已启用、声明了 `manifest.desktop` 且未发生槽位冲突的扩展；按 `(activationId, digest)` 做无重载热更新与回收，并将状态写入诊断文件。
- 槽位：`sidebar.thread-badge`、`sidebar.thread-layout`、`appearance.theme` 同一时间只分配给一个扩展；冲突按 `enabled` 顺序判定，不影响该扩展的 `page`、`widget`、`web` 或 `backend` 能力。
- 原语包括 `api.sidebar.observeRows`、`api.threads.watchTree`、`api.navigate.openThread`、`api.harnesses.describe`、`api.dom.mount`、`api.dom.mark` / `unmark`、`api.assets.readDataUrl`、`api.storage`、`api.backend.invoke`、`api.settings.registerPage`、`api.signal` 与 `api.track`。

### Web 注入（`web`）

- ESM 模块（导出 `activate(api)`）与可选样式表，运行在 Web/PWA 宿主（`apps/web-ui/packages/client/ui-codexhost/src/client/native-extensions/`）。
- 浏览器宿主通过 `codexhost/extensions/snapshot` 获取当前已启用快照，并订阅 `GET /api/ch/v1/events` 的 `extensions-changed` 事件驱动对账（单标签页引用计数复用，且在支持 Web Locks + `BroadcastChannel` 的同源多标签页间共享 1 条事件流，避免耗尽 HTTP/1.1 连接池），仅激活含 `manifest.web` 的条目；同代次仅设置修订变化时原地通知 `storage.onChange` 而不重建 DOM。
- 传统 DSH Web 插件的独立管理/恢复入口（`WebUiExtensions` / `/extensions`）与之隔离并保持独立可用。

## 单实例 Node 后端（`backend`）

- 入口为包内 `.mjs` 文件（≤ 2 MiB），导出 `activate(ctx)` 或 `default.activate(ctx)`，运行在共享 Host 托管的独立子进程（`ExtensionBackendProcess`）中。
- `ctx` 提供 `extensionId`、`extensionDir`、`dataDir`（`$CODEXHOST_DATA_DIR/host-extension-data/<id>`）、`handle(method, handler)`、`readSettings()` 与 `writeSettings(values)`；可返回同步或异步清理函数 / `{ dispose() }`。
- `HostExtensionManager` 在共享 Host 启动时自动拉起已启用后端，在启停、更新、卸载、恢复与 Host 关闭时串行对账并优雅回收旧进程。更新失败或异常退出记录在诊断日志与 `backendState: "failed"`，不会拖垮 Host。
- **进程隔离不是权限沙箱**：后端以当前本机用户权限运行，只启用你信任的扩展。

## 统一 Host RPC、Web 薄代理与市场

所有管理与运行时操作统一走 `codexhost/extensions/*`（由共享 Host 的 `HostExtensionManager` 处理；SSH 远程托管 Host 拒绝这些方法返回 `-32601`）：

| RPC 方法 | 用途 |
| --- | --- |
| `list` / `snapshot` | 返回含修订号与诊断的管理列表 / 仅供已启用扩展使用的运行态快照 |
| `catalog` | 并发竞速拉取市场索引 `catalog.v2.json`（GitHub Raw 与 jsDelivr 镜像，5 分钟缓存） |
| `install` / `update` / `uninstall` | 支持 `catalog`、`github`、`zip`（base64；拒绝 `localZipPath`）与 `localDir`；代次原子替换 |
| `enable` / `disable` / `recover` | 带 `expectedRevision` 乐观锁更新 `enabled.json`；`recover` 一键清空启用列表 |
| `asset` | 安全读取公开静态资源、声明的前端入口及包内 `.mjs` 模块，严格禁止读取 `backend.entry` 或路径穿越 |
| `settings/get` / `settings/set` | 带 `expectedSettingsRevision` 读写独立 `settings.json`（≤ 1 MiB） |
| `backend/invoke` | 按 `(id, activationId?, method, params?)` 调用已启用且激活成功的单实例后端 |

- **变更广播**：任意安装、更新、启停、恢复、卸载或设置写入都会递增 Host 修订号并发布 `extensions-changed` Client Channel 事件。
- **Web 薄代理（`packages/web-server`）**：不持有任何扩展磁盘目录或子进程，全部在现有 `auth.gate` 鉴权与同源门禁（`--no-auth` / `--safe-mode` 返回 `403`）之后代理至共享 Host：
  - `POST /api/ch/v1/rpc` 与 `GET /api/ch/v1/events`：透传 `codexhost/extensions/*` RPC 与 `extensions-changed` 事件；
  - `POST /api/extensions/upload`（`Content-Type: application/zip`，≤ 64 MiB）：流式读取 ZIP 后转为 `install` / `update` RPC；
  - `GET` / `HEAD /api/extensions/assets/:id/:activationId/:digest/*`：向 Host 请求资产并返回 `Cache-Control: private, max-age=31536000, immutable`、`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin`；对缺失、代次不匹配及 `backend.entry` 统一返回 `404`。
- **Console 转发（`packages/console-server`）**：`/api/extensions/*` 写操作转发至共享 Host RPC，共享 Host 未运行时返回 `503`；只读列表与市场查询在离线时支持直接读取磁盘/拉取目录。
- **双端统一 UI**：Desktop「设置 → 插件」和 Web「插件」工作区内的插件中心提供统一的管理界面。正常已安装插件在同一网格按本地化名称排列，只有异常插件单独列在顶部。卡片和详情标明适用平台（`Codex Desktop · CH Web` / `仅 Codex Desktop` / `仅 CH Web`），并支持按适用平台、能力（`独立页面` / `挂件` / `后台`）和分类筛选。插件中心在后台加载市场目录，目录可用后显示市场数量；有新版本的插件可直接从「已安装」卡片更新。已启用且含 `page` 的扩展可从 Desktop 设置左侧的「插件页面」分组或 Web 主工作区顶部的切页栏打开，也可从插件中心点击「打开页面」。`settingsSchema` 表单只在插件详情中显示，用于编辑共享设置。Desktop 侧栏也支持旧版 `api.settings.registerPage` 自定义页；同一扩展声明了 `page` 时优先展示独立页面。

## 作者与打包指南

开发、打包、隔离实测与市场投稿步骤见 [扩展开发 Skill](../../.agents/skills/codexhost-add-desktop-extension/SKILL.md)。对于含 `desktop` 入口的包，仍可用仓库工具打包静态入口：

```bash
: "${EXTENSION_SOURCE_DIR:?请先设置扩展源码目录}"
npx tsc -b packages/harness-plugin-files
node tools/build-desktop-extension.mjs "$EXTENSION_SOURCE_DIR" "<输出目录>"
```

含 `page`、`widget`、`web` 或 `backend` 的统一扩展直接将 `manifest.json` 与构建后的 `.mjs`/`.css`/静态资源打入 `.zip`（或在开发期通过本机目录 `localDir` 安装），在 Desktop 或 Web 的「插件」中心导入并启用即可跨端生效。
