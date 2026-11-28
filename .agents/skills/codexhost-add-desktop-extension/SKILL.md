---
name: codexhost-add-desktop-extension
description: 开发、打包、验收或排查 codexhost 统一 Host 扩展：跨端独立管理页（page）与挂件（widget）、Desktop/Web 宿主注入、静态资源、声明式设置与可选单实例 Node 后端。不用于接入 Agent Harness 或改变 Thread 行为。
---

# 新增 codexhost Host 扩展

目标：交付一个由共享 `codexhost Host` 统一托管、可在 Desktop 与 Web 按需运行、支持热启停与干净卸载的可信扩展。路径以仓库根目录为基准；契约以 [`packages/shared-contracts/src/host-extensions.ts`](../../../packages/shared-contracts/src/host-extensions.ts) 与 [`packages/shared-contracts/src/host-extension-management.ts`](../../../packages/shared-contracts/src/host-extension-management.ts) 为准。

| 需求 | 改动位置 |
| --- | --- |
| 独立管理页、工具面板、皮肤、侧栏增强或本机后台能力 | 统一 Host 扩展包（`manifestVersion: 2`），默认只改扩展自己的目录 |
| 接入 Agent Harness，提供 Session 执行、历史、模型或账号能力 | [Harness 插件](../codexhost-add-harness/SKILL.md) |
| 改变 Thread 归属、执行、持久化，或增加通用宿主原语 | 在主干设计公共能力，不在扩展里绕过 API |

## 1. 选择入口形态并编写 `manifest.json`

统一扩展安装在 `$CODEXHOST_DATA_DIR/host-extensions/<id>/generations/<activationId>/`，配置与后端数据持久化在 `$CODEXHOST_DATA_DIR/host-extension-data/<id>/`。五种入口均为可选，**至少声明其一**；不声明 `backend` 的纯前端插件不会启动任何 Node 后台进程：

- **`page`**（跨端独立管理页）：写一份标准 ESM + CSS，Desktop 与 Web 两端打开都能直接运行；
- **`widget`**（跨端主窗口挂件）：已启用时自动挂载，复用 `page` 的 `mount(root, api)` 和主题变量，无需打开设置；
- **`desktop`**（Desktop 宿主 DOM 注入）：在 Codex Desktop 主窗口注入侧栏/主题等原生增强；
- **`web`**（Web/PWA 宿主 DOM 注入）：在 Web 界面挂载区域组件或样式；
- **`backend`**（共享 Host 单实例 Node 后端）：由共享 Host 唯一托管并常驻，Desktop 与 Web 共用同一实例和同一份数据。

`manifest.json` 示例（全栈：`page` + `backend`；纯前端小组件直接省略 `backend` 即可）：

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
    "en": "Search, edit, and copy local Markdown prompts across Desktop and Web.",
    "zh-CN": "在 Desktop 与 Web 间同步检索、编辑并复制本机 Markdown 提示词。"
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

- `id` 最长 128 字符，匹配 `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`；`name` 与 `description` 须提供非空 `en` 与 `zh-CN` 文案。
- `settingsSchema` 为可选字段，只在 Desktop 与 Web 的「插件详情」弹窗中自动渲染设置表单（读写 `api.storage`）；不需要配置项、或已将参数调整做在 `page` / `widget` 内的插件应省略 `settingsSchema`，详情弹窗不会显示空白设置区。
- `categories` 可选多选：`appearance`、`interface`、`workflow`、`analytics`、`integrations`、`tools`。
- `icon`（≤ 128 KiB）与 `screenshots`（最多 4 张，每张 ≤ 512 KiB，合计 ≤ 2 MiB）仅允许 PNG / JPEG / WebP，相对路径须使用 `/` 且不得越界。
- `backend.entry` 不可与 `page.entry`、`widget.entry` 或 `web.entry` 指向同一文件，且不会被静态资产接口对外暴露。
- 若声明 `desktop` 入口并占用独占区域，通过 `slots` 声明实际用到的槽位（`sidebar.thread-badge`、`sidebar.thread-layout`、`appearance.theme`）；不需要时省略。

## 2. 实现所声明的入口

### 2.1 跨端独立管理页（`page`）

`page.entry` 是标准 ESM（`.mjs`），导出 `mount(root, api)` 并可返回同步或异步清理函数。遵守严格 CSP（不得使用 `eval` / `new Function` / 外部 CDN 脚本）：

