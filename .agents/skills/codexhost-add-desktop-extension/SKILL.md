---
name: codexhost-add-desktop-extension
description: 开发、打包、验收或排查 codexhost Desktop 扩展：侧栏、全皮肤、静态资源、声明式设置与可选 Node 后端。不用于接入 Harness、编写 Web 插件或改变 Thread 行为。
---

# 新增 codexhost Desktop 扩展

目标：交付一个能独立安装、热启停、完整卸载的可信扩展。路径以仓库根目录为基准；字段、签名以 [`packages/shared-contracts/src/desktop-extensions.ts`](../../../packages/shared-contracts/src/desktop-extensions.ts) 为准。

| 需求                                                        | 改动位置                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| 本机侧栏、全皮肤或带设置的 Desktop 工具                       | Desktop 扩展，默认只改扩展自己的目录              |
| 接入 Agent Harness，提供 Session 执行、历史、模型或账号能力 | [Harness 插件](../codexhost-add-harness/SKILL.md) |
| 改变 Thread 归属、执行、持久化，或增加通用宿主原语          | 在主干设计公共能力，不在扩展里绕过 API            |

## 1. 声明扩展元数据和槽位

在扩展自己的仓库中准备源码目录 `<source-dir>`：在根放 `manifest.json`，入口放 `src/index.ts`，可选样式放 `src/desktop.css`。安装目录是 `$CODEXHOST_DATA_DIR/desktop-extensions/<id>/`，内有 `manifest.json`、`desktop.js`、可选 `desktop.css`。目录名与 `id` 一致；复制文件不等于启用。

```json
{
  "manifestVersion": 1,
  "id": "example.tree_v1",
  "name": { "en": "Example Thread Tree", "zh-CN": "示例委派树" },
  "version": "0.1.0",
  "description": { "en": "Groups delegated Threads", "zh-CN": "归组委派的 Thread" },
  "details": {
    "en": "Expand a parent Thread to see its delegated work.\n\nOnly local sidebar rows are affected.",
    "zh-CN": "展开父 Thread，查看委派的工作。\n\n仅影响本机侧栏行。"
  },
  "desktopApi": 1,
  "desktop": { "script": "desktop.js", "style": "desktop.css" },
  "slots": ["sidebar.thread-layout"],
  "categories": ["interface", "workflow"],
  "icon": "images/logo.png",
  "screenshots": ["images/sidebar.png"]
}
```

新扩展的 `name` 和 `description` **必须各自提供非空的 `en` 和 `zh-CN` 文案**，方便用户切换中英文界面。旧 manifest 的字符串名称和不完整的描述仅用于兼容。

- `author` 可选，去掉首尾空白后为 1–128 字符。`repository` 可选，只接受 `http://` 或 `https://` URL（至多 2048 字符），推荐填写公开的 GitHub 仓库 HTTPS 链接。
- 推荐填写双语 `details`（`{ en, "zh-CN" }`），详情弹窗会按**安全子集 Markdown** 渲染：支持 `#` / `##` / `###` 标题、无序/有序列表、`**加粗**`、`*斜体*`、`` `行内代码` ``、```` ``` ```` 围栏代码块、`>` 引用块以及 `http://` / `https://` 链接（非法协议与原始 HTML 会安全降级为纯文本）。提供时 `en` 必填，`zh-CN` 可省略，每种语言最多 16384 字符；写清用途、操作和适用范围。
- **强烈推荐**在 `manifest.json` 中附带 `screenshots`（1–4 张界面截图，详情弹窗会自动展示截图画廊并支持点击大图预览）。将图片放在 `<source-dir>/` 下，如 `images/sidebar.png`，与示例路径一致；暂时没有截图时可省略字段。最多 4 张、不重复，每张 ≤ 512 KiB，只能用 PNG、JPEG（`.jpg` / `.jpeg`）或 WebP，扩展名须匹配文件签名。使用 `/` 分隔路径，不用绝对路径、`..`、以点或空格结尾的路径段或指向目录外的链接。工具会校验并原样复制，管理列表提供 `screenshotDataUrls` 供 `<img>` 使用。

- `icon` 是可选的 Logo 文件路径，推荐正方形 PNG 或 WebP，文件 ≤ 128 KiB。支持的格式、相对路径和签名规则与 `screenshots` 相同。不填时，设置页按分类自动展示与界面协调的矢量图标（由设置页实现）。

`categories` 是可选的多选标签。只选能说明扩展主要用途的项，允许跨类但不能重复；没有适合的标签时省略或填 `[]`。标签只用于归类，不授予 API 能力，也不参与槽位互斥。六个预置值如下：

| 标签 | 用途 |
| --- | --- |
| `appearance` | 外观主题：皮肤、样式、排版或视觉密度 |
| `interface` | 界面增强：侧栏、输入区或会话界面的操作与展示 |
| `workflow` | 效率与协作：任务流转、委派或跨 Thread 协作 |
| `analytics` | 数据与统计：用量、成本、额度或趋势分析 |
| `integrations` | 外部集成：外部工具、服务或工作空间 |
| `tools` | 实用工具：辅助操作、记忆、笔记或知识检索 |

