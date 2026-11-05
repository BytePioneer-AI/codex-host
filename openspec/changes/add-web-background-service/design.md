# Design

## Context

- Host 已有后台机制：`host ensure` 通过脱离前台的 `host serve` 监管进程启动 Node，用就绪文件交换状态，用 `shared-host-lifecycle.lock` 串行化生命周期操作。`host stop` 通过 Node 的 `--stop` 调用 Host 的 `/v1/shutdown`。
- Web 由 `preview.mjs` 或 `app/server.mjs` 在前台运行。连接 Host 时，它已能通过 Launcher 的 `host ensure` 按需拉起 Host，并在断线后重新发现。
- 现有发行内容（`scripts/release/prepare-payload.mjs`）不含 Web。Web 自己的发行目录约 266 MB，其中 LibreOffice 148 MB、`node-pty` 26 MB（含全部平台的预编译文件）、Harness 插件 23 MB。发布流水线在各目标平台的 Runner 上分别构建。
- `codexhost` 已能在 GUI 运行时切到现有窗口（Launcher 归属的 Attached 路径）。未安装 Desktop 时现在返回错误并打开 Console。

## Decisions

**独立的 Web 监管进程。** 新增与 `host serve` 同构的隐藏命令，用独立的就绪文件和生命周期锁（都放在 Host 数据目录）。复用平台层的脱离前台启动和子进程树监管；相同的小工具函数在第二处用到时再提取。放弃合并为一个监管进程：重启 Web 不能带上 Host，Host 的“被强杀后不做交接”语义也不应扩大到 Web。

**Rust 不解析 Web 语义。** Web 写出不带 token 的地址和本机登录链接；监管进程补上进程号、版本和运行入口后发布就绪记录，与 Host 相同。Rust 只把它们当作不透明字符串用于打印和打开。记录文件仅当前用户可读。放弃由 Rust 读取 token 拼接链接。

**锁顺序。** 启动先 Host 后 Web。需要同时操作时始终先取 Web 锁，再取 Host 锁，避免死锁。

**停止顺序。** `codexhost stop` 依次关闭 GUI、Web、Host、远程服务、Broker、Console，全部复用现有入口，不新增停止机制：GUI 按运行描述文件判断，由结束 Controller 关闭 Desktop；远程服务和 Broker 用现有的 `remote stop`、`broker stop`；Console 用 `/api/shutdown`。某一步失败时继续关闭其余进程，最后报告失败项。

`codexhost` 的 Web 拉起放在后台线程，不延长 GUI 启动时间，失败写入记录。版本不一致时的替换在打开 GUI 前同步完成，否则 GUI 可能连上即将被替换的 Host。设置 `CODEXHOST_WEB_SERVICE=0` 时不拉起 Web，用于现有启动测试和 Gate，与 `CODEXHOST_CONSOLE=0` 对应。

**监管循环。** Web 在开始监听后才写就绪文件。退出后按四类处理：

| 情况 | 行为 |
| --- | --- |
| 存在停止标记文件 | 清理后退出。标记由 `stop` 在持锁时写入，这样跨平台不依赖信号或退出码 |
| 专用退出码（设置变更） | 立即重启，不计退避 |
| 就绪前退出 | 写入失败原因并退出，不重试 |
| 其他 | 退避重启（1、2、4 秒，上限 30 秒），连续运行 60 秒后重置 |

**启动选项保存在 Web 数据目录。** Web 的后台模式读取 `<web-data>/service.json`（`host`、`port`、`publicUrl`、`trustedProxies`），不用命令行默认值，也不沿用 `preview-launch` 的 `0.0.0.0`。`codexhost web` 把用户给出的选项交给一次性的 Web 进程（`--save-service-options`，不监听），由它校验并保存：内容变化时以专用退出码退出，没有变化时退出码为 0，校验失败时命令失败，已保存的值不变。内容变化且 Web 在运行时，Launcher 先停止再拉起 Web。连接设备页的开关写入同一个文件，再以专用退出码退出。放弃让 Rust 解析该文件，也放弃每次启动都带参数：自启和 `codexhost` 必须和用户上次的选择一致。

**任务数由 Host 计算。** `/v1/shutdown` 的响应带上运行中的任务数，`--stop` 把结果写到标准输出，Launcher 只转发。旧 Host 不返回时只输出已停止。这样 Rust 不需要理解任务。远程服务没有任务数接口，不为此新增，只提示它已停止。

