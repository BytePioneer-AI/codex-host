# ZCode Adapter

插件 ID 为 `zcode`，直接运行已安装 ZCode Desktop 自带的 Agent CLI 执行独立会话，复用同机登录的 Start Plan 账号。不需要构建运行包，不修补 ZCode，不依赖 Desktop 窗口、官方远控 Relay 或配对链接；CLI 随 Desktop 自动更新。

Adapter 拥有每个 Session 的 CLI 进程、原 ZCode Services 在转发之外承担的少量职责（账号配置推送、请求期鉴权应答、反向请求应答、参数投影）以及 Host 事件投影。CLI 拥有 Provider 注册表、Agent 执行和会话持久化。Host 仍通过公共 Loader、Adapter/Session 契约、共享 Harness 路由及 Mapping Store 管理任务。

首版只创建和恢复 codexhost 自己的会话，不导入 Desktop 已有会话。

## 安装

安装 ZCode Desktop 并在其中登录 Start Plan 账号，然后在 codexhost 中重新检测。默认使用 `/Applications/ZCode.app`；可以在连接设置中保存应用位置（插件启动路径），或设置 `CODEXHOST_ZCODE_APP`，保存的路径优先。缺少 `Contents/Info.plist` 中的 `CFBundleExecutable`/`CFBundleShortVersionString`、对应的 Electron Helper 可执行文件（`Contents/Frameworks/<CFBundleExecutable> Helper.app/Contents/MacOS/<CFBundleExecutable> Helper`）、`Contents/Resources/glm/zcode.cjs` 或内置 Provider 配置时，检测结果为未安装。对 Host 的 Node 版本没有额外要求。

检测会建立一个 deferred 草稿会话读取模型目录后立即关闭；草稿在首条输入前不落库，检测不会留下会话，也不发送 Prompt。

## 进程与协议

每个 Session 一个进程：`<App>/Contents/Frameworks/<CFBundleExecutable> Helper.app/Contents/MacOS/<CFBundleExecutable> Helper <App>/Contents/Resources/glm/zcode.cjs app-server --stdio --surface desktop`，cwd 为工作区，并设置 `ELECTRON_RUN_AS_NODE=1`。这与 ZCode Desktop 启动自带 CLI 的方式相同（开源 `zcodeAgentProcessManager.ts` 的 `resolveBundledWorkspaceZCodeAgentCommand`，Desktop Host 作为 utilityProcess 并在 spawn 时使用 `process.execPath` 即 Helper）：CLI 运行在 App 自带的 Electron Helper Node 上，属于后台 `UIElement` 进程，不会在 macOS Dock 栏产生独立应用图标，其插件中为 Electron 预编译的原生模块也因此可用。与 Desktop 一样，CLI 的工具子进程会继承 `ELECTRON_RUN_AS_NODE`。环境变量为 Thread 环境加上：

- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`：已装 App 的 `config/provider/zcode-builtin.json`（环境中已显式设置时沿用）。
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`：`{ZCODE_DATA_BASE_DIR || HOME}/.zcode/v2/provider_config.json`（已显式设置时沿用）。

两者都显式传入，CLI 才直接使用这份内置配置，账号配置的 revision 才能对上。

协议为按行 JSON-RPC，只按 LF 拆帧（模型文本可能含 U+2028/U+2029），单行上限 64 MiB。CLI 的参数 schema 是 strict，Adapter 在 `src/methods.ts` 一处把会话操作投影为 CLI 请求：补 `workspace` 引用、V4 订阅的 `topic`/`connectionId`/`clientMode`，并按方法设置超时（默认 3 分钟，compact 5 分钟；V4 `sendText` 在原生 TurnStarted 提交后才确认）。创建和输入使用原生 V4 命令；`session/subscribe` 订阅事件流，事件按 `sessionId` 分发。

CLI 发来的反向请求（`src/transport.ts`）：