```js
export async function mount(root, api) {
  root.innerHTML = `<div class="pv-card">Hello ${api.hostTarget}</div>`;
  const settings = await api.storage.get();
  const stopWatching = api.storage.onChange((next) => {
    // React to settings saved from Desktop, Web, or backend.
  });
  return () => {
    stopWatching();
    root.replaceChildren();
  };
}
```

- **主题变量**：在 `page.style` 中只依赖宿主提供的 8 个标准 CSS 变量（Desktop Shadow DOM 与 Web 容器保持一致）：`--cx-page-bg`、`--cx-page-surface`、`--cx-page-text`、`--cx-page-text-muted`、`--cx-page-border`、`--cx-page-accent`、`--cx-page-danger`、`--cx-page-radius`。
- **可用能力（`HostExtensionPageApi`）**：
  - `api.id` / `api.apiVersion` / `api.hostTarget`（`"desktop"` \| `"web"`）
  - `api.locale` / `api.onLocaleChange(cb)`、`api.colorScheme` / `api.onColorSchemeChange(cb)`
  - `api.signal`（页面关闭、扩展禁用/卸载或代次切换时触发；传给事件监听器与定时器清理）
  - `api.assets.url(relativePath)`（异步返回图片/字体等包内资源 URL）
  - `api.storage.get()` / `set(values)` / `onChange(cb)`（读写共享 Host `settings.json`，**纯前端无后端插件也能使用**；临时前端运行态如倒计时可直接存 `localStorage`）
  - `api.backend.invoke(method, params?)`（仅含 `backend` 的插件可调用；无 `backend` 时抛出明确错误）

### 2.2 主窗口挂件（`widget`）

在清单中声明 `widget: { apiVersion: 1, entry: "widget/index.mjs", style: "widget/style.css" }`（`style` 可省略）。用同一份 `mount(root, api)` 代码在 Desktop 和 Web 主页面运行；双端均使用 Shadow DOM。只在交互区域设置 `pointer-events: auto`，让覆盖层其余区域透传点击。`page` 和 `widget` 入口可相对导入同一个包内 `.mjs`，例如 `../shared/timer.mjs`；打包时包含该模块。

### 2.3 Desktop 宿主注入（`desktop`）

经典脚本（`.js`，非 ESM），加载时同步调用 `define({ activate(api) { … } })`。只通过 `api.dom.mount` 与 `api.dom.mark` + `desktop.style` 增强界面，不直接改写原生元素的 `style` / `class`，不接入私有 React 对象。支持 `sidebar.observeRows`、`threads.watchTree`、`navigate.openThread`、`harnesses.describe`、`assets.readDataUrl`、`storage`、`backend.invoke`、`settings.registerPage`、`signal` 与 `track`。

### 2.4 Web 宿主注入（`web`）

ESM 模块（`.mjs`），导出 `activate(api)` 并可返回清理函数（也可只声明 `web.style` 纯 CSS 扩展）。通过 `api.dom.mount(regionOrEl)`（内置区域 `app`、`topbar`、`sidebar`、`conversation`、`composer-dock`）、`api.dom.mark`、`api.session.getActive()` / `api.session.onChange(cb)`（只读主会话上下文：`id`、`title`、`cwd`、`workspaceId`、`isBlank`、`isRemote`、`running`）、`api.assets.url`、`api.storage`、`api.backend.invoke`、`api.settings.registerPage`、`api.panels.register` 与 `api.signal` / `api.track` 集成，停用时自动回收全部节点、标记与订阅。

### 2.5 单实例 Node 后端（`backend`）

包内 ESM（`.mjs`，≤ 2 MiB，自行打包运行依赖），导出 `activate(ctx)` 或 `default.activate(ctx)`：

```js
export async function activate(ctx) {
  ctx.handle("ping", async () => ({ pid: process.pid, dataDir: ctx.dataDir }));
  return () => {
    // Release timers, watchers, or handles before process shutdown.
  };
}
```

- `ctx.extensionId`、`ctx.extensionDir`、`ctx.dataDir`（`$CODEXHOST_DATA_DIR/host-extension-data/<id>`）、`ctx.readSettings()`、`ctx.writeSettings(values)`、`ctx.handle(method, handler)`。
- 后端随共享 Host 唯一运行 1 个进程，与前端开闭无关；**进程隔离不是权限沙箱**，只运行信任的代码。

### 2.6 任务活动摘要、Harness 元数据、托管原生浮窗与 Web 标签页图标

