# codexhost 控制台

控制台是一个本地网页，不依赖 Codex Desktop 启动成功。左侧导航分为：

- **总览**：当前状态与下一步操作、codexhost 版本 / Codex Desktop 版本 / 安装方式三个信息框、最近一次启动的结果；失败时说明卡在哪一步和错误原文，内部阶段时间线折叠在“详细信息”中；注入持续失败时显示原因。成功时不展示时间线，不显示启动历史表格。原启动诊断页已合并，旧的 `#diagnostics` 和 `?view=diagnostics` 链接显示总览。日志不在页面中展示，通过“导出诊断包（含日志）”获取。
- **设置**：连接、远程连接、账号、会话导入、更新，与 Codex 设置页使用同一套页面和 Host 接口。连接页支持通过运行中的本地 Host 安装 Harness CLI、检查版本和更新，复用安装进度、错误提示及安装后检测；不支持远程 Host 安装。WorkBuddy 仍通过官网手动下载安装桌面应用。Host 不可用时不提供一键安装。
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

## 打开方式

控制台随 codexhost 启动：

| 启动方式 | 行为 |
|---|---|
| 安装包（macOS 打开应用、Windows 开始菜单） | 先启动控制台并在默认浏览器打开总览，再启动 Codex Desktop；启动失败或注入持续失败时另外打开总览查看原因 |
| 终端（npm 的 `codexhost`、`codexhost launch`、`npm start`） | 控制台在后台与 Codex Desktop 一同启动，启动结束时在终端输出 `codexhost console: http://127.0.0.1:4399/` |

控制台在校验 Shim、Host Runtime、Desktop Controller 和 Renderer 等 Codex 启动资源之前启动；这些文件缺失时，仍能提供故障恢复入口。npm 包装脚本将这部分校验交给 Launcher，不提前拦截。Launcher、Node 和控制台自身文件仍须可用，端口占用等控制台自身故障不保证能打开网页；命令参数解析失败也不进入启动流程。

Launcher 在打开控制台之前先写入 `starting` 启动记录（`finishedAtMs: null`）。只要该记录对应的 Launcher 仍存活，总览和侧边栏显示“正在启动”，不再提示重复启动；启动完成或失败后由同一条记录更新结果。超时沿用 Launcher 原有的超时与失败处理，不在网页额外设置倒计时。如果 Launcher 异常退出而留下未完成记录，控制台显示启动失败，不会永久停在“正在启动”。

从已打开的 Web 控制台点击“启动”时，安装版调用 Launcher 的显式 `launch` 命令，npm 版通过 npm 包装脚本启动；两者都不再打开浏览器标签页。原页面通过状态轮询展示启动结果。

设置 `CODEXHOST_CONSOLE=0` 可关闭以上行为。其他打开方式：

| 方式 | 说明 |
|---|---|
| `codexhost console` | 安装包与 npm 均可用 |
| Windows 开始菜单 | “codexhost console” 快捷方式 |
| Codex 设置页 | “关于”页的“打开控制台”，通过本地 Host 的 `codexhost/console/open` 打开；远程 Host 不支持 |

地址为 `http://127.0.0.1:4399/`。命令只复用安装、构建版本和数据目录均一致的控制台；若端口上的控制台属于另一份安装（例如 npm 与安装包并存），或使用不同的 `CODEXHOST_DATA_DIR`，先让旧实例退出再以当前配置启动。控制台不需要登录，直接访问即可。

源码工作区的 `npm start` 会移除继承的 `CODEXHOST_NPM_*` 更新路由，避免从已安装的 Harness 会话启动时，Shim 又选回 npm 包里的旧 Host Runtime。显式数据目录与代理配置仍保留；从远程 Host 会话启动本机 Desktop 时，应确认 `CODEXHOST_DATA_DIR` 没有指向正在使用的远程数据目录，需要本机默认目录时可用 `env -u CODEXHOST_DATA_DIR npm start`（POSIX）。

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
- 启动、更新、修改设置等操作必须携带 `x-codexhost-console: 1` 请求头；来自浏览器的请求还要求 `Origin` 为控制台自身。其他网站无法跨域附加该请求头。
- 页面使用严格 CSP（不允许内联脚本和内联样式）。
- “导出诊断包（含日志）”会把用户主目录替换为 `~`。

## 与运行中的 codexhost 连接

