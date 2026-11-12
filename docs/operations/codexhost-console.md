# codexhost 控制台

控制台是一个本地网页，不依赖 Codex Desktop 启动成功。左侧导航分为：

- **总览**：当前状态与下一步操作、codexhost 版本 / Codex Desktop 版本 / 安装方式三个信息框、最近一次启动的结果；失败时说明卡在哪一步和错误原文，内部阶段时间线折叠在“详细信息”中；注入持续失败时显示原因。成功时不展示时间线，不显示启动历史表格。原启动诊断页已合并，旧的 `#diagnostics` 和 `?view=diagnostics` 链接显示总览。日志不在页面中展示，通过“导出诊断包（含日志）”获取。
- **设置**：连接（Harness）、其他电脑（SSH）、手机与浏览器（连接设备）、账号、用量统计、更新。Harness、SSH、账号、用量与更新沿用 Codex 设置页和 Host 接口；会话导入请使用会话 Web，不在控制台提供重复入口。连接页支持通过运行中的本地 Host 安装 Harness CLI、检查版本和更新，复用安装进度、错误提示及安装后检测；不支持远程 Host 安装。WorkBuddy 仍通过官网手动下载安装桌面应用。Host 不可用时不提供一键安装。
- **其他**：关于。

外观（思考文本显示、空闲释放）由 Codex 界面保存，只能在 Codex 设置页修改。设计背景见 [`proposals/独立 Web 控制台方案.md`](../proposals/独立%20Web%20控制台方案.md)。

## 项目公告

Web 控制台在所有页面的内容区顶部显示仓库 `main` 分支的 [`docs/NOTICE.md`](../NOTICE.md)。只影响 Web，不改变 Codex 内置设置。控制台服务通过固定的 GitHub Raw HTTPS 地址读取公告，浏览器只访问本机 `/api/announcement`，不需要运行中的 Host。

文件使用以下格式（默认样例关闭）：

```markdown
---
enabled: false
title: 版本兼容性提醒
type: warning
---

这里填写公告正文，可使用 **粗体**、列表和 [链接](https://github.com/BytePioneer-AI/codex-host)。
```

- `enabled`：仅 `true` 显示，`false` 隐藏；正文为空也隐藏。
- `title`：必填，最多 200 字符，纯文本或 JSON 双引号字符串。
- `type`：`info`（蓝色普通通知）、`warning`（橙黄色注意提醒）、`danger`（红色紧急通知）。
- 文件头仅支持上述三个单行字段，不支持完整 YAML（如注释、嵌套或多行属性）；未知字段、重复字段或无效类型不展示。
- 正文沿用更新说明的安全 Markdown 子集：段落、标题、列表、引用、代码、粗体和 HTTP(S) 链接。不执行 HTML、脚本或远程图片；外部链接在新标签页打开。

发布时修改正文并设置 `enabled: true`，提交到远端 `main` 后生效，不需要重新发布应用；本地未推送的修改不会影响用户。撤下时设为 `false`、清空正文或删除文件。旧版客户端需要先升级到支持公告的版本。

每次打开或刷新 Web 页面时只读取一次，不定时刷新、不轮询、不自动重试；切换控制台内部页面不会再次获取。读取不阻塞其他控制台功能。GitHub 请求最多等待 5 秒，本机接口请求最多等待 8 秒；读取失败、网络超时、文件不存在、格式错误或超过 16 KiB 时保持隐藏，不显示错误、提示条或空白占位。服务端不缓存公告或失败结果，手动刷新页面即可重新尝试；GitHub/CDN 自身缓存仍可能影响更新时效。通知不写入磁盘。

## 与会话 Web 的区别