**版本一致检查只放在面向用户的入口。** 就绪记录增加版本字段，`codexhost` 和 `codexhost web` 比较版本和运行入口，不一致就走现有的 `host restart` 和 Web 的等价操作。旧记录没有版本字段，按不一致处理。`host ensure` 不变，避免影响 Shim、Web 和开发入口。Desktop 仍持有的旧 Host 不能被停止时，沿用现有拒绝并提示用户先关闭 Desktop。

**Host 和 Web 用各自的 Node。** Host 不管由哪个入口拉起，都和 GUI 路径选同一个 Node：macOS 上优先用 Desktop 的 `cua_node`，因为原生工具会校验 Host 的进程身份。Web 依赖按发行 Node 编译的 `node-pty`，所以始终用发行 Node 或 npm 的 Node，并通过 `--ch-node` 记住 Host 的 Node，Host 崩溃后重新拉起时不会换。

**共享 Host 协调更新。** Web 与 Desktop 使用同一更新协调器，复用 update-manager 的下载、校验、状态文件和操作锁。安装上下文属于启动共享 Host 的安装，包含真实原生监管进程身份和 npm 的绝对路径，不依赖某个 Desktop 连接。原生 Host 监管进程接管同一份已准备请求，从受监管的 Node 子进程树外启动 Updater，并在握手后将操作锁交给它。Host 保持在线直至 Updater 主动停止服务；下载阶段不中断任务。

**更新在安装前停止服务。** Updater 使用旧 Launcher 依次停止受管理 GUI、Web 和 Host，再安装。共享服务请求由 Updater 主动停止其所有者；独立 Console/CLI 请求仍先等发起进程交接退出。停止前固定恢复目标：有受管理 GUI 时恢复 Desktop，只有后台服务时恢复 Web，不打开浏览器。更新请求显式携带数据目录，Web 继续使用已保存的配置。安装后按恢复目标核对真实进程、运行入口和版本，不以 Desktop 记录代替 Web 就绪。旧更新请求保留默认 Desktop 行为。

**失败和断线恢复。** 停止服务后发生错误时，Updater 尝试一次按相同目标恢复当前可用安装，更新结果仍为失败，并记录恢复是否成功；不承诺安装文件损坏后可回滚。页面在更新期间遇到连接失败时有界重试状态查询，恢复连接后显示权威结果，不重发开始更新命令。等待耗尽只能报告暂时无法确认结果，不能推断安装失败。

**自启项由 Launcher 在运行时写入。** 平台差异放在 `crates/platform`，复用已有的 macOS LaunchAgent 写法。

| 平台 | 方式 | 说明 |
| --- | --- | --- |
| macOS | 用户级 LaunchAgent，`RunAtLoad`，不用 `KeepAlive` | 保活由监管进程负责 |
| Windows | 当前用户的 `Run` 注册表项 | 命令行超过系统的 260 字符限制时开启失败并说明原因，不引入中间脚本 |
| Linux | systemd 用户服务，`Type=oneshot` + `RemainAfterExit` | 没有 systemd 时不提供；linger 由用户决定，文档说明 |

自启项执行 `codexhost web --background`，只确保服务运行，不打开界面。用户入口是 `codexhost autostart on|off|status`，连接设备页也通过 Launcher 调用它：`status` 输出一行 `on`、`off` 或 `invalid <原因>`，`on`、`off` 失败时退出码非零并把原因写到 stderr。npm 版要记录 wrapper 和当前 Node 路径，由 npm wrapper 传给 Launcher，`codexhost` 每次运行时刷新。

**发行布局。** 新增 `app/web-server.mjs`、`app/web/` 和 Web 专用的 `app/web-modules/`；Harness 插件直接复用 `app/plugins`，不再放一份。`node-pty` 只保留当前目标的预编译文件。不带 LibreOffice 引擎包，但保留很小的入口包和 `koffi`。`preview.mjs` 和开发专用选项不进入发行内容。

**Office 组件下载（最小实现）。** 只增加一个 Web 服务内的小模块、转换入口的一处调用和页面的一个提示状态：