Launcher 启动的本地 Host Runtime 在 `127.0.0.1` 的随机端口开放控制通道，把端口与随机令牌写入 `<数据目录>/console/hosts/host-<进程号>.json`（`0600`），退出时删除。控制台读取该文件，把设置请求转发给 Host，由 Host 按 Codex 设置页相同的逻辑处理；只接受 `CONSOLE_HOST_METHODS` 列出的设置方法，不接受 Thread 或 Turn 操作。

- codexhost 未运行：连接页显示离线的插件列表并可修改安装路径；远程连接、账号、会话导入提示先启动 codexhost。
- codexhost 运行但控制通道不可用（例如旧版本）：提示重新启动 codexhost。
- Web 会话导入成功后显示“导入成功，请在 Codex 中查看”，不尝试导航，也不提供“重试打开”；导入失败仍显示实际错误。Codex 内置设置页保留导入后打开会话的行为。

## 远程连接

`#remote-connections` 与内置设置共用远程连接页面，支持添加、编辑、移除 SSH 连接、连接与断开、查看本机及远程版本、检测、安装、更新、修复和卸载远程服务。卸载可选择同时移除 codexhost 软件包，确认提示和缺失 Node.js、npm、Codex CLI 的错误提示与内置页一致。“连接”页仍用于 Harness 管理。

远程连接配置由 Codex Desktop 保存；Web 不另存一份配置。此页需要通过 codexhost 启动的桌面端：Web → 本机 Host → 带随机令牌的 Controller 通道 → Renderer 中的固定连接操作。只接受约定的操作和参数，不开放任意原生请求或脚本执行。远程状态和更新沿用桌面端的远程 Host 客户端；SSH 安装、修复和卸载沿用本机 Host 的 Rust 执行器。

桌面端未运行时提示先启动 codexhost；旧版 Controller 或 Renderer 不支持此通道时提示通过 codexhost 重新启动。请求失败不自动重试写操作，避免重复安装或修改连接；超时后需刷新确认状态。

## Harness 排序与分组

连接页的排序、主列表 / 更多分组、恢复默认排列使用同一份本机设置，由 Host Runtime 保存到 `<数据目录>/harness-display-settings-v1.json`。Web 通过控制通道读写，Codex 界面始终通过本机 Host 读写（不随远程会话切换）；不同 Host 进程读取同一文件。两端约每 3 秒检查一次变化，不需要重启。

- 首次接入时，若共享设置不存在，迁移 Codex 界面原有的 `codexhost.agentGroupPreference.v1` 本地偏好。旧 Web 的本地排序不参与迁移；已有共享设置优先，迁移不会覆盖它。localStorage 仅作为迁移来源读取，不再持续写入或用作展示缓存；界面只保留 Host 确认后的内存状态，未连接 Host 时不接受仅本地生效的修改。
- 修改经 Host 保存确认后才更新界面。读取或保存失败时显示提示，保留上次确认的顺序，不把本地修改伪装成成功；恢复连接后继续同步，保存失败可重试修改。
- 多端同时修改采用最后一次成功写入的完整排列；恢复默认会保存一个明确的空排列，旧本地偏好不会再次覆盖它。用户保存的排列优先，尚未记录的 Harness 按默认顺序追加，并按安装情况分组。
- 选择器与连接页只排列实际发现的插件。默认顺序为 Pi → Claude Code → DeepSeek → OpenCode → Grok → OMP → Antigravity → Kiro → CodeBuddy → WorkBuddy → Cursor → Hermes → Qoder → Qoder CN → Kimi → ZCode；名单外的新插件按显示名称排序追加，同名按插件 ID 排序。Codex 始终固定在选择器主区首位；此名单仅用于展示，不注册插件，也不改变动态发现机制。
- Web 离线插件页不提供排序操作，排序需要运行中的 Host。此设置只影响展示，不改变 Harness 是否启用或可用。

## 更新

更新页只展示当前操作或明确绑定到本次重启的结果，不选择磁盘上“最近一次”历史记录。Windows 的现有 status 文件保存可选 `outcome` 和私有 restart 关联；请求中的渠道/安装根/descriptor、当前 Launcher PID/原生创建时间及运行版本必须一致。更新后的新 Host 和恢复后的旧 Host 即使活动锁已释放、网络不可用，也能读取本次结果；其他安装、旧 Launcher/复用 PID 或远端 Host 不认领结果。当前 Launcher 存活期间，诊断清理不删除这条结果。旧记录缺少关联字段时不冒充本次重启结果。