`sidebar.thread-badge` 用于角标与计数，`sidebar.thread-layout` 用于改变行布局，`appearance.theme` 用于整套皮肤（同一时间只能启用一套）。只声明实际使用的槽位；纯工具或后端可省略 `slots` 或填 `[]`。扩展必须取得全部声明的槽位才会激活。没有样式时省略 `desktop.style`；纯后端可省略 `desktop`，但至少声明 `desktop` 或 `backend` 之一。

完成条件：manifest 通过 v1 schema；名称和描述均有中英文文案；标签与用途相符，目录名、入口和槽位与实际产物一致；声明的 Logo 和截图均通过打包校验。

## 2. 实现所声明的入口

纯后端跳过 `define`，直接看下方的 Node 入口。界面入口的构建产物为经典 JavaScript，不是 ESM 入口；脚本加载时同步调用一次 `define`。`activate` 可返回清理函数，也可以异步返回清理函数或 `void`。用下列原语实现，不接入私有 React 对象、通用 Host RPC 或原生进程。

最小 TypeScript 入口（`src/index.ts`）：

```ts
import type { DesktopExtensionDefine } from "@codexhost/shared-contracts";

declare const define: DesktopExtensionDefine;
define({ activate() {} });
```

| v1 原语                                                            | 用法                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `api.sidebar.observeRows(cb)`                                      | 观察行；跳过 `isLocal === false`、没有 `threadId` 的草稿行和已断开的行。返回取消函数。               |
| `api.threads.watchTree(cb)`                                        | 订阅本机 Thread 树；正确处理 `unknown` 和 `truncated`，不要把它们当作空闲或完整快照。返回取消函数。  |
| `api.navigate.openThread(threadId)`                                | 原生导航；只接受本机 Thread。                                                                        |
| `api.harnesses.describe(harnessId)`                                | 从本机 Harness 目录缓存读名称和可选图标；处理 `undefined`。                                          |
| `api.dom.mount(node, target, position?)`                           | 受管挂载扩展自建节点；位置为 `append`、`prepend`、`before` 或 `after`。                              |
| `api.dom.mark(element, name)` / `api.dom.unmark(element, name)`    | 添加或移除受管标记 `data-cx-<id>-<name>`。                                                           |
| `desktop.style`                                                    | 通过 manifest 声明样式表，由宿主管理安装与移除；没有运行时 `api.dom.style`。                         |
| `api.id` / `api.apiVersion` / `api.signal` / `api.track(teardown)` | 读取身份和版本；给事件监听器传 `{ signal: api.signal }`；用 `track` 登记定时器等额外资源的同步清理。 |

- 只用 `dom.mark` + 扩展样式表装饰或隐藏原生行；绝不直接写原生行的 `style` 或 `class`。ID 含 `.` 或 `_` 时用 `CSS.escape` 转义完整属性名，例如 `` `[${CSS.escape(`data-cx-${api.id}-hidden`)}]` ``；静态 CSS 使用等价转义，如 `[data-cx-example\.tree\_v1-hidden]`。
- `src` 只能导入扩展包内的相对路径和 `@codexhost/shared-contracts`。遵守 Desktop CSP，不能用 `eval` 或 `new Function`。
- API 是稳定性边界而不是沙箱；只安装信任的代码。锚点没有出现时安全降级。

完成条件：远程行不受影响；禁用时原生行恢复，扩展节点、监听器、订阅和定时器均被回收。

### 全皮肤、设置与 Node 入口

- **静态资源**：把壁纸、字体等放在包内，如 `assets/wallpaper.webp`。通过 Host `asset` RPC 传相对路径并读取 `dataUrl`；原样打包，不需要 `assets` manifest 字段。不要把 SVG 内容挂成 HTML。
- **设置**：在 `settingsSchema` 声明唯一标识符 `key`、双语 `label` 和字段类型（`boolean`、`string`、`number`、`range`、`select`）；例如用 `range` 表达壁纸模糊度。保存时提交整份 JSON 对象。默认值是 UI 元数据，不会自动写入。Host 在安装目录之外持久化，覆盖安装和卸载都保留设置。
- **Node 入口**：声明 `"backend": { "script": "backend.mjs" }`，将构建好的 JS 与依赖一起打包。导出 `activate(ctx)` 或 `default.activate(ctx)`；在激活时用 `ctx.handle` 登记方法，用 `ctx.readSettings` / `ctx.writeSettings` 访问配置。返回清理函数或 `{ dispose() }` 以释放资源。后端只在启用且取得槽位时加载，运行在本机用户权限的独立子进程中，不是沙箱。

- **Renderer 侧新 API（v1 已上线）**：
  - `api.assets.readDataUrl(relativePath)`：读取包内静态资源并返回 `{ mimeType, dataUrl }`（单文件 ≤ 16 MiB，适合全皮肤壁纸/字体）。
  - `api.storage.get()` / `api.storage.set(values)` / `api.storage.onChange(cb)`：读写独立持久化的扩展设置并订阅实时变更。
  - `api.backend.invoke(method, params?)`：调用本扩展在 Host 子进程中通过 `ctx.handle(method, fn)` 注册的后端方法。
  - `api.settings.registerPage({ title?, icon?, mount(container, ctx) })`：在设置页左侧「插件设置」分组中注册最多 1 个自定义页面（禁用/卸载自动注销）；若仅需轻量表单，可直接在 `manifest.json` 声明 `settingsSchema` 由宿主自动渲染。