| 请求 | 应答 |
| --- | --- |
| `session/requestRuntimePreferences` | 显式回 strict 结果；`askUserQuestionAutoResolutionEnabled: false`，提问由 Host 用户作答，不自动结束 |
| `interaction/requestPermission`、`requestUserInput` | 按业务 `requestId` 去重，只上报一次；不回 RPC，经 `v4/command resolveInteraction` 作答 |
| `interaction/requestProviderRuntimeHeaders` | 见下文账号与鉴权 |
| `interaction/requestOfficialMcpAuthHeaders` | `{ok:false, reason:"official_auth_unavailable"}` |
| `interaction/browserList` / `browserExecute` | 空列表 / `backend_unavailable` |
| `automation/*`、`offPeak/*` 及其他 | `-32601`；创建会话不开启 Off-Peak 与动态工作流工具 |

## 账号与鉴权

首版只支持 Start Plan。凭据只读：Adapter 读取 ZCode Desktop 写入的 `{ZCODE_DATA_BASE_DIR || HOME}/.zcode/v2/credentials.json`，从不写入，也不复制到 codexhost 配置、Native Ref、日志、错误信息或磁盘。

- **账号配置**：进程启动后、任何会话操作之前推送 `provider/updateAccountConfig`。账号家族（`zai` / `bigmodel`）取自凭据 `oauth:active_provider`。Adapter 在内存中读取 JWT 及 `~/.zcode/v2/telemetry-state.json` 中的 `deviceMid`，向服务端请求余额与权益信封（`GET <origin>/api/v1/zcode-plan/billing/balance?app_version=<version>`，携带 Bearer JWT 与 `X-Device-Mid`，超时 15 秒）。按 Desktop 规则先执行到期规范化（已过 `ends_at` 的活跃计划标记为 `expired` 并剔除关联余额）；仅当存在 active 的 Start Plan 时判定为 entitled，可用模型严格从余额的 `model:*` capability 提取，并针对内置配置对应的 `builtinModelIds` 规范化为官方模型 ID 大小写。若无有效订阅、订阅未生效（pending）、未登录、缺少设备 ID 或请求失败，均按 fail-closed 处理（`entitled: false`、`availability: "unavailable"`、`unavailableReason: "not-entitled"`，不注入模型）。Overlay revision 随计算出的 providers/states 摘要变化。`basedOnZCodeBuiltinRevision` 为 `zcode-builtin:<release.revision>:<sha256(内置配置绝对路径)>`，与 CLI 自己的内置层不一致时 CLI 会静默保留旧注册表，因此回执的 `receivedRevision` 必须等于发出的 revision。未登录时推送空 Overlay，只剩个人 Provider。账号在进程生命周期内不重新推送，切换账号后需重新打开 Thread。
- **请求期鉴权**：CLI 对 Start Plan 的每次模型请求发出 Header 请求。Adapter 在内存中解密 `zcodejwttoken`（`enc:v1:`，AES-256-GCM，密钥为 `sha256(ZCODE_CREDENTIAL_SECRET || "zcode-credential-fallback:<platform>:<homedir>:<username>")`），调用验证器取得一次性验证码 Header，回 `{headersApplied:true, requestAuth:{apiKey, headers}}`。其他账号模式、凭据缺失或解密失败回 `{headersApplied:false, errorMessage}`，提示在 ZCode Desktop 登录。收到 `interaction/providerRuntimeHeadersCancelled` 时中止对应请求的验证。设置了 `ZCODE_DATA_BASE_DIR` 或 `ZCODE_CREDENTIAL_SECRET` 时须与 Desktop 登录环境一致。

## 账号验证页

验证器在 `src/verification/`，接口为 `verify(signal) → headers`、`prewarm()` 与 `close()`。与 ZCode Desktop 一个窗口服务所有会话一致，整个 Adapter（即一个 Host）共用一个验证器：懒创建，Adapter 关闭时关闭。所有 Session 的验证请求进入同一个串行队列；每个请求只由自己的 signal 取消，Session 或其 CLI 进程关闭时只取消它自己进行中和排队中的验证，不关闭共享页面，也不影响其他 Session。页面的打开归验证器所有，发起打开的请求被取消时，页面仍继续加载供后续请求使用。