1. 打包时从 `package-lock.json` 读取各平台引擎包的官方地址和 `integrity`，写进发行内容。不在运行时查询 npm 元数据，所以信任来源是发行包本身。
2. `office-to-pdf` 转换前调用可选的“确保引擎”回调。发行版传入回调，源码运行不传，也就不会下载。引擎未就绪时回调在后台开始下载，并让这次请求立即返回“正在下载”，不让预览请求一直等待：现有转换有 60 秒超时，页面离开时请求也会被取消，而下载不能跟着取消。
3. 回调用 Node 自带的 `fetch` 下载（已经支持系统代理），校验 SHA-512，用系统自带的 `tar` 解压到临时目录，再原子改名到 `<web-data>/office-engine/<版本>/node_modules/@deepseek-ai/`，并删除其他版本。同一时间只有一个下载；失败只抛错，下次预览重试。
4. 引擎包由入口包按 Node 模块路径查找，而发行目录可能不可写。下载完成后临时设置 `NODE_PATH` 并调用 `Module._initPaths()`，随即从环境中删除，这样 Web 终端和子进程不会继承。这是 Node 的私有接口，用测试覆盖；Node 升级后如果失效，表现是预览不可用，不影响其他功能。

页面收到“正在下载”后显示提示，并每隔几秒重试同一个预览，直到成功或下载失败；页面离开时只停止重试。下载任务属于 Web 进程，Web 重启时丢弃未完成的内容，下次预览重新下载。

只用官方源，不做镜像、进度条和管理界面。把不可用提示从“在运行 DeepSeek Harness 的主机上启用”改成网络提示。放弃复用界面扩展的 `npm install`：安装包用户不一定有 npm。

**Serve 写入。** 按 Tailscale v1.104.1 源码已确认的行为实现：`--bg` 会直接替换同路径转发；不带 `--set-path` 的 `off` 会删除该端口所有路径；缺少 HTTPS 能力时可能退出码为 0 却没有写入。所以每次操作前后都重新读取状态，关闭时明确指定根路径。接口要求本机访问，与查看 token 使用同一判断。

**设置入口。** Host 新增一个打开连接设备页的接口，内部运行 Launcher 的 `codexhost web --connect-devices`，结构与现有的 `codexhost/console/open` 相同；按钮放在 Codex 设置的“远程连接”页顶部，和 SSH 连接分开说明，Console 不增加入口。开发版没有后台 Web，点击时提示运行 `npm start web`。这个开关只在打开浏览器的登录链接后加 `#connect-devices`，页面读到后用现有的 `openSection` 打开设置弹窗并清除 hash，不新增路由。不新增 Web 状态接口：状态看连接设备页和 `codexhost status`。

## Risks / Trade-offs

- [后台 Web 和 `npm start web` 共用 Web 数据目录和默认端口] → 端口冲突时提示失败，不结束对方；`npm stop` 增加对后台 Web 的识别。
- [`codexhost stop` 关闭 GUI 时，用户未保存的 Composer 草稿可能丢失] → 用户主动执行，不做确认；会话记录保留。
- [开发时的前台 `npm start web` 不在 `codexhost stop` 的范围内，可能重新拉起 Host] → 开发者用 `npm stop`。
- [`codexhost stop` 中断其他电脑上的远程任务] → 用户主动执行，不做确认；会话记录保留，命令输出说明如何恢复。
- [本机登录链接写入就绪文件和命令输出] → 本机 token 只对本机访问有效，文件仅当前用户可读；SSH 环境下通过端口转发访问时同样满足本机条件。
- [退避重启掩盖持续崩溃] → 记录最近的退出原因，由 `codexhost status` 显示。
- [安装失败或电脑离线时手机可能无法恢复连接] → 尽力恢复可用安装并保留失败记录；安装文件已损坏、休眠或断网仍可能需要电脑端处理。
- [Office 组件下载较慢，或国内网络访问 npm 官方源失败] → 只影响 Word、PPT 预览，提示检查网络；校验值固定，以后要加镜像也不影响安全性。

## Migration

没有持久化迁移。token、Web 设置和会话记录继续使用现有目录，第一次启动没有 `service.json` 时使用默认值。已从源码运行过 Web 的用户沿用原 token。

回滚到旧版后，旧版不识别后台 Web；需要先运行新版的 `codexhost stop`，并关闭自启项。文档说明这一点。

## Open Questions

- 发行目录是否还能进一步减小，实施时按实测决定，不影响规格。
- 空闲时 Web 的内存和 CPU 占用要实测并记录，只在明显偏高时才需要处理。
