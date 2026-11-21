# Design

## Context

动机见 [proposal.md](./proposal.md)。当前系统在 `packages/host-runtime`（Desktop 扩展）与 `packages/web-server`（Web 原生扩展）之间维护了两套平行的目录、状态文件、安装器和 `ExtensionBackendProcess` 托管逻辑；且 Desktop 侧仍只接受 v1 清单与 `catalog.json` v1。

由于现阶段几乎没有存量插件，本次变更直接推倒平行双轨，以共享 `codexhost Host` 为唯一所有权核心，让 Desktop 与 Web 成为平等的前端渲染壳。

## Decisions

### 1. 统一清单与契约（`packages/shared-contracts`）

保留 `manifestVersion: 2` 作为唯一规范清单（同时兼容解析现存官方市场 v1 Desktop 清单为仅含 `desktop` 的等价对象），新增独立 `page` 入口，四个入口全部可选（至少提供一项）：

```ts
export interface HostExtensionManifestV2 {
  manifestVersion: 2;
  id: string;
  name: LocalizedText;
  version: string;
  description: LocalizedText;
  details?: LocalizedText;
  author?: string;
  repository?: string;
  icon?: string;
  screenshots?: string[];
  categories?: ExtensionCategory[];
  settingsSchema?: ExtensionSettingField[];
  slots?: DesktopExtensionSlot[]; // 仅声明 desktop 时生效
  page?: {
    apiVersion: 1;
    entry: string;        // .mjs，导出 mount(root, api) => disposer?
    style?: string;       // .css
    title?: LocalizedText;
  };
  desktop?: {
    apiVersion: 1;
    script: string;       // .js，经典 Desktop 注入脚本
    style?: string;       // .css
  };
  web?: {
    apiVersion: 1;
    entry?: string;       // .mjs，导出 activate(api) => disposer?
    style?: string;       // .css
  };
  backend?: {
    apiVersion: 1;
    entry: string;        // .mjs，导出 activate(ctx) => disposer?
  };
}
```

- **能力与目标推导**：
  - `hasPage = Boolean(manifest.page)`、`hasDesktop = Boolean(manifest.desktop)`、`hasWeb = Boolean(manifest.web)`、`hasBackend = Boolean(manifest.backend)`。
  - `targets`：`desktop` 存在、或 `page` 存在、或纯 `backend` 时包含 `"desktop"`；`web` 存在、或 `page` 存在、或纯 `backend` 时包含 `"web"`。
- **独立管理页 API（`HostExtensionPageApi`）**：
  - `id`、`apiVersion: 1`、`hostTarget: "desktop" | "web"`、`locale`、`onLocaleChange(cb)`、`colorScheme`、`onColorSchemeChange(cb)`、`signal: AbortSignal`；
  - `assets.url(relativePath): Promise<string>`（返回可直接用于 `<img src>` 等的不透明 URL：Web 为同源受检资产 URL，Desktop 为 data URL）；
  - `storage: { get(); set(values); onChange(cb) }`（读写统一 Host `settings.json`）；
  - `backend: { invoke(method, params?) }`（仅调用本插件在 Host 中的唯一后端，未声明 `backend` 时明确拒回）。
  - 宿主容器在 Desktop 与 Web 两端统一提供语义 CSS 变量：`--cx-page-bg`、`--cx-page-surface`、`--cx-page-text`、`--cx-page-text-muted`、`--cx-page-border`、`--cx-page-accent`、`--cx-page-danger`、`--cx-page-radius`。

### 2. 单一磁盘布局与共享 Host 托管（`packages/harness-plugin-files` & `packages/host-runtime`）

- **唯一磁盘根**（位于 Host `dataDir` 下，避免与 Pi 的 `extensions/` 混淆）：
  - `<dataDir>/host-extensions/<id>/`：采用代次目录 + `active.json`（记录 `generation`、`digest`、`activationId`）原子切换，支持更新回滚与不可变代次校验；
  - `<dataDir>/host-extensions/enabled.json`：唯一启用列表与 `revision`；
  - `<dataDir>/host-extension-data/<id>/settings.json` 及同目录插件私有数据：Desktop、Web 与后台进程共享同一份。
- **单实例后台托管**：
  - `HostExtensionManager`（由共享 Host `shared-host-service` / `AppServerHost` 持有）统一负责磁盘状态串行写（`SerialQueue`）、市场拉取（`catalog.v2.json`，raw + jsDelivr `Promise.any` 并发竞速与缓存）和 `ExtensionBackendProcess` 生命周期。
  - 共享 Host 启动后自动恢复并拉起所有已启用且声明 `backend`（且无 Desktop 槽位冲突阻断，或解耦：槽位冲突仅阻断 Desktop 注入，不阻断 `backend` / `web` / `page`！）的插件后台进程——**每个启用插件严格只跑 1 个后端实例**，不依赖 Desktop 或 Web 是否打开。
  - 状态/安装/启停/设置变更时向 `ClientChannelEvents` 广播 `{ type: "extensions-changed", cursor, revision }`（Desktop 与 Web 均可实时感知刷新）。

