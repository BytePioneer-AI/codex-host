# Desktop 界面扩展（v1）

Desktop 扩展是可选的受信任代码。界面入口只在通过 codexhost 启动、已建立界面控制的 Codex Desktop **主窗口**运行；可选的 Node 后端运行于本机 Host 启动的独立子进程。扩展不预装，发现和安装不执行入口；在 [Console 的扩展页](../operations/codexhost-console.md)启用后才会加载。Web、其他 Desktop 窗口和远程 Host 的侧栏行不是 v1 的界面扩展目标。

启用、禁用和更新文件不重启 Desktop、不重载窗口。Controller 比较 manifest、脚本和样式的内容 hash；只改时间戳不重新激活，内容变化时先回收旧实例再启动新实例。文件监听用于加速，Controller 也会重新扫描（周期兜底为 30 秒）。窗口重载时，如果 Controller 在线，就按最新启用集合恢复；如果 Controller 离线，重载后的窗口不加载扩展，直到 Controller 重新连上并按最新配置对账。对于尚未重载的窗口，Controller 重新连接时保留 hash 未变且仍在运行的实例。

## 安装目录和 manifest

```text
$CODEXHOST_DATA_DIR/desktop-extensions/  # 默认 ~/.codexhost/desktop-extensions/
  enabled.json                          # 管理入口写入；缺失或损坏时不启用任何扩展
  sidebar-thread-tree/                  # 必须是实际目录，目录名与 id 一致
    manifest.json
    desktop.js
    desktop.css                          # 可选
    images/sidebar.png                   # 可选，以 manifest 中的相对路径为准
```

`desktop-extensions/` 独立于 Harness 插件目录，也不扫描 Pi Adapter 使用的 `extensions/`。`enabled.json` 保存启用顺序和配置版本；Console 和本机 Host 设置 RPC 共用修订号并通过原子替换更新它。复制或构建扩展不会修改该文件。文件尚未生成是正常初始状态，不显示诊断；配置存在但无效时报告原因。Web 设置连接必须通过身份验证且同源，只能管理该 Web 服务的本机 Host 上的 Desktop 扩展，不会在 Web 里运行扩展。

```json
{
  "manifestVersion": 1,
  "id": "sidebar-thread-tree",
  "name": { "en": "Sidebar Thread Tree", "zh-CN": "侧栏委派树" },
  "version": "0.1.0",
  "description": { "en": "Groups delegated Threads", "zh-CN": "归组委派的 Thread" },
  "author": "codexhost",
  "repository": "https://github.com/BytePioneer-AI/codex-host",
  "details": {
    "en": "Expand a parent Thread to see its delegated work.\n\nOnly local sidebar rows are affected.",
    "zh-CN": "展开父 Thread，查看委派的工作。\n\n仅影响本机侧栏行。"
  },
  "desktopApi": 1,
  "desktop": { "script": "desktop.js", "style": "desktop.css" },
  "slots": ["sidebar.thread-badge", "sidebar.thread-layout"],
  "categories": ["sidebar", "workflow"],
  "screenshots": ["images/sidebar.png"]
}
```

- `id` 最长 128 字符，匹配 `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`。`desktop` 和 `backend` 至少声明一个，可以同时声明；`desktop.style` 可省略。未知字段或槽位无效；更高的 `desktopApi` 报告不兼容。
- 新扩展必须为 `name` 和 `description` 提供 `en` 和 `zh-CN` 文案。兼容旧 manifest：`name` 可用纯字符串；`description` 可省略或只提供 `en`。名称去掉首尾空白后须为 1–128 字符，描述每种语言最多 4096 字符。列表接口保留双语对象；`resolveLocalizedExtensionText(value, locale)` 在 `zh-CN` 时优先取中文，缺少中文或使用其他语言时取英文，字符串则原样返回。
- `categories` 是可选多选标签，省略或 `[]` 均表示未分类。可选值为 `sidebar`（侧栏）、`composer`（输入区）、`conversation`（会话）、`appearance`（外观）、`tools`（工具）、`workflow`（工作流）、`usage-analytics`（用量分析）、`memory-knowledge`（记忆与知识）、`integrations`（外部集成）。未知或重复标签使 manifest 无效。标签不授予 API 能力，不参与槽位占用。
- `author`、`repository` 和 `details` 是可选展示字段。作者名去掉首尾空白后为 1–128 字符；仓库链接限 HTTP(S)、至多 2048 字符，推荐 GitHub HTTPS 链接；详细介绍支持多段落，`en` 必填、`zh-CN` 可选，每种语言最多 16384 字符。
- 资源必须解析到扩展目录内的普通文件。POSIX 上，扩展根、扩展目录、资源经过的子目录和文件须归当前用户所有，且不能允许同组或其他用户写入。新建目录建议使用 `0700`。
- `screenshots` 可选，最多 4 个不重复的相对路径（以 `/` 分隔；路径段不得以点或空格结尾）。只接受 `.png`、`.jpg`、`.jpeg`、`.webp`（扩展名不区分大小写），文件签名必须与扩展名匹配，每张最多 512 KiB，每扩展合计最多 2 MiB。缺失、越界、超限或类型不符会将扩展标为无效，并报告具体截图及原因。有效扩展的 `screenshotDataUrls` 按 `manifest.screenshots` 顺序返回，可直接作为 `<img src>`，不需要文件 URL 或额外网络请求。每次管理列表最多包含 8 MiB 原始截图（base64 编码前），按扩展目录名排序分配；剩余预算不足时省略该扩展的整组预览，给出列表诊断，不影响扩展状态。截图字节不参与热更新 hash 或注入快照。
- 文件上限：manifest 128 KiB、脚本 2 MiB、样式 256 KiB。最多发现 64 个扩展，单次注入的快照最多 8 MiB。

