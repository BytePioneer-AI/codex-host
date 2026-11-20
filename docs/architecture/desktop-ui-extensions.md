# Desktop 界面扩展（v1）

Desktop 界面扩展是可选的受信任代码。它们只在通过 codexhost 启动、已建立界面控制的 Codex Desktop **主窗口**运行。扩展不预装，发现时不执行；在 [Console 的扩展页](../operations/codexhost-console.md)启用后才加载。Web、其他 Desktop 窗口和远程 Host 的侧栏行不是 v1 的扩展目标。

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

- `id` 最长 128 字符，匹配 `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`。`desktop.style` 可省略。未知字段或槽位无效；更高的 `desktopApi` 或出现 `backend` 时报告不兼容。
- 新扩展必须为 `name` 和 `description` 提供 `en` 和 `zh-CN` 文案。兼容旧 manifest：`name` 可用纯字符串；`description` 可省略或只提供 `en`。名称去掉首尾空白后须为 1–128 字符，描述每种语言最多 4096 字符。列表接口保留双语对象；`resolveLocalizedExtensionText(value, locale)` 在 `zh-CN` 时优先取中文，缺少中文或使用其他语言时取英文，字符串则原样返回。
- `categories` 是可选多选标签，省略或 `[]` 均表示未分类。可选值为 `sidebar`（侧栏）、`composer`（输入区）、`conversation`（会话）、`appearance`（外观）、`tools`（工具）、`workflow`（工作流）、`usage-analytics`（用量分析）、`memory-knowledge`（记忆与知识）、`integrations`（外部集成）。未知或重复标签使 manifest 无效。标签不授予 API 能力，不参与槽位占用。
- `author`、`repository` 和 `details` 是可选展示字段。作者名去掉首尾空白后为 1–128 字符；仓库链接限 HTTP(S)、至多 2048 字符，推荐 GitHub HTTPS 链接；详细介绍支持多段落，`en` 必填、`zh-CN` 可选，每种语言最多 16384 字符。
- 资源必须解析到扩展目录内的普通文件。POSIX 上，扩展根、扩展目录、资源经过的子目录和文件须归当前用户所有，且不能允许同组或其他用户写入。新建目录建议使用 `0700`。
- `screenshots` 可选，最多 4 个不重复的相对路径（以 `/` 分隔；路径段不得以点或空格结尾）。只接受 `.png`、`.jpg`、`.jpeg`、`.webp`（扩展名不区分大小写），文件签名必须与扩展名匹配，每张最多 512 KiB，每扩展合计最多 2 MiB。缺失、越界、超限或类型不符会将扩展标为无效，并报告具体截图及原因。有效扩展的 `screenshotDataUrls` 按 `manifest.screenshots` 顺序返回，可直接作为 `<img src>`，不需要文件 URL 或额外网络请求。每次管理列表最多包含 8 MiB 原始截图（base64 编码前），按扩展目录名排序分配；剩余预算不足时省略该扩展的整组预览，给出列表诊断，不影响扩展状态。截图字节不参与热更新 hash 或注入快照。
- 文件上限：manifest 128 KiB、脚本 2 MiB、样式 256 KiB。最多发现 64 个扩展，单次注入的快照最多 8 MiB。

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

## 槽位与回收

`sidebar.thread-badge` 用于装饰 Thread 行（角标、计数等），`sidebar.thread-layout` 用于改变 Thread 行呈现。扩展必须在 manifest 声明占用的槽位，全部获得后才能生效。Console 在启用前拒绝冲突并列出占用者；手动编辑产生冲突时，`enabled` 中靠前的扩展优先。

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

v1 不提供扩展后端、Web 扩展支持、多窗口或远程 Host 行扩展。`backend`、`desktopApi: 2` 和 `codexhost/extension/<id>/*` 仅为后续版本预留；v1 不加载后端、不注册这些方法。