### 3. 统一 RPC 命名空间与 `web-server` 薄代理

- **统一 Host RPC（`codexhost/extensions/*`）**，加入 `CLIENT_CHANNEL_METHODS` 与 `AppServerHost` `externalOnly` 白名单（`CODEXHOST_REMOTE_SSH_MANAGED=1` 仍返回 `-32601`）：
  - `codexhost/extensions/list`
  - `codexhost/extensions/snapshot`
  - `codexhost/extensions/catalog`
  - `codexhost/extensions/install`（支持 `catalog` / `github` / `zip` / `localDir`）
  - `codexhost/extensions/update`
  - `codexhost/extensions/enable` / `codexhost/extensions/disable`
  - `codexhost/extensions/uninstall`
  - `codexhost/extensions/recover`
  - `codexhost/extensions/asset`（校验代次、路径、白名单扩展名、大小上限，**严禁读取 `backend.entry`**，返回 `{ mimeType, base64, digest }`）
  - `codexhost/extensions/settings/get` / `codexhost/extensions/settings/set`
  - `codexhost/extensions/backend/invoke`
- **`packages/web-server` 瘦身**：
  - 删除 `packages/web-server/src/web-native-extensions.ts` 平行磁盘与进程管理器；
  - `web-server` 仅保留：
    1. 现有 `auth.gate` + `sameOrigin` + `--no-auth` 拒绝闸门；
    2. `POST /api/extensions/upload`（临时接流 ZIP 上传并转交 `codexhost/extensions/install`）；
    3. `GET /api/extensions/assets/:id/:activationId/:digest/*`（鉴权通过后调 `chHost.realtime.request("codexhost/extensions/asset", ...)` 返回原始字节，带 `X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin` 与基于 `(activationId, digest)` 的不可变缓存头）；
    4. `/api/ch/v1/rpc` 透传 `codexhost/extensions/*`（保留 `authenticated` 检查）。
  - `console-server` 的扩展路由改为通过同一共享 Host / `harness-plugin-files` 统一管理器读写，不再直接操作旧 `desktop-extensions` 目录。

### 4. 两端前端渲染与独立管理页加载

- **Web 端（`apps/web-ui/packages/client/ui-codexhost`）**：
  - `WebNativeExtensionHost` 改为读取共享 Host `codexhost/extensions/snapshot` 并订阅客户端通道 `extensions-changed` 事件（保留低频兜底/重连刷新），从 `/api/extensions/assets/...` 动态 `import()` 启用的 `web.entry` / 加载 `web.style`；
  - 单一 `PluginsSection` 直接调用 `codexhost/extensions/*`（不再需要 `Web | Desktop` 切换胶囊与两套 UI 嵌套），卡片展示能力角标（`全端 / Web / Desktop / 独立页面 / 后台`），支持在面板/抽屉内直接挂载任意插件的通用 `page`；
  - 传统 DSH Web 扩展保留独立恢复入口（`/extensions`），不混入主插件中心逻辑。
- **Desktop 端（`packages/desktop-control` & `packages/renderer-extension`）**：
  - `desktop-control` 从共享 Host 的统一管理器发现启用且含 `desktop` 入口的插件并按原有 CDP 流程注入（保留槽位冲突诊断）；
  - `renderer-extension` 设置页「插件」切换至 `codexhost/extensions/*` 与统一市场，支持在 Shadow DOM 设置面板内挂载插件的通用 `page`：通过 `codexhost/extensions/asset` 读取 `page.entry` 源码与 `page.style`，使用基于 Blob URL 的标准 ESM `import()`（若 Electron CSP 拦截则经 `desktop-control` CDP 受控桥接执行，**不放宽宿主 CSP**）。

## Risks / Trade-offs

- **[Desktop 渲染器 CSP 可能拦截 `blob:` 动态 `import()`]** → 实现 Desktop `page` 加载器时先在真实/隔离 Electron CSP 下验证；若 `script-src` 拦截 `blob:`，由 `desktop-control` 通过 CDP 注入薄引导模块执行同一份 `page.entry` 代码，不放宽 CSP。
- **[删除旧 `desktop-extensions` / `web-native-extensions` 路径导致旧测试大面积失效]** → 按模块拆分：Stage 1 先落统一契约与文件原语，Stage 2 同步替换 `host-runtime`、`web-server`、`renderer-extension`/`web-ui` 及其测试，删除过时的双轨测试，不保留死代码。
- **[ZIP 上传经 RPC 传递的内存上限]** → `web-server` 的 `/api/extensions/upload` 仍保留 64 MiB 上限与流式校验，本地共享 Host 可直接接收临时受控路径（仅本机同用户可访问）或分块，避免把 64 MiB ZIP 做无意义的双倍 base64 内存拷贝。

## Migration

无需兼容旧双目录数据迁移；直接切换至 `<dataDir>/host-extensions/` 与 `<dataDir>/host-extension-data/`，并清理被替代的平行 `WebNativeExtensions` 实现与废弃旧路由/测试。
