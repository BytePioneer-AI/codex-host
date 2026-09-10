# 可行性证据与验证边界

## 生产切换检查点

生产组成现已对本地 stdio 和 Windows Desktop/Remote Control 使用一个 `OfficialRuntimeScope`、一个受监督官方进程树和一个共享原生 home。SSH 暴露服务器原生单账号能力并拒绝账号 mutation。v1 Pool、按账号 listener、Thread 绑定、多账号官方列表扇出及 draft 账号注入已从可运行生产代码删除。

本轮在 Windows 实际执行：`npm run typecheck`、`npm run lint`、Host/Owner/Account/Renderer 聚焦测试（额度实现更新后的组合运行 **214 项通过**）、使用真实 launcher 与 Codex CLI 0.153.4 的 `native-bootstrap.test.ts`（stdio、loopback、plugins-enabled 共 3 项通过）、真实 Windows launcher 的 `native-private-files.test.ts`（5 项通过）、Account Renderer Playwright（两个文件 **14 项通过**，包含所有账号额度保留、失败 refresh 保留 last-good 以及额度读取期间立即点击切换）、`cargo check --workspace` 与 workspace Clippy `-D warnings`。WSL Ubuntu 24.04 使用原生 Rust 1.97.1 构建后，platform 私有文件 4 项、launcher 私有 IPC 2 项以及生成子进程的 supervised-tree receipt 探针通过；另以实际 launcher 验证 0700/0600、slot/snapshot/backup/temp 和宽权限失败前无秘密文件落盘。该运行同时发现并修复了 Unix relay 对 Windows-only spawn API 的错误导入和缺失的 Unix 树退出等待。

账号额度边界随后按用户确认改为 OpenCodex 风格：新增 Host 级 `ManagedCodexAccountQuotas`，当前账号仍经唯一官方后台读取，非当前账号使用私有槽位直接请求 `https://chatgpt.com/backend-api/wham/usage`。实现包含 4 路有界并发、8 秒超时、5 分钟内存 TTL、per-account single-flight、401 后一次 OAuth 刷新重放、JWT 用户＋工作区身份复核、槽位摘要 CAS 和原子写回；成功快照按稳定账号 ID 持久化六小时，文件与 RPC 只包含归一化窗口、重置卡和时间，不含 Token、原始响应或私有路径。网络、认证、解析或 CAS 失败保留 last-good 快照；普通 WHAM 读取不阻塞整个账号库，只有 OAuth 刷新／写回阶段由共享 gate 登记，切换不能与非当前 Refresh Token 旋转交错。Renderer 切换只等待源与目标账号的在途读取。聚焦测试覆盖重启恢复、同账号合并、旋转写回、迟到刷新不覆盖新槽位、当前 Native／非当前 WHAM 路由和 Renderer 手动刷新保留。

Harness 选择器随后按产品语义收敛：不再创建 Codex 账号分组、账号行、账号点击切换或多账号徽标，始终只保留一个 Codex Harness 选项；当前账号只用于 Composer tooltip 与用量身份展示，设置页继续承担保存账号列表和全局切换。设置式切换通知会刷新所有相关草稿 Composer 的当前额度。针对该收敛执行 `typecheck`、`lint`、6 个 Renderer 聚焦文件 **119 项测试**和 3 个 Playwright 文件 **15 项测试**，全部通过；E2E 明确断言 Harness 菜单不存在 `[data-codex-account-id]`，同时设置式全局切换仍同步当前身份、额度、多 Host 隔离、busy 和失败恢复。

生产迁移现实现保留源 home 的 rollout-only／credential-only 支持路径：私有 prepared/committed 记录、共享原凭据私有备份、身份去重、旧 active 恢复、`sessions`／`archived_sessions` 原子 no-overwrite 复制、同内容跳过、冲突阻断和中断重试。现场 v1 布局盘点为两个账号、一个次要 credential-only home，满足该支持路径；盘点与验证未输出认证内容。附件、记忆、项目、关系、工具及其他原生数据库状态仍按支持矩阵阻断。