字段、大小限制和四个 [Host RPC](../../../docs/architecture/desktop-ui-extensions.md#资源设置与后端-rpc) 以契约为准。

完成条件：资源可从实际安装包读取；改写设置后覆盖安装仍可读回；已登记的方法可调用，禁用后不可调用，重载前完成旧实例清理。

## 3. 构建、隔离验收与恢复

1. 用 [隔离实测 Skill](../codexhost-isolated-testing/SKILL.md) 选取单独的数据目录，在同一工作树以该目录运行 Desktop 和 Console。先确认允许启动测试 Desktop，且不会占用正在使用的端口或数据目录。
2. 在仓库根直接构建到扩展根，不用符号链接：

   ```bash
   : "${CODEXHOST_DATA_DIR:?请先设置独立的测试数据目录}"
   : "${EXTENSION_SOURCE_DIR:?请先设置扩展源码目录}"
   npx tsc -b packages/harness-plugin-files
   node tools/build-desktop-extension.mjs "$EXTENSION_SOURCE_DIR" \
     "$CODEXHOST_DATA_DIR/desktop-extensions"
   ```

   此工具只构建界面入口和样式，并原样复制声明的 Logo 和截图。含后端或其他资源时，自行构建并按 manifest 的相对路径放入 ZIP，再通过 Console 安装。安装不启用新扩展；目录和文件须归当前用户所有，不允许同组或其他用户写入。

3. 在 Console 的扩展页启用。确认从等待进入运行中；重复构建一次确认热更新且没有旧实例；禁用后原生行恢复。验证远程行不变；用另一个声明同一槽位的测试扩展验证冲突提示包含占用者。记录实际验证范围。
4. 看不到扩展时，核对数据目录、目录名、manifest 与权限。等待状态时确认 Desktop 主窗口已建立界面控制；失败时先看状态原因和声明的文件，修复后重新构建。若 Desktop 无法操作，在独立的 **Console → 扩展** 选择「禁用全部扩展并重载 Desktop」；选择会立即保存，有在线 Controller 时才执行窗口重载。

完成条件：报告构建产物位置、启停/热更新/冲突结果，以及未验证项。

## 4. 通过 GitHub 分发与投稿官方市场

**推荐通过 GitHub Release 管理正式版本**：
- **Release ZIP（推荐）**：将 `manifest.json`、构建好的 `desktop.script` / `backend.script`、样式、Logo、截图及其他静态资源打包为 `.zip` 附在公开正式 Release 下；若声明了 `icon` 或 `screenshots`，还须将对应图片作为同名单独资产上传到同一 Release（且与 ZIP 内字节一致）。官方市场与用户安装都会**优先使用最新公开正式 Release**（自动跳过 `draft` 和 `prerelease`），便于把日常开发提交与稳定发版隔离开。
- **默认分支源码（无 Release 时兜底）**：若仓库尚未发布带 `.zip` 资产的 Release，可将上述构建产物直接提交到默认分支根目录，市场和直接安装会兜底拉取默认分支最新 commit（不负责编译 `.ts`）。扩展放在仓库子目录时，直接分享 `/tree/<ref>/<subdir>` 链接可手动安装，但官方市场索引只接受仓库主页。

**投稿到官方插件市场（`BytePioneer-AI/codexhost-extensions-registry`）与后续更新**：
1. 打开 [投稿表单（GitHub Issue Form）](https://github.com/BytePioneer-AI/codexhost-extensions-registry/issues/new/choose) 填写你的公开 GitHub 仓库地址（或直接向 `sources.json` 提交 PR）。
2. 仓库 Actions 会自动校验 `manifest.json`、双语字段、Logo/截图与静态安全检查并生成审核 PR；维护者首次审核合并后即上架。
3. **后续更新无需再提 Issue 或 PR**：版本号完全由作者在 `manifest.json` 中自行定义与递增（包内容变化时须递增 `version`，不允许降级或同版本改包）。市场会按「优先最新正式 Release、无 Release 才看默认分支源码」的规则自动检测更新：Worker 无状态巡检约 **每 5 分钟** 检查一次包地址变化，发现新版本后自动触发校验、更新 `catalog.json` 并刷新 jsDelivr 缓存（另保留每 30 分钟的定时同步作为兜底）。
4. 注意：一旦仓库发布过带 `.zip` 的正式 Release，后续更新请继续通过发布新 Release 完成；仅推送默认分支不会覆盖已有的 Release 版本。

完成条件：确认选中的 Release `.zip` 或 GitHub 默认分支目录同时包含 manifest 和声明的构建后入口 JS，安装时不需要构建。

更多约束见 [Desktop 界面扩展](../../../docs/architecture/desktop-ui-extensions.md)。