`outcome` 区分更新成功（updated）、更新失败但旧版恢复且就绪（restored）、恢复失败（recovery-failed）及状态未确认（unknown）。后三者仍为 failed；后两者保留锁、材料与诊断，不从英文 error 字符串推断恢复结果。操作路径及进程关联不暴露为浏览器可传参数，没有第二份启动回执。

`codexhost update` 提供不打开浏览器的终端入口，支持 Windows npm/EXE、非 Windows npm 和 macOS DMG。Windows 缺少原版恢复能力或材料、归属不明时，仍在停止应用前拒绝，并指向原 npm prefix 或原安装目录的人工路径。普通 Inno 安装不受自动更新准备流程影响。命令检查最新 Release，已是最新版本时成功退出；有更新时需先退出正在运行的 codexhost。命令复用控制台更新管理器和全局更新锁，等待下载、准备以及 Updater 校验旧进程身份并确认 `waiting-for-exit` 后退出，随后后台安装并重启 codexhost。创建子进程或获得 PID 不代表交接成功；启动报错、提前退出或 10 秒内未确认交接都会使操作失败，并终止未就绪的 Updater。终端显示的是交接状态，不代表安装已经完成；重新启动后应检查当前版本，历史安装结果保留在本地更新状态文件中供诊断。检查、准备或交接失败时返回非零退出码。源码构建和 Linux 非 npm 安装不支持自更新。

- codexhost 运行中：通过 Host 的更新流程检查与安装，与 Codex 设置页一致。
- codexhost 未运行：控制台下载并准备更新，拉起 Updater 并等待身份校验后的就绪确认才退出；Updater 等待控制台进程退出，再按原流程安装并重新启动 codexhost。
- npm 安装需通过 npm 命令启动的控制台（`codexhost`、`codexhost console`，或 Codex 设置页）才能更新，因为更新需要 npm 路径环境变量。
- 源码构建不支持在控制台更新。

### Windows 更新边界

Windows 更新页、Host、独立控制台及终端入口已接通一键准备、安装和重启，并保留手动入口。`check` 按当前安装身份、原版恢复能力和发行资产判断可用性；`start` 进一步准备并校验目标及原版全部材料，成功接管后才停止当前实例。不存在“仅因 Windows/尚未验收”而一概拒绝的总开关。npm 使用原全局 prefix，EXE 使用原目录，不跨渠道；旧能力或材料缺失时明确拒绝。功能已实现，Windows 原生升级、恢复和进程隔离仍需用户手测，不将交叉编译当验收。后台更新的归属校验要求 npm CLI、匹配平台包、版本及全局命令入口属于同一 prefix，支持 npm 的嵌套和提升平台包布局；链接、跨 prefix 或不明确的布局在交接前失败。安装执行显式指定原 npm prefix 或安装包目录，不使用当前终端的默认 prefix 或安装器记忆的其他目录。macOS npm/DMG 沿用各自的准备与启动方式。

Windows Desktop 的 Host 在身份与材料准备通过后向既有请求发布 `launch_via_launcher` 启动意图；`prepared` 本身不触发启动，不代表已交接。Launcher 在其 Desktop Job 外启动临时 Updater，核对 Helper 不属于旧 Job，再等待同一 operationId、原生创建身份及 `waiting-for-exit`；交接失败保留旧 Desktop，并更新既有失败状态；原 Host 观察该失败后仅释放自身未转移的准备锁，允许重试，不删除 Updater 已接管或后续操作的锁。Node 的 `detached` 不用于逃离 Job。独立控制台/终端仍可直接启动并等待原生交接；继承 Desktop Job 的 Helper 在接管前拒绝，不凭包级环境获得任何清理权限。Job 提示只用于否决：命名 Job 已销毁而 Open 返回确切 NotFound 时不拒绝独立进程，其余无法判断的错误保留失败闭锁。Windows 临时 Updater 在确认旧进程的 PID、创建时间和可执行文件后接管操作锁，再报告等待退出；Launcher 还会核对活动 Helper 的实例身份。安装开始后的异常中断会保留锁和操作目录，后续入口报告需要手动修复，不自动重试覆盖。修复应使用原安装渠道及原 prefix/安装目录；仅重新启动服务或等待诊断清理不会解除这种保护。短时元数据互斥由操作系统文件句柄持有，进程退出自动释放，不按目录年龄或等待超时破锁。持久空文件 `.active-update-mutation.lock` 的存在不代表活动更新；准备记录通过临时文件原子发布，避免准备进程崩溃留下半条记录阻止重试。