Console 是仅本机访问的诊断和管理网页，默认端口 `4399`，可由 `codexhost console` 打开。总览的“打开 Web”和“远程访问”按钮通过同一安装的 Launcher `web` 命令确保服务运行，并在默认浏览器打开登录链接，不依赖 Desktop；“远程访问”附带 `--connect-devices`，直接定位到 Web 的连接设备设置页。`codexhost web` 打开的是独立会话 Web，首次默认监听 `127.0.0.1:4400`，需要访问令牌，可用于手机连接；Host 和 Web 脱离终端运行，关闭页面不停止服务。无 Desktop 时 `codexhost` 改为打开会话 Web，不把 Console 当作聊天界面。命令和安装包路径见[独立 Web 应用](../product/standalone-web.md#安装版后台-web)。

`codexhost status` 只读查看后台 Host/Web 的状态、版本、Web 地址及自启状态；`codexhost stop` 依次停止托管 GUI、Web、Host、远程服务、Broker 和 Console，报告被中断的任务数，会话数据保留。自启项用 `codexhost autostart on|off|status` 管理，停止服务不关闭自启，也不撤销 Tailscale Serve。

## 打开方式

控制台随 codexhost 启动：

| 启动方式 | 行为 |
|---|---|
| 安装包（macOS 打开应用、Windows 开始菜单） | 默认在浏览器打开控制台总览，再启动 Desktop；启动失败或注入持续失败时另外打开总览查看原因 |
| 终端（npm 的 `codexhost`、`codexhost launch`、`npm start`） | 不打开浏览器；成功和失败都输出 `codexhost console: http://127.0.0.1:4399/`，Web 就绪时另输出 `codexhost web: <登录链接>`，与 `codexhost web` 的登录链接一致。`CODEXHOST_WEB_SERVICE=0` 或 Web 未就绪时省略 Web 行，不改变 Desktop 启动结果 |

控制台在校验 Shim、Host Runtime、Desktop Controller 和 Renderer 等 Codex 启动资源之前启动；这些文件缺失时，仍能提供故障恢复入口。npm 包装脚本将这部分校验交给 Launcher，不提前拦截。Launcher、Node 和控制台自身文件仍须可用，端口占用等控制台自身故障不保证能打开网页；命令参数解析失败也不进入启动流程。

Launcher 在打开控制台之前先写入 `starting` 启动记录（`finishedAtMs: null`）。只要该记录对应的 Launcher 仍存活，总览和侧边栏显示“正在启动”，不再提示重复启动；启动完成或失败后由同一条记录更新结果。超时沿用 Launcher 原有的超时与失败处理，不在网页额外设置倒计时。如果 Launcher 异常退出而留下未完成记录，控制台显示启动失败，不会永久停在“正在启动”。

从已打开的 Web 控制台点击“启动”时，安装版调用 Launcher 的显式 `launch` 命令，npm 版通过 npm 包装脚本启动；两者都不再打开浏览器标签页。原页面通过状态轮询展示启动结果。状态由 Console 全局共享：窗口可见时，稳定状态每 30 秒检查，启动中或读取失败时每 5 秒检查；隐藏暂停周期查询，恢复可见立即补读。切换到其他设置页仍检测 Host 在线状态，手动及操作后刷新继续可用；单次概览请求最多等待 8 秒，并发刷新合并。

设置 `CODEXHOST_CONSOLE=0` 可关闭控制台的启动、打开和地址输出，不影响 Web 的启用设置与地址输出。其他打开方式：

| 方式 | 说明 |
|---|---|
| `codexhost console` | 安装包与 npm 均可用 |
| Windows 开始菜单 | “codexhost console” 快捷方式 |
| Codex 设置页 | “关于”页的“打开控制台”，通过本地 Host 的 `codexhost/console/open` 打开；远程 Host 不支持 |

地址为 `http://127.0.0.1:4399/`。命令只复用安装、构建版本和数据目录均一致的控制台；若端口上的控制台属于另一份安装（例如 npm 与安装包并存），或使用不同的 `CODEXHOST_DATA_DIR`，先让旧实例退出再以当前配置启动。控制台不需要登录，直接访问即可。

源码工作区的 `npm start` 会移除继承的 `CODEXHOST_NPM_*` 更新路由，避免从已安装的 Harness 会话启动时，Shim 又选回 npm 包里的旧 Host Runtime。显式数据目录与代理配置仍保留；从远程 Host 会话启动本机 Desktop 时，应确认 `CODEXHOST_DATA_DIR` 没有指向正在使用的远程数据目录，需要本机默认目录时可用 `env -u CODEXHOST_DATA_DIR npm start`（POSIX）。

### 从源码重启

在仓库根目录执行 `npm start` 重启共享 Host 和 Desktop，执行 `npm start web` 重启共享 Host 和对应 Web 开发服务；两者都会中断 Host 上正在运行的任务，另一端已打开的界面按既有机制重连。无需额外的 Host 开发命令。

两个入口都在构建成功、产物验证后调用原生 Launcher 的 `host restart`，在同一数据目录的生命周期锁内等待旧进程树退出，再启动当前构建并等待就绪。构建失败或产物缺失不会停止旧 Host，Host 重启失败则不继续启动界面。`--no-build` 只跳过构建，仍重启 Host 和对应界面，不重放中断的任务。

Desktop 使用 `CODEXHOST_DATA_DIR`，默认 `~/.codexhost`。Web 使用 `--ch-data` 或 `--ch-control-directory` 对应的 Host 数据目录，默认同为 `~/.codexhost`；Web 自身的 `--data` 不改变 Host 位置。Web 只停止相同工作树、相同端口且进程身份匹配的旧开发服务，不关闭 Desktop；其他端口或工作树的服务保持运行。Web 开发重启要求本地共享 Host，旧 CDP 接入请直接使用打包版 preview 入口。

## 卸载

Windows 卸载程序在删除安装文件前调用安装内的 `codexhost stop`、`codexhost autostart off`，完成页提醒 Serve 配置保留；覆盖安装仅走安装准备逻辑，不执行这些卸载动作，也不删除自启项。macOS 和 npm 用户移除应用或执行 `npm uninstall -g @codexhost/cli` 前须自行运行这两个命令。若不再使用 Serve，按[远程访问的卸载说明](../product/web-remote-access.md#卸载前清理)检查并只移除对应 HTTPS 根路径。回退旧版前也应先停止后台服务并关闭自启。

## 端口

- 默认 `4399`，只监听 `127.0.0.1`。可用 `CODEXHOST_CONSOLE_PORT` 修改（1024–65535）。
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
- 启动、停止、打开 Web、更新、修改设置，以及读取 Web 访问令牌都通过受保护的 POST 接口，必须携带 `x-codexhost-console: 1` 请求头；来自浏览器的请求还要求 `Origin` 为控制台自身。拒绝非 loopback 对端、带 `Forwarded` / `X-Forwarded-*` 的代理请求和明确的跨站请求。其他网站无法跨域附加该请求头；GET 不提供令牌。
- 页面使用严格 CSP（不允许内联脚本和内联样式）。
- “导出诊断包（含日志）”会把用户主目录替换为 `~`。

## 与运行中的 codexhost 连接

Launcher 启动的本地 Host Runtime 在 `127.0.0.1` 的随机端口开放控制通道，把端口与随机令牌写入 `<数据目录>/console/hosts/host-<进程号>.json`（`0600`），退出时删除。控制台读取该文件，把设置请求转发给 Host，由 Host 按 Codex 设置页相同的逻辑处理；只接受 `CONSOLE_HOST_METHODS` 列出的设置方法，不接受 Thread 或 Turn 操作。

- codexhost 未运行：连接页显示离线的插件列表并可修改安装路径；SSH 远程连接、账号、用量统计提示先启动 codexhost。“连接设备”独立连接后台 Web，不依赖 Desktop。
- codexhost 运行但控制通道不可用（例如旧版本）：提示重新启动 codexhost。

## 停止

总览的“停止”先弹出确认窗，说明所有 codexhost 服务（包括控制台）会关闭，运行中的任务和 Web 终端会中断，会话数据保留。取消不发送停止请求。确认后调用同一安装的 Launcher `stop`，复用 `services.rs` 的 `stop_all`，不维护另一套进程清理逻辑；不会关闭登录自启或移除 Tailscale Serve 配置。

控制台等待 Launcher 返回实际结果后再退出；成功时页面停止轮询并明确显示“codexhost 已停止”，不会把自身退出显示为连接错误。部分停止失败时显示 Launcher 的错误，不声称全部停止，可再次检查或重试。

## 连接设备（Web 远程访问）

`#connect-devices` 展示 Web 当前的二维码、登录链接、连接地址、直连与 Tailscale HTTPS 开关、登录后自动启动及重新生成令牌。直连、Serve 和令牌变更的确认说明与会话 Web 一致；登录自启与会话 Web 一样直接切换。直连变更由 Web 保存配置并通过原生监管进程重启，控制台只重试读取以确认恢复，不重放写请求。

此页不需要 Desktop 或 Host 的设置通道，但需要已就绪的后台 Web；未运行时说明情况并提供“启动并打开 Web”。控制台从同一数据目录的 Web 就绪记录定位 loopback 服务，只代理固定的五个连接设置 RPC；Web 原有的状态、令牌、Tailscale、监听配置及自启实现仍是唯一读写方。无控制台本机请求校验的请求不能读取令牌或修改配置；登录链接和令牌不进入总览、公告或诊断包。

## 其他电脑（SSH）

`#remote-connections` 与内置设置共用远程连接页面，支持添加、编辑、移除 SSH 连接、连接与断开、查看本机及远程版本、检测、安装、更新、修复和卸载远程服务。卸载可选择同时移除 codexhost 软件包，确认提示和缺失 Node.js、npm、Codex CLI 的错误提示与内置页一致。“连接”页仍用于 Harness 管理。

远程连接配置由 Codex Desktop 保存；Web 不另存一份配置。此页需要通过 codexhost 启动的桌面端：Web → 本机 Host → 带随机令牌的 Controller 通道 → Renderer 中的固定连接操作。只接受约定的操作和参数，不开放任意原生请求或脚本执行。远程状态和更新沿用桌面端的远程 Host 客户端；SSH 安装、修复和卸载沿用本机 Host 的 Rust 执行器。

桌面端未运行时提示先启动 codexhost；旧版 Controller 或 Renderer 不支持此通道时提示通过 codexhost 重新启动。请求失败不自动重试写操作，避免重复安装或修改连接；超时后需刷新确认状态。远程页可见且稳定时每 30 秒检查，操作、更新或检查失败时每 5 秒检查；隐藏或离页停止周期查询，恢复可见及操作结束立即核对。

## Harness 排序与分组

连接页的排序、主列表 / 更多分组、恢复默认排列使用同一份本机设置，由 Host Runtime 保存到 `<数据目录>/harness-display-settings-v1.json`。Web 通过控制通道读写，Codex 界面始终通过本机 Host 读写（不随远程会话切换）；不同 Host 进程读取同一文件。支持事件的入口在 Host 保存成功后读取确认快照，重连或恢复可见时补读；明确缺少事件支持的旧入口保留 3 秒兼容读取，不需要重启。

- 首次接入时，若共享设置不存在，迁移 Codex 界面原有的 `codexhost.agentGroupPreference.v1` 本地偏好。旧 Web 的本地排序不参与迁移；已有共享设置优先，迁移不会覆盖它。localStorage 仅作为迁移来源读取，不再持续写入或用作展示缓存；界面只保留 Host 确认后的内存状态，未连接 Host 时不接受仅本地生效的修改。
- 修改经 Host 保存确认后才更新界面。读取或保存失败时显示提示，保留上次确认的顺序，不把本地修改伪装成成功；恢复连接后继续同步，保存失败可重试修改。
- 多端同时修改采用最后一次成功写入的完整排列；恢复默认会保存一个明确的空排列，旧本地偏好不会再次覆盖它。用户保存的排列优先，尚未记录的 Harness 按默认顺序追加，并按安装情况分组。
- 选择器与连接页只排列实际发现的插件。默认顺序为 Pi → Claude Code → DeepSeek → OpenCode → Grok → OMP → Antigravity → Kiro → CodeBuddy → WorkBuddy → Cursor → Hermes → Qoder → Qoder CN → Kimi → ZCode；名单外的新插件按显示名称排序追加，同名按插件 ID 排序。Codex 始终固定在选择器主区首位；此名单仅用于展示，不注册插件，也不改变动态发现机制。
- Web 离线插件页不提供排序操作，排序需要运行中的 Host。此设置只影响展示，不改变 Harness 是否启用或可用。

## 更新

更新页面展示当前服务实例启动或从活动更新锁恢复的任务状态。重新启动后，恢复最近一次更新在过去 24 小时内结束的结果；存在 `serviceStopOutput` 时，以纯文本显示 Host 停止时报告的被中断任务数。超过 24 小时的历史任务不恢复；没有停止输出的失败结果仍保留，避免部分停止失败后重连丢失结果。恢复的结果每次读取均检查时限，不无限期缓存；当前实例启动或从活动锁接管的任务仍可保留本次结果。页面刷新可继续查看同一任务；重试切换到新任务。历史状态文件按原有保留策略清理。

共享 Host 为 Web、Desktop 和 Console 提供同一份更新协调器。后台检查和下载不停止服务；原生 Host 监管进程接管同一份已准备请求，在受监管的 Node 子进程树外启动 Updater。Updater 校验所有者身份并确认全局更新锁已转移给自身后，通过当前安装的旧 Launcher `stop-for-update` 依次停止受管理 GUI、Web 和 Host，再安装。安装阶段其他客户端不能重新拉起服务；Updater 的恢复进程可以启动目标服务。请求使用明确的数据目录，停止和恢复都拒绝接管另一安装的运行服务。

npm 的 Launcher 和 Node 分别来自更新请求的平台包根目录与 `node_path`；Windows 安装包从安装根目录的 `bin` 和 `runtime` 定位；macOS 的 Launcher 位于 `.app/Contents/MacOS/codexhost`，Node 位于 `.app/Contents/Resources/runtime/node`。Host `--stop` 的标准输出作为不透明文本保存在更新状态中，不由 Rust 解析任务数。更新后按原使用方式恢复：纯 Web 只恢复后台 Host 和 Web；受管理 GUI 在线时恢复 GUI 并沿用 Web 的启用设置。恢复检查服务的版本、运行入口、进程身份和监听状态。GUI 恢复由 Launcher 先确保共享 Host 运行，再启动 Desktop，因此不依赖 LaunchServices 保留父子进程关系。

停止服务后安装或启动失败时，Updater 尝试一次恢复同一安装，更新状态保持失败并附带恢复结果；不保证损坏的安装可以回滚。会话记录保留，被中断任务不自动继续。浏览器在更新期间断线时有界重试状态查询，不重发开始更新；10 分钟内无法确认结果时显示未知，不推断安装失败。

`codexhost update` 提供不打开浏览器的终端入口，适用于 npm、macOS DMG 和 Windows 安装包。命令检查最新 Release，已是最新版本时成功退出。有可用 Host 时，验证它属于当前安装后复用 Host 的更新接口；不同安装或缺少安装身份的旧 Host 会被明确拒绝。终端显示请求已接受不代表安装已经完成，应查看重连后的更新状态和当前版本。

没有可用 Host 时，Console/CLI 使用独立更新流程，下载、准备后等待 Updater 校验进程身份并确认就绪，转移更新锁，再退出；Updater 等发起进程退出后安装。没有安装 Desktop 时恢复 Web，否则沿用 Desktop 启动方式。创建子进程或获得 PID 不代表交接成功；启动报错、提前退出或交接超时都会报告失败。源码构建和 Linux 非 npm 安装不支持自更新。

- Windows 安装包更新以 `/DIR` 固定当前安装目录，启动安装器前由 Updater 关闭仍从该安装目录运行的 Launcher、内置 Node（包括独立控制台）、Shim 和 node_repl 包装器，规则与下文的覆盖安装相同；npm 更新前关闭仍从该平台包运行的 codexhost 可执行文件，不关闭共享的系统 Node。安装器和 npm 的输出分别写入本次更新目录的 `installer.log`、`npm-install.log`。失败时保留手动更新入口。
- npm 安装保留 Node、npm CLI、wrapper 和平台包根目录的绝对路径，后台 Host 不依赖后来连接的 Desktop 提供安装信息。路径必须属于当前 Host 安装。
- 检查、准备或交接失败时 CLI 返回非零退出码；安装后的最终结果保留在本地状态文件中。


### Windows 安装包覆盖安装

用户点击“安装”后、覆盖文件之前，安装器使用包内提取到临时目录的原生 Updater 自动关闭目标安装的 Launcher、内置 Node（包括独立控制台）、Shim 和 Updater 进程。关闭目标按完整可执行文件路径筛选，以 PID 和创建时间标识进程实例；优先通过 Windows Restart Manager 关闭，不支持该机制的无界面进程按原进程实例终止。运行中的任务可能被中断。

安装界面不增加关闭提示或确认；只打开安装器、在点击“安装”之前取消，都不会关闭进程。其他安装目录或系统 Node 不属于关闭目标。无法完成关闭时停止安装并报告错误，仍保留安装器对其他文件占用的检查。安装器本身不自动重启应用；由更新流程启动的安装仍由外层 Updater 完成重启。

## 连接页（codexhost 未运行时）

codexhost 未运行时，“连接”页列出已安装的插件（读取 `manifest.json`，不执行插件代码）及是否启用，并可修改接受自定义安装路径的插件的路径。路径与 Codex 设置页共用 `<数据目录>/harness-launch-settings/<插件>.json`；codexhost 运行中修改时，在重新启动 codexhost 后生效。设置文件损坏时，该插件显示读取错误（含文件路径），保存新路径或“恢复自动查找”即可替换。插件目录与 Host Runtime 一致：发布包的 `app/plugins`，以及 `CODEXHOST_PLUGIN_DIRECTORY` 或 `<数据目录>/plugins`。

## 诊断包与 Issue

- “导出诊断包”下载 JSON：状态、Codex 与 codexhost 版本、最近 5 次启动记录、注入状态，以及最新两个 Host Runtime 日志的末尾 32 KiB。用户主目录替换为 `~`，其他内容（如日志中的项目路径）不做处理，分享前请检查。
- “提交 Issue”打开 GitHub 新建 Issue 页面，预填版本、系统、状态和错误，不包含日志。

## 其他命令

`codexhost inspect --json` 输出 Codex Desktop 安装信息与 Launcher 运行状态；未找到 Codex Desktop 时在 `desktopError` 中说明，不以失败退出。