验证码公开配置按所用 ZCode.app（与 CLI 同一个安装位置，含连接设置中保存的路径）的版本请求。当配置中 `enabled === false` 或 ZCode 3.14.4+ 的 `skip_model_request === true` 时，Adapter 视为无需验证码，请求期回空 Header，验证记录记为 `not_required`，不打开验证页。当需要验证时，验证页常驻 Codex 内置浏览器的后台标签页，复用页面和 SDK 脚本，每次验证新建一个 SDK 实例：页面生命周期内脚本只加载一次、任务连接只建立一次；每个任务清空挂载元素后重新调用 `initAliyunCaptcha`，拿到实例后按 Desktop 的规则等到距脚本加载满 2 秒，再调用一次 `startTracelessVerification()`，任务以任何结果结束后丢弃该实例。服务端的无感超时从页面实际开始验证时起算，等实例的时限为 10 秒，均与 Desktop 一致。SDK 回调绑定到所属实例和任务，已丢弃实例的回调只记诊断；SDK 在弹出挑战时重复调用 `getInstance` 不影响进行中的任务。需要人工操作时才显示页面。验证结果只用于对应请求，不缓存、复用或写入历史/日志。

预热：第一个 Session 成功打开（新建或恢复）且当前账号实际具备 Start Plan 权益（`startPlan === true`）时，触发一次 `prewarm()`：配置启用且未跳过模型验证时打开常驻页、加载 SDK 脚本并初始化一个实例，不执行验证，这个实例只供第一次验证使用；检测（inspect）不触发。配置未启用或没有本地页面能力时不做任何事。预热失败只让页面暂不可用，不影响 Session 打开，下一次验证按常规重新打开。用户关闭标签或页面所属任务失效后，下一次验证或预热会重新打开页面。受管远程 Host 不提供本地页面能力。

内置浏览器的存储是一个全局分区（`codex-browser-app`），不按任务区分；标签页只是按 conversationId 挂在某个任务的侧栏下。这一点是根据 Codex Desktop 的数据目录结构推断的，不是公开契约。常驻页挂在打开时可见的任务下。

2026-09-28 在真实 Codex Desktop 中用探针页（不是真实验证码 SDK）实测了后台页的存活：页面在创建时的任务中加载后，用户切到另一个任务停留两分钟以上，服务端推送（SSE）与页面回传（POST）始终正常（50/50，往返不超过 3 ms），页面没有被卸载或暂停；`show()` 能切回所属任务并使页面可见。之后主控在真实 Codex Desktop 中复测，用户切到其他任务后后台页仍持续运行。

同日的真实 Start Plan 验收（当时仍是每个 Session 一个页面）：第 1 轮带工具的多步任务成功，恢复后第 2 轮也成功。第 1 轮在新页面、刚加载 SDK 后的首次验证要求了用户手动完成；第 2 轮换成新会话、新页面后无感通过。改为 Host 共用并预热，是为了和 Desktop 一样让 SDK 在首次请求前就绪、跨会话复用页面，但风控结果由服务端决定，不能保证总是无感。

2026-09-28 的诊断实验（真实账号、隐藏页，两轮分别用 8 秒和 30 秒无感超时，每轮一个带工具的多步任务）确认了根因：每个页面的第 1 次验证都在隐藏状态下约 0.5 秒无感通过（此时 `requestAnimationFrame` 超过 1 秒未回调），隐藏页限流不是原因。当时的实现在同一页面复用 SDK 实例，第 2 次验证时 SDK 连续回 `fail`（`verifyCode: F008`，重复提交）而转人工；`show()` 后 SDK 又调用 `getInstance`，旧实现据此重建任务连接并清掉当前任务，用户完成挑战后的 `success` 无法归到任务上，任务在 120 秒后过期。Desktop 每次验证结束都重置控制器，下一次重新初始化实例，并忽略过期控制器的回调；现实现照此修正。

F008 的处理：本次验证失败（结果记 `error`，诊断带 `duplicate: true`），丢弃该实例，不关闭页面，下一次验证用新实例。这与 Desktop 识别到重复提交后的处理一致；Desktop 不在同一次验证内重试，CLI 的 `captcha-retry` 只在服务端以错误码 3007 拒绝验证结果时重新请求一次 Header，与 SDK 的 F008 无关。其他实例级失败（`onError`、无法归类的 `fail`、实例 10 秒内未就绪）同样只让本次验证失败；只有 SDK 脚本加载失败或尚无任务时的初始化失败才关闭页面。