多 home 生产迁移只接受仍存活且出生身份可核对的 native launcher 接管链；无该证明的直接 Host 启动在迁移写入前失败。测试覆盖证明缺失、WAL/SQLite 读取失败和目标冲突阻断。

Windows 现场随后复现了官方 `.codex` 的真实 ACL：home 与 `auth.json` 包含 `CodexSandboxUsers` 的只读／遍历权限。原先把整个 home 当作严格私有目录的检查会在任何秘密写入前拒绝，导致 `Codex is unavailable`。修复后仅共享 native home 接受非宽泛主体的只读 ACE；Sandbox 写入／删除／DACL 修改仍被拒绝，Everyone、Users、Authenticated Users 等宽泛读取仍被拒绝；slot、备份、迁移记录以及 `.codexhost-native-accounts` 内的 writer lock、进程 witness 与退出回执保持严格私有 DACL。Windows platform 私有文件测试现为 5 项通过，真实 launcher 私有 IPC 5 项通过；实际 home 的目录检查与 `auth.json` 读取成功且未输出认证内容。

同一现场还发现 Desktop 被强制关闭时 native supervisor 可能来不及发布退出回执。生产记录保存的是 supervisor PID 与出生身份，而非官方 root PID；Windows supervisor 独占不可继承且启用 `KILL_ON_JOB_CLOSE` 的 Job handle。因此只在 Windows、只在确认该精确 supervisor 已退出或 PID 已复用时，允许以 Job handle 关闭的内核保证作为整棵树退出证明；`starting` gap、身份查询失败、仍存活的同一 supervisor、Unix PID 消失或错误 tag 回执仍 fail closed。聚焦测试覆盖该恢复分支。

修复后从本工作树连续执行两轮真实 `npm start -- --no-build`。每轮均在 40 秒观察窗内保持 1 个 Host Runtime、1 个 native supervisor、1 个官方 Codex 进程及 Desktop 进程；第二轮先停止第一轮 Desktop，成功从缺失回执 witness 恢复。Electron Inspector 两个 page target 可读，主页面未出现 `Codex is unavailable`。

真实账号页首次切换又暴露两个阻断：idle 预检会对归档 Thread 调用原生 queue／goal 接口，而 0.153.4 对归档 ID 明确返回错误；账号页打开时自身发起的当前额度读取也会与立即点击切换竞争，返回 busy。修复后归档历史仍核对持久状态但不调用不支持的 queue／goal 接口；账号页会显式等待自己发起的幂等额度读取完成，再执行用户已经点击的切换，不需要第二次点击。现场 345 个 Thread 中 339 个未归档、6 个归档，全部为 `notLoaded`；未归档 queue／goal 均为空，归档 6 个对应接口均返回错误，验证了原阻断来源且未输出 Thread ID 或内容。

随后在真实 Desktop 中完成 B→A→B 两次 UI 切换。第一次前后 launcher PID `25032`、Desktop PID `3496`、Host Runtime PID `15544` 保持不变，官方 Codex PID `11660`→`6460`、supervisor PID `8572`→`16596`；第二次 Host Runtime PID 仍为 `15544`，官方 PID `6460`→`11000`。账号元数据与 Renderer 均确认最终当前身份为目标 B，界面无失败提示。该证据覆盖真实 Desktop 的核心 PID 隔离和 UI 点击链路，但尚未同时运行外部 Harness 流式 Turn／工具审批／取消，因此仍不把 10.3 标记为完整通过。

上述结果仍不等于完整 Desktop 切换 E2E、真实 Refresh Token 轮换或 macOS／真实 Linux Codex/SSH 实机证据。

## 测试环境与方法