最终安装归属及 EXE 摘要校验是只读步骤，校验失败不进入可能写安装的操作，也不按半安装禁止重试。只有即将调用 npm/安装器时才设置安装写入标记；实际写入后的失败仍保留操作锁。

Windows npm 在旧所有者退出前，通过已验证的 Node/npm CLI 获取目标版及原版本的 CLI 与当前 OS/CPU 平台包；校验 registry 的 SHA-512、npm 原生 pack 的结果和本地归档摘要，再只读检查包名、版本、发行 metadata、必需文件及安装依赖闭包。每个版本仅需两个归档；新增必需依赖、安装脚本或无法确认的材料会使准备失败，不进入安装，也不强制生产试装。准备目录和隔离 npm cache 必须位于原安装 prefix 之外；两套材料共享两分钟准备预算，不写当前安装。原生交接前还会只读检查目标目录的创建/删除权限及可用空间，不创建安装目录内的探针文件，不自动提权。

正式 npm 安装只使用已准备的本地归档、隔离 cache 和空 user/global npmrc，显式指定原 prefix，使用 `--offline --ignore-scripts --omit=optional`；同时禁用 audit、fund 和 update-notifier，禁止安装时联网补包或改用浮动版本。写入前重验本地材料的 SHA-256 和归属，npm 失败或五分钟内未结束则报告失败。EXE 仍在交接前下载并校验大小/SHA-256。macOS npm 的原安装时机、参数及 DMG 流程不变。

Windows EXE 的恢复能力为 `codexhost-inno-files-v1`。发行载荷的 `app/codexhost-inno-files-v1.txt` 记录该版本精确发行文件及摘要；同版本 Release 的 `*.installer-recovery-v1.json` 将清单绑定到原 EXE 的 SHA-256。准备取得目标/原版本的 EXE 和描述符，核对已安装清单及原文件字节、架构和版本，固定目录外暂存；每个 Windows EXE/描述符下载有两分钟传输预算。缺少旧能力、材料或匹配摘要时不停止旧实例，保留原渠道原目录人工路径。该清单不是注册表、快捷方式或安装器账本快照。

`app/plugins` 的发行文件由清单精确列出；默认用户插件和 Harness 启动设置位于数据目录，自定义插件/数据目录仍受保护。未知用户文件和目录不递归清理；新版路径与已有未知文件碰撞、已安装发行文件被修改、符号链接/reparse/hard-link 归属不明，或发行路径与用户数据根重叠时，准备失败。原 Inno 的显式内部 `CODEXHOSTREPLACEFILES` 参数只按已替换清单与自身内嵌清单的差集删除文件，然后用自身 `[Files]` 载荷安装；普通人工安装不传该参数，原 UI 和关闭时机不变。升级和旧版恢复使用同一原工具机制，不调用卸载器清空自定义根，不回放安装元数据。

EXE 执行固定 `/DIR`，显式禁止额外 close/restart applications，并将需重启结果映射为非零 3010。只有该次安装工具及受管后代确认退出、没有待重启写入，且本安装无活动 image 时才尝试一次本地旧版恢复；恢复后检查完整原发行文件及新版独有文件已删除，再启动该旧版自身的 Launcher/Runtime。退出或延迟写入不明、旧材料损坏、恢复失败均保留锁、材料及 Inno 日志。该分支已接通实际入口，真实 Inno/Host 行为待用户手测。

共享系统 Node 的可执行路径只用于预筛选：原生更新器还需验证实际命令行的核心脚本入口、PID 和创建时间。交接前确认这些信息可获取；原所有者退出后，仅关闭该 prefix 的 CLI、Host、Controller 和控制台进程。其他安装的控制台及相同 Node 的无关脚本不属于关闭目标。相同安装的受管 Launcher 可识别终端/控制台发起且已接管的更新，自行清理其 Desktop；关闭与文件占用处理均有界，无法确认退出时不开始安装。