## 市场与包管理

市场后端默认读取独立索引库的 `main/catalog.json`，GitHub Raw 不可用时尝试 jsDelivr；两者均不可用时返回两条内置官方元数据。进程内缓存 5 分钟；`CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL` 可改为 HTTP(S) 地址或本地绝对路径。详见[独立索引库模板](../../registry/desktop-extensions/README.md)。官方种子 ZIP 在索引库首次发布资产后可下载。

索引条目可包含可选的 `downloads`（非负整数）。配置 `CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL` 后，Host／Console 只在从索引成功安装后异步向计数服务发送一次扩展 ID（含重装和更新），不发送账号或设备标识；上报失败不影响安装。索引定时合并计数，缺失时不补零。Worker 部署和免费额度限制见上面的索引库模板。

本机 Host RPC 前缀为 `codexhost/desktop/extensions/`，Console 使用下表中的 HTTP 路径。两者共享包管理逻辑；Console 操作请求须通过现有同源检查并带 `X-Codexhost-Console: 1`。

| RPC | Console | 请求 → 响应 |
| --- | --- | --- |
| `catalog` | `GET /api/extensions/catalog?forceRefresh=true` | `{ forceRefresh?: boolean }` → `{ catalogUrl, source: "remote" \| "fallback", fetchedAt, cached, extensions, error? }` |
| `install` | `POST /api/extensions/install` | `{ source }` → `{ extensionId, version, replaced, installedPath, list }` |
| `uninstall` | `POST /api/extensions/uninstall` | `{ id }` → `{ removedId, list }` |

- 安装来源：`{ type: "catalog", id }`、`{ type: "url", url, expectedSha256? }` 或 `{ type: "zip-base64", fileName, contentBase64 }`。URL 支持 HTTP(S) `.zip`、GitHub zipball，以及公开 GitHub 仓库主页（优先取最新稳定 Release 的 ZIP 资产，没有则取默认分支的源码 zipball）。`/tree/<ref>[/<subdir>]` 直接取指定 ref 的 zipball，安装所选目录；ref 内的 `/` 写作 `%2F`。从索引安装会校验 SHA-256、manifest ID 和版本。上传文件名仅用于元数据，不用作磁盘路径。
- ZIP 防内存耗尽护栏：压缩 ≤ 64 MiB、展开 ≤ 256 MiB，最多 10,000 个条目；大文件另检查异常压缩比。`manifest.json` 应位于 ZIP 根目录、唯一顶层目录或 `tree` 选中的仓库子目录。必须包含 manifest 声明的入口 JS；包管理不构建或执行脚本，安装后仍须显式启用。
- 更新调用同一个 `install`，按 manifest ID 覆盖，保留已有启用选择。卸载移除安装目录和 `enabled.json` 中的选择，不删除独立设置。两者都通过原子写入 `enabled.json` 触发对账，不重载窗口。响应中的 `list` 是最新磁盘快照，`status` 仍反映 Desktop 界面入口，不报告 Node 后端激活结果。
- UI 可用 `compareExtensionVersions(catalogVersion, installedVersion) > 0` 判断是否有新版本。不识别的版本格式不提示更新。不自动更新本机安装；`trustTier` 和 `minCodexHostVersion` 是索引展示元数据，不是权限或兼容性证明。

## Desktop API v1

脚本是一个经典 JavaScript 文件，不是 ESM 入口。加载时同步调用一次 `define({ activate(api) { … } })`。`activate` 可返回清理函数，也可返回解析为清理函数或 `void` 的 Promise。激活超时为 5 秒。TypeScript 类型见 [`shared-contracts`](../../packages/shared-contracts/src/desktop-extensions.ts)。