- **任务与通知活动摘要（`ctx.activity?.read()`）**：按需订阅并在扩展停用时自动释放，返回 `{ epoch, revision, running, waiting, sessions, notifications }`（最多 32 条会话摘要与 256 条通知），不暴露提示词、工具输出或 Transcript。运行态同时覆盖父 Thread 与活跃子 Agent，快照瞬时失败会在同一生命周期内有界重试而不丢失完成标记；请结合 `epoch` 与通知 `revision` 维护已读进度。
- **Harness 展示元数据（`ctx.harnesses?.describe(id)`）**：按会话摘要中的 `harness: { id, name }` 按需读取已安装 Harness 的名称、图标与受限 `iconStyle`（官方会话为 `codex`），使用独立 IPC 并发配额（上限 16），不与设置读写（上限 4）互相挤占；未找到时回退通用图标，不要按模型名猜测。
- **托管原生浮窗（`ctx.windows`）**：仅由独立 **CodexHost Desktop Shell** 在 Host 本机托管（不会控制独立 Codex Desktop 进程，远程浏览器不会在客户端弹窗）。先检查 `ctx.windows?.available` 与 `ctx.windows?.clickThroughSupported`：
  - `open({ url, width, height })` 仅允许显式端口的 `http://127.0.0.1:<port>/...` 与 `96..=640` 逻辑宽高；
  - `close()` 释放窗口，扩展禁用/卸载/更新或 Host 退出时也会自动回收进程树；
  - `showHost(route?)` 唤起独立 CodexHost Desktop Shell 并导航到根相对路由（`/`、`/?...`、`/#...`，禁止 `token` 参数），复用已有 Web 登录态；
  - 浮窗页面可通过 `window.codexhostWindow.{ clickThroughSupported, startDragging(), setHitRegions(regions) }` 实现拖动与逻辑坐标交互区；在 **Linux Wayland** 下 `clickThroughSupported` 为 `false`，宿主显式禁用基于全局光标的点击穿透（`setHitRegions` 校验后返回 `false`），扩展应保证整窗可见元素可交互而不依赖点击穿透。
- **Web 标签页图标贡献（`api.tabIcon?.set(pngDataUrl | null)`）**：在 `web` 入口中提交小于 128 KiB 的 PNG data URL，传 `null` 清除本扩展贡献；多扩展独立持有，页面隐藏或扩展卸载时自动恢复原 favicon 节点与顺序。
- 完整契约、安全边界与平台支持矩阵见 [Host 扩展架构](../../../docs/architecture/desktop-ui-extensions.md)。

## 3. 打包与隔离实测

1. 将 `manifest.json`、构建后的 `page`/`widget`/`desktop`/`web`/`backend` 文件以及声明的图标、截图与静态资源打入 `.zip`（`manifest.json` 位于 ZIP 根或唯一顶层目录；ZIP ≤ 64 MiB）。如仅构建 `desktop` 经典入口，也可复用：
   ```bash
   npx tsc -b packages/harness-plugin-files
   node tools/build-desktop-extension.mjs "$EXTENSION_SOURCE_DIR" "<输出目录>"
   ```
2. 使用 [隔离实测 Skill](../codexhost-isolated-testing/SKILL.md) 以独立数据目录与空闲端口启动测试 Web / Desktop（不碰 `~/.codexhost` 与用户正在运行的端口）。
3. 从 Desktop「设置 → 插件」或 Web 一级目录「插件 → 插件中心」导入 `.zip`（或开发期填入本机目录 `localDir`）并启用：
   - 验证能力角标显示准确；含 `widget` 的扩展启用后确认主窗口自动出现挂件，禁用后确认挂件移除且未拦截非挂件区域的点击；
   - 含 `page` 的扩展点击「打开页面」（Desktop 也可从「设置」左侧「插件页面」分组打开，Web 也可从左侧「插件」主工作区顶部切页栏打开）；验证样式、交互、设置持久化与关闭清理；
   - 含 `backend` 的扩展确认共享 Host 仅起 1 个子进程、多标签页/双端共享同一 PID 与数据、禁用后进程立即退出；
   - 纯前端无 `backend` 扩展确认零后端子进程；
   - 如需兜底，可通过管理界面的「禁用全部扩展」（`codexhost/extensions/recover`）一键恢复。
4. 实测完毕按隔离实测 Skill 停止测试服务与测试 Host 并删除临时数据目录。

## 4. 分发与投稿市场

- 推荐使用公开 GitHub Release 附带构建好的 `.zip` 资产（市场索引 `catalog.v2.json` 优先拉取最新正式 Release，无 Release 时兜底默认分支源码），或直接分享 `.zip` / GitHub 仓库链接供用户在「插件」中心导入。
- 完整架构、RPC 与安全边界见 [Host 扩展架构](../../../docs/architecture/desktop-ui-extensions.md)。