Windows 更新和恢复重启使用明确的 `launch --preserve-external-desktop`。不带调用方原生隔离能力的入口仍在资源解析、控制台创建、附着和平台激活前拒绝。受保护原生路径接收内部 `--update-job`：Updater 在 spawn 前创建独有空 Job 并持有句柄，Launcher 仅打开该 Job，不附着、删除旧 descriptor 或强停其他实例。管理器与原生请求均保留身份、材料及恢复能力校验；普通用户启动及 macOS 参数不变。已有启动确认实现关联本次直接启动的 Launcher（npm 则关联本次 wrapper 子进程）、创建时间、原安装路径及目标版本，要求新的 runtime nonce、成功启动记录、Controller 鉴权探测和对应 Host 的鉴权控制通道。Host 就绪观察既有本地 Native 生命周期 gate，不要求 Harness 登录或 Model 网络成功。旧 PID、过期记录、其他安装或其他启动的实例均不能单独满足确认。

Windows 更新或旧版恢复的 Host/控制链确认就绪、终态写入且操作锁释放后，由 Desktop Job 外的 Updater 启动该版本的独立控制台。控制台使用原数据目录和端口，不额外打开浏览器；端口已被占用时保留现有进程。`CODEXHOST_CONSOLE=0` 仍禁用自动启动。控制台不参与受保护启动的就绪判定或回滚，启动失败不会撤销已经确认的更新/恢复结果；可手动运行 `codexhost console` 重试。

新版安装成功后的重启若在 Windows `Command::spawn` 处明确未创建子进程，则可在安装静止检查后进入同一原渠道恢复。capture/Job setup/bind 或清理状态不明不据空 Job 授权覆盖；已创建实例的就绪失败仍需证明自有启动已清理。旧版恢复启动使用同一边界，失败报告软件已恢复但启动未确认，不再次递归恢复。

npm 恢复前的占用检查覆盖原 prefix 内 CLI 及嵌套、提升两种平台包布局，不要求部分安装后的脚本仍然存在。已有路径组件仍须没有链接/reparse 重定向且类型正确；Node 入口脚本即使被删除，其存活进程仍会阻止覆盖，不被恢复检查终止。

底层 npm 安装失败恢复执行器仅在确认该次工具已退出时，使用 `npm-previous` 中的旧版材料按原 prefix 有界重装；由 npm 管理全局安装元数据，不手工镜像或拷回元数据。隔离 fixture 已验证软件包恢复；实际恢复还必须通过原版 Host/控制链就绪检查，才释放安装保护。工具退出不明、旧版材料损坏或恢复失败时，保留锁、材料和诊断，不继续覆盖。只读最终校验失败不触发恢复覆盖未知安装，也不设置安装写入标记。

事后按仍可见父链枚举可能漏掉已退出中间父的存活后代，不能据空 Job 推断这些未纳入的进程已退出。受保护路径在 activation 参数中加入独有标记；AppX resume helper 读取被挂起进程本身的命令行，仅匹配该标记及已存在调用方 Job 时，在恢复初始线程之前赋值。包级环境不是归属证据；无标记、其他调用方、已运行线程均不能获得本次归属。激活返回 PID 若不在本 Job 中，保留该实例，错误清理也不接管或终止它。Controller 同样挂起创建、加入同一 Job 后才执行，覆盖其持有的安装资源。

StartupRecord 的可选 `launchJob` 只在激活返回实例已经验证为执行前 Job 成员后记录。Updater 始终持有 spawn 前创建的原生句柄；确认本次 Launcher 创建身份及调用关系、该原生 Job 确有赋值记录（可选 `launchJob` 若存在还必须匹配）后，先用原生 active-process limit 封住新成员加入，再有界终止自有成员并等待 Job 为空、Launcher/wrapper 退出。迟到 helper 即使已打开赋值句柄，也不能在最终空检查后恢复新的进程；该 limit 行为包含在 Windows 专属回归中，尚未实际运行。恢复前还只读检查该 prefix 的原生 image 及核心 Node 入口；其他活动持有者只会阻止覆盖，不被该清理步骤杀死。原生 Job accounting 保留已退出成员的累计赋值计数，允许在发布可选字段前已退出的绑定进程被核实；一个从未赋值的空 Job 不是证据。旧 `cleanupComplete`、较新的创建时间、包级环境或返回 PID 均不能替代该证据。此路径已有源码与 Windows 专属测试，但尚无 Windows/MSIX 运行结果，不是自动更新验收。