| API                                                    | 用途                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.id`、`api.apiVersion`、`api.signal`               | 当前扩展的身份、API 版本与卸载信号。给 `addEventListener` 传 `{ signal: api.signal }`。                                                                                         |
| `sidebar.observeRows(cb)`                              | 提供当前行列表并观察变化；行包含 `element`、`hostId`、`isLocal`、`threadId`、`draftId`、`isConnected()`。先过滤 `!row.isLocal`、无 Thread 的草稿行和已断开的行。返回取消函数。  |
| `threads.watchTree(cb)`                                | 订阅本机 [Thread 树快照](web-thread-tree.md)，同一窗口内的扩展共享一条订阅。读到的状态以执行所有者为准；`unknown` 不是 `idle`，`truncated` 表示快照缺少部分节点。返回取消函数。 |
| `navigate.openThread(threadId)`                        | 走 Desktop 原生导航打开本机 Thread；未知或远程 Thread 会被拒绝。                                                                                                                |
| `harnesses.describe(harnessId)`                        | 读取本机 Harness 目录缓存中的 `name`、可选 `icon`；未缓存时可返回 `undefined`。                                                                                                 |
| `dom.mount(node, target, position?)`                   | 挂载扩展创建的元素。支持 `append`（默认）、`prepend`、`before`、`after`。                                                                                                       |
| `dom.mark(element, name)`、`dom.unmark(element, name)` | 给元素登记或移除 `data-cx-<id>-<name>` 标记；`name` 匹配 `[a-z][a-z0-9-]{0,31}`。                                                                                               |
| `track(teardown)`                                      | 登记额外的同步清理函数，例如停止定时器。                                                                                                                                        |

## 资源、设置与后端 RPC

以下方法使用 `codexhost/desktop/extensions/` 前缀。它们通过本机 Host 的 Desktop RPC 和已认证的本机 Web Client Channel 提供；SSH 管理的 Host 不开放这些方法。Renderer 扩展 API 和设置界面不在此契约内。

| 方法后缀 | 请求 → 响应 |
| --- | --- |
| `asset` | `{ id, path }` → `{ mimeType, dataUrl }` |
| `settings/get` | `{ id }` → `{ values }` |
| `settings/set` | `{ id, values }` → `{ values }` |
| `backend/invoke` | `{ id, method, params? }` → `{ result }` |

- **资源**：可以把壁纸、字体等放在 `assets/`，无需在 manifest 登记。传入相对安装目录的 `/` 分隔路径，禁止绝对路径、`..` 或经符号链接越界。支持 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.svg`、`.woff2`、`.json`、`.css`，每文件最多 16 MiB。结果为 `data:<mime>;base64,...`；SVG 用于图片，不内联 SVG 标记或将其作为页面打开。
- **声明式设置**：`settingsSchema` 最多 32 项。每项有唯一的 `key`（`[A-Za-z_][A-Za-z0-9_]*`）、`type`、双语 `label`、可选双语 `description`。五类字段为 `boolean`、`string`（可选双语 `placeholder`）、`number`、`range`（必填 `min`、`max`）、`select`（`options: [{ value, label }]`）。都可声明相应类型的 `default`；详情见共享契约。
- **持久化**：资源和设置允许对已安装但未启用的扩展读取；设置也可在启用前写入。`values` 是 JSON 对象；`set` 原子替换整份对象，不合并、不应用默认值、不按 `settingsSchema` 过滤，也不推送变更事件。设置最多 1 MiB，保存到 `$CODEXHOST_DATA_DIR/desktop-extension-data/<id>/settings.json`；初始返回 `{}`。覆盖安装、卸载都保留它，重新安装同 ID 可恢复配置；需要清理时先卸载，再手动删除该扩展的数据目录。
- **Node 入口**：如 `"backend": { "script": "backend.mjs" }`。入口必须在扩展目录内、至多 2 MiB，由扩展自行提供运行依赖。导出 `activate(ctx)` 或 `default.activate(ctx)`；通过 `ctx.handle(method, handler)` 在激活期间登记方法。`ctx.extensionId`、`ctx.extensionDir`、`ctx.dataDir` 提供身份与路径；`ctx.readSettings()` / `ctx.writeSettings(values)` 复用独立设置存储。可返回清理函数或 `{ dispose() }`，支持异步。
- **生命周期**：Host 启动、启停、覆盖安装、卸载和恢复时对账；Console 独立写入的启用配置也会被轮询发现。覆盖安装或入口变化时先清理旧实例，再用新子进程和带内容 hash 的入口 URL 加载。手动编辑代码时，修改入口或 manifest 可触发重载；仅编辑依赖文件请重新打包安装。只允许对已启用、已取得槽位且激活成功的扩展调用已登记方法。参数和结果均为 JSON，`undefined` 返回为 `null`；无效参数为 `-32602`，加载/运行失败或方法不可用时返回 `-32000`。激活、调用和清理都有超时；异常和子进程退出不会终止 Host。失败的实例可通过禁用再启用或更新重试。