2026-09-08，在 Windows 上使用实际安装的官方 `codex-cli 0.153.4` 与两个已授权测试身份做隔离试验。协议类型由该二进制 `app-server generate-ts --experimental` 生成，未猜测登录接口。测试模型为当时目录返回的默认 Model；结论不以具体 Model 名称为契约。

所有 Turn 使用临时独立 `CODEX_HOME` 与短合成标记，不上传现有用户对话。原凭据只读取用于授权试验；原始认证文件在各次测试前后校验未变。真实 Refresh Token 没有用于轮换调用；原生凭据文件试验只在临时文件中装入有效 ID/Access Token，Refresh Token 留空，结束后删除临时认证文件。

基线直接使用内置 Provider。身份观测试验因官方禁止覆盖内置 `openai` Provider，使用官方自定义 Provider 配置（`requires_openai_auth=true`、`supports_websockets=true`），经只绑定 loopback 的临时转发器访问真正的官方模型服务。转发使用系统现有代理且保留 TLS 证书验证。只记录握手 Token 与测试身份的匹配结果，不记录 Token 值。

因此，以下证据验证官方客户端在该可观测配置中的请求行为及真实响应；不等于对未修改内置配置的全链路观测，更不是服务端 Billing Source 审计。临时网关不是产品架构的一部分。

## 结果

| 项目 | 观测 | 能支持的结论 |
| --- | --- | --- |
| 内置 Provider，`chatgptAuthTokens` A→B→A，继续同一 Thread | `account/read` 切换，三轮都成功且记得合成标记 | 登录和上下文连续性可行，但单独不能证明模型身份切换 |
| 可观测 WebSocket，A 登录后热切 B | `account/read` 显示 B，下一轮仍从 A 握手建立的 WebSocket 发出；发送帧不含 B Token | 不能以登录成功作为可靠热切换完成标准 |
| `thread/unsubscribe` 后立即 `thread/resume` | 本次仍复用 A 连接 | 简单立即重订阅不能代替连接销毁；未测试等待完全卸载后的行为 |
| 停止后台，同 home 重启，以 B 登录并恢复原 Thread | 新模型握手匹配 B；原 Thread ID 和标记保留 | 受控重启＋原生恢复的关键路径成立 |
| 原生文件型 `chatgpt` 认证，按 A→B→A 每次停止后替换临时凭据并恢复原 Thread | 三次 `account/read` 均匹配预期，模型 WebSocket 实际依次使用 A、B、A；两次 resume 保持原 ID，A 首尾 Turn 完成且原日常凭据哈希未变。B 的本次 Turn 到达服务后因 workspace credits 耗尽失败；此前 A→B 探针已完成并保持上下文 | 证明受控重启会切换实际请求身份且可回到 A，不把本次 B 的额度失败写成完整 A→B→A 内容连续性通过；临时 auth 已删除 |
| 对 B 的握手人为返回一次 401 | 收到 `account/chatgptAuthTokens/refresh`，原因 unauthorized；回传 B 的仍有效 Access Token 后真实请求完成 | 验证外部 Token 回调链路，未验证真实 OAuth 刷新轮换 |
| 两个不同用户属于同一 Team | 工作区 ID 相同，用户身份与 Token 不同 | 工作区 ID 不能唯一确定凭据条目或刷新写回对象 |
| 两个测试 home 的 legacy/paginated rollout 复制到已初始化目标 home，不复制源 SQLite | 官方列表发现两者；resume 保持 ID，分别恢复原历史；真实下一轮正确记住标记 | 简单对话支持原生恢复，不证明项目／附件／关系等完整目录迁移 |
| 现有第二账号数据盘点 | 当时无 Thread 或 rollout | 该现场可保留原生 home，不能作为所有用户都无迁移数据的假设 |

## 尚未证明，实施验收必须覆盖