[ActivateApplication](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication) 仅承诺返回满足激活契约的实例 PID，并不保证新建或唯一发起者归属。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 的默认子进程继承发生在成员加入之后。AppX helper 的线程身份校验、命令行读取、Job 赋值及恢复时点需由真实 Windows/MSIX fixture 验证，不能以宿主测试或交叉编译代替。较 Launcher 新的并发官方进程也不能直接视作自有。EXE 原渠道离线恢复也缺原生可行性证据，尚不是完整的一键更新闭环。不能将后台交接、npm 或安装器成功退出视为一键更新验收，也不保证完整自动回退或断电恢复。Windows 按钮已按后端支持性开放，实际升级验收仍由用户手测完成。

手动修复应先确认本次 Updater、npm 工具及目标实例均已退出，核对 `request-v1.json` 中原 prefix、旧版归档路径及 SHA-256，再通过原 Node/npm CLI 使用本节的严格离线参数恢复；保留无关全局包，不跨渠道迁移。缓存和空 npmrc 路径也记录在 `installation.recovery` 中。Windows 安装包应使用原渠道、原目录的安装器修复，不假定本地已经具备旧版 EXE。只有确认原版本、安装路径及正常启动均恢复后，才可清除相应的 `active-update-v1.lock`；不要将持久的 `.active-update-mutation.lock` 空文件当作需删除的活动锁。原渠道软件包恢复不还原用户数据、数据库迁移或外部 Harness 状态。

隔离自动化检查使用 `npm run test:update-fixtures`，包括正常 registry npm 安装起点、离线两归档执行及原生 relaunch 策略 fixture；Windows CI 已接入该入口。这些测试不启动真实 Codex Desktop，不作为 MSIX 全链路或新 Updater 跨版本升级的验收证据。

### Windows 手测清单

- 从已包含新更新逻辑、且原版材料可获取的 npm/EXE 安装分别更新：非默认 prefix/目录不变，准备时旧实例仍运行；重启后版本正确，设置页显示本次更新成功。旧稳定版首次进入新逻辑版本仍使用原渠道人工安装。
- 在可丢弃的测试安装中制造写入后安装失败或新版启动失败：能恢复时旧版自身 Launcher/Runtime 就绪，页面显示“更新失败，已恢复原版本”，不是更新成功。
- 阻断原版恢复（文件持续占用、材料损坏等）：显示恢复失败/状态未确认，锁和材料保留，不自动再次覆盖。缺少原 EXE 能力标记或准备阶段缺旧材料时，旧实例不得退出。
- 同时保留无关 Node 脚本、另一 prefix/安装目录及独立官方实例：不得误杀或覆盖；无法安全重启时应失败并保留诊断。
- 刷新重启后的 Host/控制台，核对结果仍在；启动别的安装或新 Launcher、放入旧记录，不能串线。另回归 macOS npm/DMG 原流程。

以上为待用户执行项，不是已通过的验收。

### Windows 隔离验收入口