诊断：每次验证在 stderr 写一行 `[zcode-verification] {JSON}`，由 Host Runtime 记入 `host-runtime-<pid>.log`（见 [Host Runtime 日志](../../operations/host-runtime-log.md)）。字段包括页面序号、存活时长与第几次验证，排队与开页耗时，任务送达页面的耗时，所用 SDK 实例序号（`instance`）与从推送到开始无感验证的耗时（`startedMs`），是否 F008（`duplicate`），页面开始验证时的 `visibilityState` 与一次 `requestAnimationFrame` 的实际延迟（超过 1 秒记 `>1000`，页面未回报记 `unreported`），SDK 回调（success / fail 的 `success`、`verifyResult`、`verifyCode` / onError 的错误码或名称），转人工的来源（`sdk` 为 fail 且 `verifyResult=false`，`timeout` 为服务端无感超时），是否调用 `show()`，以及结果（`traceless_passed`、`interactive_passed`、`cancelled`、`expired`、`page_closed`、`error`、`not_required`）与总耗时。页面生命周期另记 `page_open`、`page_script_loaded`、`page_instance`（含实例序号，重复回调同样记录）、`page_ready`、`page_visibilitychange`、`page_closed`（含原因）；已丢弃实例的回调记为 `page_sdk_callback`，带 `stale: true`。页面回报经服务端白名单过滤，日志中不出现证明、JWT、页面 token 或 URL。`createZcodeVerifier` 可注入无感超时、就绪超时、实例等待和交互时限，仅供测试和实验，默认值与 Desktop 一致。

## 能力与限制

- 支持独立创建、多轮、取消后继续、可写恢复、只读历史、Model/Thinking/权限选择、工具输出、原生文件差异、Approval/Question 与 Usage。模型目录与推理档位（含默认档位）来自 CLI 的会话快照；显示名为 `Provider / Model`。
- 不导入 Desktop 已有会话，不开放 Fork、修订上一条消息或子代理 Transcript。子代理状态与自主 Turn 按原生事件投影。
- 空 V4 草稿由原生以 deferred 语义持有，首条发送才持久化；尚未发送的草稿关闭后不能恢复。
- 官方 MCP 插件拿不到身份 Header；浏览器、Computer Use、Off-Peak、自动化和账号切换 UI 不提供。会话标题生成同样会请求 Header 并触发一次验证，结果不影响主轮。

## 验证

原生测试运行已装 CLI，`HOME` 与 `ZCODE_DATA_BASE_DIR` 指向临时目录，模型请求指向本地模拟 Provider，Start Plan 用例使用自行加密的合成凭据、指向本地的内置配置副本和假验证器，不读取真实 `~/.zcode`：

```sh
CODEXHOST_TEST_ZCODE_APP=/Applications/ZCode.app npx vitest run --config tests/vitest.config.js packages/adapters/zcode/test/native.test.ts packages/host-runtime/test/app-server-host.zcode.real.test.ts
```

Host 集成测试需要先 `npm run build:typescript` 生成插件包。2026-09-28 在 macOS arm64 / ZCode 3.14.3（CLI 0.16.9）上，Host 分别使用 Node 22.22 与 Node 24 均通过：目录、检测不留会话、多轮/恢复、取消后继续、并行工作区工具环境、原生提问、审批、配置、文件差异，以及 Start Plan 的 JWT 与验证码 Header 注入、多个 Session 共用一个验证器且只预热一次；真实 Loader → Host 路由 → 原生 Turn → 历史路径另有集成测试。验证页的共享队列、取消隔离、预热、每次验证新实例、过期回调隔离、F008 与“`show()` 后再次 `getInstance` 再 success”另有单元测试和使用合成 SDK 的浏览器测试（`tests/e2e/zcode-verification.spec.ts`，可用 `CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH` 指定本机 Chrome）。真实 Start Plan 验收见上文“账号验证页”；Windows、Linux 和 SSH 未验证。