**进程隔离不是权限沙箱。** 后端以本机用户权限执行；启用或覆盖安装已启用的扩展前，应信任包括 Node 入口在内的全部代码和依赖。后端失败记录在 Host 诊断日志中，不等同于 Renderer 状态。

## 槽位与回收

`sidebar.thread-badge` 用于装饰 Thread 行（角标、计数等），`sidebar.thread-layout` 用于改变 Thread 行呈现，`appearance.theme` 用于整套皮肤，同一时间只分配给一个扩展。只声明实际使用的槽位；没有槽位就省略或写 `[]`。扩展全部取得所声明槽位后才能生效。Console 在启用前拒绝冲突并列出占用者；手动编辑产生冲突时，`enabled` 中靠前的扩展优先。

卸载时，宿主停止交付回调并取消待完成的导航，给扩展最多 1 秒自行清理，然后触发 `api.signal`、停止观察与订阅、执行 `track` 清理、移除受管挂载和样式表、恢复受管标记。不提供清理函数也能回收这些资源。激活异常或 30 秒内五次桥回调异常会标记为 `failed` 并回收当前实例，不改启用选择；更新文件或重载窗口可再试。Console 结合 `diagnostics/desktop-extensions-v1.json` 显示状态，Controller 不在线时显示等待 Desktop。

**API 是稳定性边界，不是沙箱。** 扩展与 Desktop 同处一个页面，只启用你信任的代码。宿主不承诺撤销扩展直接修改原生节点、全局对象或打补丁的副作用，也不开放通用 Host RPC、Composer 写入、React fiber、原生 RPC 对象或子进程；扩展不改变 Thread 执行、归属、置顶或归档。

## 作者指南

1. 从仓库中的[角标](../../packages/desktop-extensions/sidebar-delegation-badges)或[委派树](../../packages/desktop-extensions/sidebar-thread-tree)样板开始。角标在父行显示子 Thread 数量与最紧急状态，点开可导航；委派树同时占用两个槽位，在每个列表内归组并显示子 Thread 和实时活动，因此两个样板不能同时启用。
2. 写 `manifest.json`、`src/index.ts`，需要样式时加 `src/desktop.css` 并在 manifest 声明。仓库样板源码只导入包内相对路径与 `@codexhost/shared-contracts`，不导入 Node 内置模块或 Harness SDK。用 `dom.mount` 挂载自有节点，用 `dom.mark` 加扩展 CSS 隐藏或装饰原生行，**不要直接改原生元素的 `style` 或 `class`**。若 id 含 `.` 或 `_`，生成选择器用 `CSS.escape` 转义完整属性名，例如 `` `[${CSS.escape(`data-cx-${api.id}-hidden`)}]` ``；手写 CSS 可写 `[data-cx-example\.tree\_v1-hidden]`。
3. 在仓库根构建，**直接输出到目标扩展目录，不要用符号链接**。下面的根路径须与运行中的 Console 和 Desktop 使用的数据目录一致：

   ```bash
   npx tsc -b packages/harness-plugin-files
   node tools/build-desktop-extension.mjs \
     packages/desktop-extensions/sidebar-thread-tree \
     "${CODEXHOST_DATA_DIR:-$HOME/.codexhost}/desktop-extensions"
   ```

   工具验证生成的 manifest，并将其与单文件 `desktop.js`、声明的 `desktop.css`、校验通过的截图写到 `<扩展根>/<id>/`。截图在源码根中与 manifest 声明路径一致，打包时保留相对路径。不写入其他运行依赖。重新构建可触发热更新。

4. 打开 Console 的扩展页启用并查看状态。验证禁用后恢复原生行、更新后不留旧实例，以及远程 Host 行不受影响。依赖的私有 DOM 锚点不存在时应安全降级。

## 恢复与 v2 预留

如果扩展使 Desktop 无法操作，在 Console 执行「禁用全部扩展并重载」。Console 原子写入空的启用列表和新的恢复令牌；在线 Controller 移除未来文档快照，尽力回收当前实例，再重载窗口。该路径不依赖 Host 或 Desktop 界面响应。若 Controller 离线，选择仍会保存；若 Controller 看到该令牌时已有更新的非空启用列表，则只记录该令牌，不重载。

v1 不支持 Web 界面扩展、多窗口或远程 Host 行扩展。`desktopApi: 2` 和 `codexhost/extension/<id>/*` 尚未定义。
