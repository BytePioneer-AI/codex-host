# codexhost 控制台

控制台是一个本地网页，不依赖 Codex Desktop 启动成功。左侧导航分为：

- **总览**：当前状态与下一步操作、codexhost 版本 / Codex Desktop 版本 / 安装方式三个信息框、最近一次启动的结果；失败时说明卡在哪一步和错误原文，内部阶段时间线折叠在“详细信息”中；注入持续失败时显示原因。成功时不展示时间线，不显示启动历史表格。原启动诊断页已合并，旧的 `#diagnostics` 和 `?view=diagnostics` 链接显示总览。日志不在页面中展示，通过“导出诊断包（含日志）”获取。
- **设置**：连接、账号、会话导入、更新，与 Codex 设置页使用同一套页面和 Host 接口。
- **其他**：关于。

外观（思考文本显示、空闲释放）由 Codex 界面保存，只能在 Codex 设置页修改。设计背景见 [`proposals/独立 Web 控制台方案.md`](../proposals/独立%20Web%20控制台方案.md)。

## 打开方式

控制台随 codexhost 启动：

| 启动方式 | 行为 |
|---|---|
| 安装包（macOS 打开应用、Windows 开始菜单） | 先启动控制台并在默认浏览器打开总览，再启动 Codex Desktop；启动失败或注入持续失败时另外打开总览查看原因 |
| 终端（npm 的 `codexhost`、`codexhost launch`、`npm start`） | 控制台在后台与 Codex Desktop 一同启动，启动结束时在终端输出 `codexhost console: http://127.0.0.1:26339/` |

设置 `CODEXHOST_CONSOLE=0` 可关闭以上行为。其他打开方式：

| 方式 | 说明 |
|---|---|
| `codexhost console` | 安装包与 npm 均可用 |
| Windows 开始菜单 | “codexhost console” 快捷方式 |
| Codex 设置页 | “关于”页的“打开控制台”，通过本地 Host 的 `codexhost/console/open` 打开；远程 Host 不支持 |

地址为 `http://127.0.0.1:26339/`。命令会复用已运行的控制台；若端口上的控制台属于另一份安装（例如 npm 与安装包并存），先让旧实例退出再以当前安装启动。控制台不需要登录，直接访问即可。

## 端口

- 默认 `26339`，只监听 `127.0.0.1`。可用 `CODEXHOST_CONSOLE_PORT` 修改（1024–65535）。
- 端口被其他程序占用时直接报错，不自动换端口。
- codexhost 运行期间控制台保持运行；codexhost 未运行时，30 分钟无请求后自动退出，下次打开或启动 codexhost 时重新启动。

## 文件

均位于数据目录（`CODEXHOST_DATA_DIR`，未设置时为 `~/.codexhost`）：

| 文件 | 写入方 | 内容 |
|---|---|---|
| `diagnostics/launcher-startup-v1.json` | Launcher | 最近 10 次启动的阶段时间线、Codex 版本、结果与错误 |
| `diagnostics/desktop-controller-v1.json` | Desktop Controller | Renderer 注入状态：注入中 / 正常 / 失败、当前失败原因、失败次数，以及恢复后仍保留的上次失败原因与时间 |
| `logs/host-runtime-*.log` | Host Runtime | 见 [`host-runtime-log.md`](host-runtime-log.md) |

目录权限 `0700`，文件 `0600`（权限位按平台支持生效）。写入失败不影响启动。

Desktop Controller 在注入失败时仍会让 Codex 正常运行并在后台重试，所以“Codex 打开了但没有 codexhost 功能”时，Launcher 的启动记录显示成功，原因在注入状态文件中。

启动时首次注入可能因 Codex 页面仍在加载而失败一次：注入脚本已登记到页面、加载完成后照常运行，功能不受影响，Controller 在下一次尝试时恢复。因此控制台只在注入持续失败（连续失败 2 次及以上，或失败状态超过 1 分钟）时，在总览显示“codexhost 功能未能加载”，并在同页给出原因；单次早期失败只保留在状态文件和诊断包中。

## 安全

控制台只在本机运行，不设登录。以下检查防止浏览器中打开的其他网站使用它：

- 只接受 `Host` 为 `127.0.0.1:<端口>` 或 `localhost:<端口>` 的请求（防 DNS 重绑定）。
- 启动、更新、修改设置等操作必须携带 `x-codexhost-console: 1` 请求头；来自浏览器的请求还要求 `Origin` 为控制台自身。其他网站无法跨域附加该请求头。
- 页面使用严格 CSP（不允许内联脚本和内联样式）。
- “导出诊断包（含日志）”会把用户主目录替换为 `~`。

## 与运行中的 codexhost 连接

Launcher 启动的本地 Host Runtime 在 `127.0.0.1` 的随机端口开放控制通道，把端口与随机令牌写入 `<数据目录>/console/hosts/host-<进程号>.json`（`0600`），退出时删除。控制台读取该文件，把设置请求转发给 Host，由 Host 按 Codex 设置页相同的逻辑处理；只接受 `CONSOLE_HOST_METHODS` 列出的设置方法，不接受 Thread 或 Turn 操作。

- codexhost 未运行：连接页显示离线的插件列表并可修改安装路径；账号、会话导入提示先启动 codexhost。
- codexhost 运行但控制通道不可用（例如旧版本）：提示重新启动 codexhost。
- 会话导入后的“打开”需在 Codex Desktop 中进行。

## 更新

- codexhost 运行中：通过 Host 的更新流程检查与安装，与 Codex 设置页一致。
- codexhost 未运行：控制台下载并准备更新，拉起 Updater 后退出；Updater 等待控制台进程退出，再按原流程安装并重新启动 codexhost。
- npm 安装需通过 npm 命令启动的控制台（`codexhost`、`codexhost console`，或 Codex 设置页）才能更新，因为更新需要 npm 路径环境变量。
- 源码构建不支持在控制台更新。

## 连接页（codexhost 未运行时）

codexhost 未运行时，“连接”页列出已安装的插件（读取 `manifest.json`，不执行插件代码）及是否启用，并可修改接受自定义安装路径的插件的路径。路径与 Codex 设置页共用 `<数据目录>/harness-launch-settings/<插件>.json`；codexhost 运行中修改时，在重新启动 codexhost 后生效。插件目录与 Host Runtime 一致：发布包的 `app/plugins`，以及 `CODEXHOST_PLUGIN_DIRECTORY` 或 `<数据目录>/plugins`。

## 诊断包与 Issue

- “导出诊断包”下载 JSON：状态、Codex 与 codexhost 版本、最近 5 次启动记录、注入状态，以及最新两个 Host Runtime 日志的末尾 32 KiB。用户主目录替换为 `~`，其他内容（如日志中的项目路径）不做处理，分享前请检查。
- “提交 Issue”打开 GitHub 新建 Issue 页面，预填版本、系统、状态和错误，不包含日志。

## 其他命令

`codexhost inspect --json` 输出 Codex Desktop 安装信息与 Launcher 运行状态；未找到 Codex Desktop 时在 `desktopError` 中说明，不以失败退出。