- `npm run test:update-fixtures`：包含共用 Windows apply 编排的聚焦测试，复用 JSON/安装/材料校验、真实锁和状态文件、安装及原工具恢复调用。进程交接、工具实际文件工作及启动结果仅在测试内部替换，覆盖成功、部分写入后恢复、无子进程启动失败、原版启动失败不递归、未知 bind/cleanup 不覆盖、材料变化及锁保留；这不是 Inno/Windows/Host 运行证据。宿主还可运行参数绑定与真实 npm 回归；Windows 另运行挂起子进程/Job、真实 Node Host 发布请求及原生 Helper 锁接管测试。连续两次交接包含旧 Job 清理、Helper 存活及 Node wrapper 重启下一 Launcher；无确认的真实零退出子进程不得触发旧 Job 清理。不是 MSIX 或完整 Codex 升级验收。
- `npm run test:windows-appx`：仅限授权的 Windows x64 一次性用户，设置 `CODEXHOST_DISPOSABLE_WINDOWS_USER=fixture-only` 及独立 `RUNNER_TEMP`，并已有开发包注册权限。脚本编译专用 fixture 与真实 Launcher helper，注册唯一的开发 AppX 包，不注册或启动 Codex Desktop。fixture 检查导入 DLL 的进程附着回调、TLS/应用入口前的 Job 归属、包级环境下无标记实例照常执行，以及中间父退出后的后代清理。完成后删除该测试包；平台不支持 AppX/当前会话不可激活时应报告真实限制。
- `npm run test:windows-installer -- prepare ...` / `run --manifest ...`：固定旧新 EXE、版本和 SHA-256，run 仅允许授权的一次性 Windows 用户及 `RUNNER_TEMP` 新目录。要求用户没有 codexhost 卸载注册信息，使用原安装器做同目录升级、降级、文件占用失败及软件文件故障后的修复；保留另一目录 payload/Node 和用户数据 sentinel。仅对两份测试 EXE 创建出站阻断规则，要求该 disposable runner 有相应权限，结束时移除规则及测试卸载信息。安装参数复用生产 `/NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS`，禁止 Inno 额外关闭或重启未知占用者；独立锁文件持有进程必须存活。比较完整软件文件集合（Inno 自有卸载账本除外），覆盖真实新载荷新增路径及受控注入的 `app/plugins` 新软件文件；原工具未删除新增文件即失败，不以版本号或已恢复的 Host 文件代替。`recovery-evidence.json` 保留比较结果。没有注册表/快捷方式快照回放。这是旧工具能力调查，不是 v1 原工具恢复验收。
- `npm run test:windows-installer -- build-v1 --manifest ...` / `run-v1 --manifest ...`：仅在授权的一次性 Windows x64 runner 构建两个源码/版本一致的私有测试安装器，复用发行构建和 Inno 脚本，不修改工作树版本或发布。新版插件软件文件在编译前进入载荷、所有权清单及 Inno 文件表；检查占用失败、持有者存活、完整原版软件恢复、自定义根用户数据与未知用户插件保留。仅执行生产软件安装/恢复核心，不启动实际 Codex，不替代完整 `apply`、MSIX 或 Host 启动验收。第三方依赖复用已安装目录，但每个 `@codexhost` workspace 链接回私有源码副本，TypeScript 在副本重新构建；实际 Host/Controller/Console/Renderer/插件 bundle 输入必须来自该副本，输出摘要及输入文件摘要写入载荷外 `runtime-source-evidence.json`，再生成安装所有权清单，不仅检查 PE/metadata。

非发布 Windows fixture 复用 `.github/workflows/ci.yml` 的 `pull_request` 触发，不依赖尚未进入默认分支的 `workflow_dispatch`。普通 Windows CI 运行组件；创建标题以 `[windows-fixtures]` 开头的草稿 PR 时，额外构建 v1 原工具测试材料并运行隔离恢复核心；正文 `[run-legacy-inno]` 可单独选择固定摘要的 v0.14.0/v0.15.0 旧能力调查。正文另含 `[run-appx-probe]` 时才尝试真实开发 AppX；托管 Windows Server 的 AppX/交互会话限制会直接报告失败，不当作通过。日志及比较结果上传为 `windows-update-fixture-evidence`，不发布产品。未获明确授权不得提交、推送或创建 PR，仅推送新分支也不触发该 PR 路径。验收区分旧稳定版按既有方式安装含新逻辑版本，以及含新逻辑版本一键升级后续版本；旧 EXE 的降级 fixture 不替代后一条。新更新器的正常原版恢复面向已经包含该保护能力的原版本，不引入混合版本 bootstrap；手工将内部新 helper 指向前保护时代安装不构成受支持的自动入口。

### 真实 Codex/Host 连续更新 smoke（代码入口，未验收）

`npm run build:typescript` 后可用既有 fixture 入口 `npm run test:windows-installer -- smoke --manifest <absolute-json>`，不新增更新 CLI。该模式会实际启动已安装的 Codex，不能在日常用户或未经授权的 CI 中运行。前置条件：

- 单独获准的一次性 Windows x64 **交互**用户；`CODEXHOST_DISPOSABLE_WINDOWS_USER=fixture-only`、已有 `RUNNER_TEMP`，其中已经按原渠道安装带新逻辑的 codexhost。数据/更新状态使用全新的直接子目录；安装根或 npm prefix 必须在 scratch 内。npm 初始平台包需已提升到原 prefix 的 `node_modules/@codexhost/cli-win32-x64`；嵌套到提升的软件转换另由 npm fixture 覆盖。
- 真实 Codex Desktop 已注册且该用户可以使用现有生产 debugger/resume 激活能力；manifest 指定已有 `WindowsApps/OpenAI.Codex_*/app/ChatGPT.exe`。入口不会下载、安装或注册 Codex，不启用 Developer Mode、不导入证书。不能有需要保留的并发官方实例；初次启动也用生产 caller-held Job 保护路径，不走会强退其他实例的普通启动。
- 三个递增精确稳定版本，分别具有同一构建产生的 Launcher、Updater、Host SHA-256。后两版必须依次能被**实际生产 GitHub latest/npm registry**发现，且原版本恢复材料齐全。入口不伪造 latest、不发布或切换 Release；私有 99.0.1/99.0.2 两安装器不是这项前提。
- 生产入口使用真实支持性及准备校验，不提供 manifest/环境变量跳过能力。执行该专用 smoke 仍需上述三版物料、发现顺序和交互环境；不放宽就绪条件，不混用 Launcher/Runtime。初始 native helper 只是 test binary 中 ignored 的真实启动观察者，不安装软件、不替代实际更新器；更新请求仍走真实 Host 固定无参数接口和安装版自身 Updater。