1. 完整 Desktop 传输不重启、多个官方连接重建，以及运行中的其他 Harness、工具与审批不受影响。
2. 真实 OAuth Refresh Token 轮换、过期、撤销、刷新失败、停止期间刷新、目标失败后的最新 Token 保存与崩溃恢复。
3. Windows 私有 DACL、安全存储不支持场景及独立原生客户端对共享 home 的竞争。
4. 当前支持版本的自动继续、原生队列、实时会话、委派等工作准入边界。
5. 归档、项目／分组、附件、动态工具、Fork／子会话关系、记忆、其他 SQLite 状态、冲突 Thread 和配置差异的完整迁移。
6. Linux/macOS 本地切换及 Linux SSH 服务端单账号限制；Windows 实测不替代这些平台测试。

## 实施阶段新增证据：原生存储预检的时序

针对同一 `codex-cli 0.153.4`，使用独立空 home、清除认证环境覆盖，未装入账号凭据或发起 Model Turn：

- 初始化前调用 `config/read` 返回 `-32600: Not initialized`；完成 `initialize` / `initialized` 后才返回实际配置，默认 `cli_auth_credentials_store` 为 `file`。
- `doctor --json` 的 `auth.credentials` 报告 `auth storage mode: File`，但其 `desktop.app_server.handshake` 同时报告成功初始化了 app-server。它不能直接当作已证明无后台副作用的离线预检；本次不根据报告措辞推断具体子进程数量或关闭保证。
- 用户已批准唯一后台配置核对启动、停止、恢复、正式启动的顺序，`design.md` 和凭据生命周期 spec 已同步。实现及最新限制见 [implementation-audit.md](implementation-audit.md)；授权不等于生产组成或全部配置验收完成。

## 实施阶段原生回归（2026-09-09）

`native-bootstrap.test.ts` 使用明确指定的 0.153.4 二进制、独立 home/cwd、空认证存储和禁用 plugins 的配置，分别运行 stdio 和私有 loopback：

- 原生命名操作使新草稿具备可恢复 rollout；两个原生客户端可 attach 同一个 ID。只做配置、命名、目标／队列、恢复及无活动 Turn 的 interrupt，不提交 Turn 或模型推理。
- 之后修改的 Model 能在后台更换后保持，恢复后通过原生 `thread/read` 核对，而非重放最初的 Model 参数。
- 配置核对启动没有加载原 Thread，目标和队列仍持久化，合成 endpoint 计数不增加。此计数不是网络审计：另一次已撤去的失败 Turn 探针遇到未到达 fixture 的 HTTP 502，所以不据此证明所有出站连接都不存在。
- 官方 capability-token 模式确实保护 loopback：无令牌／错误令牌握手失败，正确客户端能分别初始化。随机令牌仅保留内存和请求 header，后台参数只包含 SHA-256 摘要。
- 默认 plugins 配置曾出现后台 Git 同步和目录占用；禁用后探针可清理。这要求继续完成进程树监督与旧写入者协调，不能把主 PID 退出当作整个后台进程树已停止。原生失败 Turn 后的 `systemError` 与真实工作状态也仍需专门核对。

本检查点 `typecheck`、`lint`、16 个聚焦文件的 **258 项测试**、Windows process identity 单测及相关 Clippy 通过；OpenSpec strict validate 和 `git diff --check` 通过。任务 **10/62**。没有完成 Desktop E2E、真实刷新轮换、迁移、全部默认配置或跨平台验收；旧生产 pool 尚未替换。

## 可重现要求

- 后续复现先生成被测官方版本的协议；只使用隔离测试 home 和合成对话。
- 身份判定比较实际出站凭据与已知身份，或采用等效、经验证的认证观测；不能询问模型“你是什么账号”。
- 对真实刷新测试单独获得可轮换的测试账号，不对日常使用中的账号强制刷新、撤销或复制并发刷新者。
- 回归 fixture 使用合成凭据和脱敏协议，真实 Token、个人账号、日志及临时数据目录不得提交到仓库。
- 本文保留了决定架构的必要证据与局限，不依赖某台机器的 Temp 路径才能理解或执行本提案。