配置为 JSON：`authorization: "real-codex-host-smoke"`、`installation: "npm" | "windows-installer"`、绝对 `root`（新 scratch 子目录）、`resourcesRoot`、`codexDesktopExecutable`，以及 `versions` 三项，每项含 `version`、`launcherSha256`、`updaterSha256`、`hostSha256`。npm 还需原始绝对 `nodePath`、`npmCliPath`、`npmLauncherPath`、`prefix`。摘要来自相应一致构建，不能用占位值或仅改 metadata。

入口仅首次启动；随后两次调用真实 Host `check/start`，观察实际操作目录、本版暂存 Helper 摘要、native `succeeded`、新 nonce/PID、对应 StartupRecord、Controller PING、Host `/ready` 和实际运行/安装版本；两次更新之间不人工重新安装或重启，不以进程存活代替就绪，也不要求 Harness 登录。启动 RPC 连接中断时仅观察同一操作，不重发可能已接受的请求。失败保留私有证据和材料，不按进程名清理；最终实例留待明确归属的人工检查/关闭。`smoke-evidence.json` 不包含 bearer/nonce，不是新的生产启动回执。

该入口当前只准备正常连续生命周期，尚未运行。真实 Codex 下的禁网/故障注入恢复 smoke 编排尚未补齐；已有正常连续入口未执行，ARM64 与 macOS 实际升级也未验收；便携编排测试和软件核心恢复不能代替它们。真实 smoke 不随普通组件测试或现有 PR opt-in 自动运行。

### Windows 安装包覆盖安装

用户点击“安装”后、覆盖文件之前，安装器使用包内提取到临时目录的原生 Updater 自动关闭目标安装的 Launcher、内置 Node（包括独立控制台）、Shim 和 Updater 进程。关闭目标按完整可执行文件路径筛选，以 PID 和创建时间标识进程实例；优先通过 Windows Restart Manager 关闭，不支持该机制的无界面进程按原进程实例终止。运行中的任务可能被中断。

安装界面不增加关闭提示或确认；只打开安装器、在点击“安装”之前取消，都不会关闭进程。其他安装目录或系统 Node 不属于关闭目标。无法完成关闭时停止安装并报告错误，仍保留安装器对其他文件占用的检查。安装器本身不自动重启应用；由更新流程启动的安装仍由外层 Updater 完成重启。

## 连接页（codexhost 未运行时）

codexhost 未运行时，“连接”页列出已安装的插件（读取 `manifest.json`，不执行插件代码）及是否启用，并可修改接受自定义安装路径的插件的路径。路径与 Codex 设置页共用 `<数据目录>/harness-launch-settings/<插件>.json`；codexhost 运行中修改时，在重新启动 codexhost 后生效。插件目录与 Host Runtime 一致：发布包的 `app/plugins`，以及 `CODEXHOST_PLUGIN_DIRECTORY` 或 `<数据目录>/plugins`。

## 诊断包与 Issue

- “导出诊断包”下载 JSON：状态、Codex 与 codexhost 版本、最近 5 次启动记录、注入状态，以及最新两个 Host Runtime 日志的末尾 32 KiB。用户主目录替换为 `~`，其他内容（如日志中的项目路径）不做处理，分享前请检查。
- “提交 Issue”打开 GitHub 新建 Issue 页面，预填版本、系统、状态和错误，不包含日志。

## 其他命令

`codexhost inspect --json` 输出 Codex Desktop 安装信息与 Launcher 运行状态；未找到 Codex Desktop 时在 `desktopError` 中说明，不以失败退出。
