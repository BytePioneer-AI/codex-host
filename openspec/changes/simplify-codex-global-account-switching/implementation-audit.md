# 实施盘点

## 第四批：生产切换、全局账号契约与旧架构删除

- 本地 stdio、Windows Desktop/Remote Control 和 SSH 监听器均已改为显式共享 `OfficialRuntimeScope`。本地与 Windows 使用 native `supervise-process`、私有退出 receipt、`OfficialProcessRecord` 和一个共享 `CODEX_HOME`；Windows 多客户端使用唯一受保护 loopback 后台。SSH 使用服务器原生单账号、共享逻辑 Owner，并通过能力契约拒绝账号 mutation。
- `AppServerHost` 不再拥有或导出 v1 `AccountRepository`，不再按 Thread/账号选择后台。生产入口均注入 v2 `CodexAccountControl`；无法完成权限、版本、恢复或旧布局预检时只把 Codex 标记为 unavailable，Desktop 输入、External Harness、Mapping Store 和委派服务继续运行。
- 已删除 `codex-runtime-pool.ts`、`account-official-listeners.ts`、`thread-account-store.ts`、`multi-account-thread-list.ts` 及旧路由测试。保留单官方源＋External Thread 聚合、per-client RPC 相关性、旧多账号 cursor 的显式失效和旧 draft 参数的显式拒绝。
- v2 公共契约现返回 `version/currentAccountId/phase/revision/capabilities/accounts`，不包含 `codexHome/active/isDefault`。Renderer 设置页、Model client 和版本适配器使用 Host 全局 current Account；Harness 选择器只保留一个 Codex Harness 选项，Composer 仅只读显示当前身份。草稿 override/提交注入已删除，并通过单调 revision 通知同步多窗口。旧 create/activate 不再作为 Renderer API 或 switch 别名。
- `ManagedCodexAccounts` 已接通唯一 Owner 的设备代码登录、取消入口、身份去重、当前账号重新登录、非当前删除和登录事务恢复记录。添加账号时有源账号则保存新账号后恢复源账号；无源账号时首次登录成为当前账号。直接 native login/logout 热转发仍被拒绝。
- `ManagedCodexAccountQuotas` 参照 OpenCodex 为非当前账号直接请求 WHAM，使用 5 分钟缓存、4 路有界并发、8 秒超时、per-account single-flight、401 后一次 OAuth 刷新重放、稳定身份复核及槽位摘要 CAS。成功额度按账号原子持久化且不含 Token；失败保留六小时内 last-good 快照。当前账号仍通过唯一官方后台读取；普通非当前 WHAM 探测不阻塞整个账号库，只有 OAuth 刷新／槽位写回进入共享 gate，不创建第二个官方后台或请求级账号路由。
- 切换生产链路使用 `OfficialAccountRuntime` 与 `CodexAccountSwitcher`：关闭 gate、原生 idle 核对、完整进程树退出、保存最新源凭据、安装目标、重新初始化、认证/身份验证、提交当前账号与广播。失败保全目标轮换并回滚；无法证明回滚时仅 Codex unavailable。
- Rust supervised relay 已从 Windows cfg 扩展到 Windows/Linux/macOS 的平台监督实现。WSL Ubuntu 24.04 首次原生构建发现 launcher 误无条件导入 Windows-only `spawn_supervised_before_execution` 且 Unix 缺少 `wait_for_tree_exit`；现已改为 Windows suspended Job 路径、Unix `spawn_supervised` 路径，并为三平台统一真实树退出等待。WSL 原生 launcher 私有文件测试和会生成子进程的 relay receipt 探针通过；仍不能据此声明 macOS 或真实 Linux Codex CLI 生命周期通过。
- 旧 v1 读取和迁移已隔离到 `account/legacy-account-layout.ts`。除单一 home 原地采用外，生产入口现可导入凭据-only 次要 home，并以 issuer＋user＋workspace 去重；若旧 active 位于次要 home，会在正式 Owner 启动前安装该凭据。`sessions`／`archived_sessions` rollout 以保留相对路径的原子 no-overwrite 合并迁移，同内容幂等跳过、异内容阻断；源 home 全部保留，原共享凭据另存私有备份，迁移记录不含路径或凭据。附件、记忆、目标／队列、项目、关系、动态工具、artifact、配置差异、未知数据和无法读取的 SQLite/WAL 继续 fail closed，不执行数据库猜测合并。多 home 迁移还要求当前 native launcher 的 PID＋出生身份可确认；launcher 在启动新 Desktop/Host 前完成旧 Desktop 树接管与退出等待。直接 Host 启动、launcher 消失或身份不匹配会在任何迁移写入前阻断。

本批验证：

- `npm run typecheck`、`npm run lint`：通过。
- 账号/Host/Owner/Renderer 聚焦测试最近一次 **272 项通过**；额外 `ManagedCodexAccounts` 两项登录测试通过。
- 使用真实 launcher 与 Codex CLI 0.153.4 执行 `native-bootstrap.test.ts`：stdio、loopback、plugins-enabled 共 **3 项通过**。
- `cargo check --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`：通过。
- Account Renderer Playwright 覆盖设置式全局切换、Harness 菜单单一 Codex 入口、Host 隔离、所有保存账号额度保留、取消登录无重复、其他 Harness quota 不变、busy 单次提交、切换失败不假报成功和协议客户端替换后的迟到响应隔离。本轮 3 个相关 Playwright 文件共 15 项通过；真实 Desktop 多窗口验收仍未完成。
- `native-private-files.test.ts` 使用真实 Windows launcher 的 5 项通过，覆盖实际私有存储、竞争锁、进程身份和 relay 边界。WSL Ubuntu 24.04 又实际验证目录 0700、slot/snapshot/backup/temp 0600、宽权限拒绝且失败前无文件落盘；platform 私有文件 4 项和 launcher 私有 IPC 2 项通过。真实 Refresh Token 轮换、macOS、真实 Linux Codex/SSH 和完整 Desktop 验收仍未执行。

当前任务勾选 **63/67**。剩余为 10.3–10.6，集中在真实 Desktop/PID/外部 Harness 连续性、完整 A→B→A 内容连续性与真实 Refresh Token 轮换、macOS／真实 Linux SSH 验收以及最终证据对账。

## 生产生命周期接线进展（任务 2.3，尚未完成）

- `app-server-host.ts` 已将官方账号初始化／连接失败从外部 Repository／插件初始化的全局清理边界移出。官方失败关闭官方请求入口，但 Desktop 输入、外部 Session、Mapping Store 和委派注册不因此关闭。
- 删除 `run()` 的官方 failure 与 Desktop 转发 `Promise.race`；官方退出只退役官方资源，Host finally 仍由 Desktop 结束／传输失败负责。
- 官方请求发送失败返回 `-32001`，要求显式重试；通知及旧服务端回复投递失败不再结束 Desktop 转发循环。关闭后的旧 Pool 在 `#load` 入口拒绝，包含 initialize 路径，不隐式创建竞争后台。这是删除 Pool 前的生产边界修复，不是保留 Pool 的最终方案。
- 新增回归：官方退出后已有外部 Turn 仍能完成；官方启动失败后外部请求仍可服务；官方请求失败不重启后台。改写原先“官方输出结束／进程退出就必须结束 Host”的三项断言。
- 本轮执行：`npm run typecheck`、`npm run lint` 通过；`app-server-host.test.ts`、`codex-runtime-lifecycle.test.ts`、`official-runtime-owner.test.ts` 共 **157 项通过**。
- 尚未完成：`run-host-runtime.ts` SSH 共享监听器故障仍会结束远程监听器；新 owner／切换器尚未组成生产路径，替代启动／回滚失败及真实 Desktop 初始化连续性仍需集成验收。因此任务 2.3 不勾选，进度保持 **10/62**。


## 旧路由替换点（任务 1.1）

- `packages/host-runtime/src/index.ts`：`CodexRuntimePool`、`UnknownCodexThreadAccountError`、`ThreadAccountStore` 及类型的出口。
- `app-server-host.ts`：构造注入与 initialize/run/close；`#forwardOfficialRequest` 的 Thread／login／draft 账号路由；`#pendingOfficialThreadBindings`、`#officialServerRequestAccounts`；官方委派 start/read；两条官方列表聚合分支；Thread inspection 与用量账号选择；按账号 refresh/login/delete。
- `codex-runtime/codex-runtime-pool.ts`：后台创建、协议初始化缓存、账号移除、`forThread` 历史查找；`account/thread-account-store.ts` 的不可重绑校验和写回。
- `run-host-runtime.ts`：本地 stdio 的所有权在 AppServerHost，Windows loopback 所有权在 listener scope；Unix SSH 同样在 listener scope。不能用逻辑 WebSocket 的关闭作为任一路径的进程退出凭据。
- `multi-account-thread-list.ts`：多账号游标及每账号分页扇出。`external-thread-list.ts` 的官方／外部聚合、排序和稳定分页仍需保留。
- `shared-contracts/src/codex-accounts.ts`、Thread inspection：`active/isDefault/codexHome` 与固定 accountId 语义；RendererModelClient 和公开出口同步升级。
- Renderer：`renderer-codex-account-state.ts`、`agent-selection-state.ts`、`renderer-binding-probe.ts`、`renderer-agent-picker.ts`、`renderer-codex-account-options.ts`、`versioned-renderer-adapter.ts`、settings accounts/list/usage/localization。
- CDP：`desktop-control/src/renderer-draft-prewarm-runtime.ts` 的 selectedCodexAccountId、selectAccount 与 `__codexhostAccountId` 注入。
- 测试：account-routing、account-official-listeners、multi-account-thread-list、app-server-host、agent-selection-state、renderer-codex-account-state、renderer-draft-prewarm-policy、renderer-codex-account-isolation 和 settings accounts。

必须保留的职责：OfficialRequestBroker 内部请求相关性、每 Desktop 客户端的 server request 映射、Frame parsing、External Thread Repository、所有 Harness session 与委派生命周期、官方／外部单源列表合并。这些不是账号后台池的冗余代码。

## 官方工作准入点（任务 1.3）

当前 `#hasActiveWork()` 混合外部 Harness 工作与官方 Turn，不能直接当作账号切换 gate。`#observeOfficialTurnLifecycle()` 仅覆盖 turn/started/completed，不足以覆盖以下所有工作。

| 入口 | 持续状态／结束依据 | 切换要求 |
| --- | --- | --- |
| thread/start/resume/fork 及修改类请求 | 请求在途；可能加载或启动原生后台工作 | 进入所有者共享的在途登记；禁止跨代次自动重放 |
| turn/start、steer、interrupt | start 请求响应＋turn/started，直到 turn/completed；调用失败清理 pending | 检查 pending 和 active，不能只看 UI running |
| command/exec | 0.153.4 协议明确最终响应延迟到进程退出、该连接输出通知全部发送后 | RPC 全周期 busy |
| process/spawn/writeStdin/kill/resizePty | 使用客户端提供、connection-scoped 的 processHandle；spawn 响应只证明注册，直到 process/exited 才结束 | 按客户端＋processHandle 登记；重复 spawn 的错误不能清除原进程登记 |
| 工具、审批、用户输入／问题 | 对应官方服务器请求直到回答／解决，通常也在 Turn 内 | 待处理交互与 Turn 均需登记，晚到回答绑定代次 |
| thread/realtime/start/append*/stop | realtime/started 至 realtime/closed，error 单独不能假定关闭 | realtime 活跃时 busy |
| thread/compact/start | 请求完成不等于压缩终态；结合原生状态／compacted／Turn | 无可靠终态时 fail closed |
| thread/queue/add/update/start 等 | 队列有待执行提交；queue/list 分页读取为核对来源 | 不暂停／清空用户队列以强行切换，有队列或自动推进活动则 busy |
| thread/goal/set、自动继续 | 原生持久化目标／队列可自行启动下一轮 | 仅请求计数不足；需确认原生无自动继续来源或拒绝切换 |
| account/login/start/cancel/logout | 官方完成事件及认证事务结束 | 认证独占，cancel 属于该事务内允许的控制操作 |
| thread/backgroundTerminals/* | 后台终端实际退出／原生列表核对，不以原 Turn 结束推断 | 仍存活时 busy |
| fs 写入、plugin 安装、config 修改等其他官方变更 | 在途响应；有后续异步副作用时等待对应原生终态 | 默认登记所有官方变更，未知异步生命周期禁用切换而不是放行 |
| mcpServer/oauth/login、hooks 等官方异步交互 | 原生 OAuth 完成／hook 终态与所属工作 | 不仅登记起始 RPC，结束前保持 busy |
| reset-credit consume 等非幂等操作 | 响应结算 | 执行中 busy，跨重启不重试消费 |
| Host 发往 Codex 的委派／内部请求 | `#requestOfficial`、官方委派 start/read 等入口 | 必须与 Desktop 直达请求共用 gate；外部目标不被阻塞 |

当前生成协议有 `thread/loaded/list`、ThreadStatus、queue/list、process/exited 和 server/diagnostics。diagnostics gauges 是可变诊断数据，不能用未经确认的计数名称当全局原子暂停接口。正式 gate 尚未实现，不能把该盘点当作原生自动继续已经得到控制。

## 平台权限接口盘点（任务 1.4，接口已实现；跨平台验收仍待完成）

- `crates/platform` 当前没有通用 Windows DACL 私有文件原语；其 windows crate 特性尚不包含文件安全描述符相关 API。
- Node `chmod`／`writeFile({mode: 0o600})` 不能替代 Windows DACL 验证。
- 已实现 `codexhost_platform::PrivateDirectory`：私有目录创建与检查、文件读取／有条件原子替换／删除，以及保留到生命周期结束的 OS 独占锁。Windows 使用创建时的安全描述符、实际 owner/DACL 检查、reparse point 与硬链接拒绝，并在操作中保留禁止 delete sharing 的目录句柄。SYSTEM 与本机 Administrators 属于明确的 OS 特权边界，不声称防御管理员接管。
- `codexhost private-file` 只接收 stdin 中有界的通用路径、文件名、字节和摘要，不解析账号、OAuth 或 Host 协议；响应经专用 stdout 返回，错误不带输入或路径。没有“先写秘密再修改 ACL”的步骤。`NativePrivateFiles` 在失败后等待 helper 真实退出，不能确认退出时拒绝竞争写入。
- Windows 原语、实际 DACL 拒绝、独占锁及 TS→native IPC 已执行测试；POSIX 实机验证、全部路径／崩溃故障覆盖以及组成层集成仍待完成，因此任务 3.4 仍未勾选。内容摘要检查不是对任意外部写入者的完整锁。

## 第一批底层实现

`OfficialProcessLifecycle` 统一监听真实进程退出、区分 spawn 失败与已运行进程的 error，支持 stdin EOF 优雅停止及有界 SIGTERM/SIGKILL 升级；无法确认退出时显式失败。

stdio `OfficialAppServerConnection` 增加仅进程所有者具备的 `stopProcess()`；远程逻辑 socket 没有该方法。`CodexRuntime.stopProcess()` 拒绝把共享客户端当进程所有者，停止中拒绝发送并丢弃旧输出。Windows loopback 与 Unix listener 的 close 使用同一进程退出确认，超时不再报告成功。

`NativeCodexCredentials` 提供有界、脱敏的原生文档解析和稳定用户＋工作区关联，原始字段字节保留；明确不把 JWT 解码当认证成功。`SavedCodexAccounts` 实现新的 v2 非秘密注册表：随机账号 ID、重复身份更新、已确认当前账号提交、当前账号禁止删除、失败写入不污染内存；v1 输入明确要求迁移而不覆盖。

这只是后续单实例所有者与切换事务的基础：当前产品仍运行旧 pool，新的 v2 注册表尚未接入组成层，未启用全局切换，也未改写现场账号或迁移数据。

## 回归期间发现的旧初始化竞争

重复执行旧共享 Mapping Store 测试时，复现两个独立 v1 AccountRepository 同时初始化同一 `accounts.json` 的 Windows rename EPERM。这发生在官方进程创建前，不是新退出确认逻辑的错误。该测试现在显式共享预先初始化的账号元数据与绑定库，从而单独验证 Mapping Store 关闭所有权；不能据此声称旧生产路径的独立元数据写入者已经解决。任务 2.2 接入单个所有者时必须同时共享并先初始化 v2 注册表，不能只共享官方监听器。

另一个旧断言要求在收到真实 exit 后继续发送 SIGTERM，已改为不再次 signal 已确认退出的进程；真实 Host 意外退出及清理的其余断言保持。

## 本批验证

- `npm run typecheck`：通过。
- `npm run lint`（包含包边界检查）：通过。
- 使用 `tests/vitest.config.js` 运行 official-process-lifecycle、codex-runtime-lifecycle、remote-official-app-server、remote-official-connection、account-routing、account-official-listeners、native-codex-credentials、saved-codex-accounts、app-server-host：9 个测试文件，197 项通过。
- 修改文件的 Prettier 检查、`git diff --check`、本 change 的 OpenSpec strict validate：通过。
- 未执行 Desktop E2E、真实 Refresh Token 轮换、Windows DACL 实现测试或 Linux/macOS 实测：单实例切换与私有文件写入尚未接入，不能将基础单元测试当作这些验收完成。

## 第二批实现

- 新增通用 Rust 私有文件原语、launcher 的有界 stdin/stdout IPC、Host `NativePrivateFiles` 和 `CodexCredentialFiles`。独占锁位于共享 home 的 `.codexhost-writer.lock`，而不是各 Host 的槽位目录；真实 IPC 测试覆盖同一 home、不同槽位目录的竞争。存储能力规则明确拒绝未知／auto／keyring 以及外部认证覆盖，不自动修改配置；调用者仍需从官方接口确认实际生效的存储模式。
- 新增 `OfficialWorkGate`、`OfficialWorkTracker` 和 `OfficialRuntimeOwner`；复用 `CodexRuntime`、Broker 和原生 stdio/loopback/Unix 连接。官方连接本身改为 generation 归属；旧 account tag 暂时局限在待删除的 v1 pool 中。包含每客户端初始化重放、服务器请求 ID 隔离、在途请求失败、原 Thread 按需恢复、一个后台退出确认后才能启动下一后台。
- 新增 `CodexAccountSwitcher` 与私有位置中的无秘密恢复记录。覆盖 source 保存失败时原地恢复、目标更新保存、安装已完成但调用失败、元数据提交确认丢失和阶段恢复。`SwitchingOfficialRuntime.preflight/assertNativeIdle/verify` 仍是待实际接入的原生验证边界，不能把 mock 测试当作真实认证验收。
- 正常 Host 组成、公共 RPC、Renderer/CDP、迁移与旧架构删除**仍未切换**；未启用发布用的双架构开关，也未改动现场凭据或历史。该检查点任务为 **7/62**；最新进展见第三批，不能按新增模块数量宣称产品已完成。

## 新发现的设计门槛：冷启动恢复前的原生配置核对（任务 1.2）

对当前实际二进制 `codex-cli 0.153.4` 使用独立空 `CODEX_HOME` / HOME / USERPROFILE、清除认证环境覆盖后执行：

1. 初始化前发送 `config/read`，得到 JSON-RPC `-32600: Not initialized`。
2. 完成 `initialize` / `initialized` 后，`config/read(includeLayers=true)` 正常返回，实际默认 `cli_auth_credentials_store` 为 `file`。
3. `doctor --json` 可报告 `auth storage mode: File`，但同时报告 `desktop.app_server.handshake` 成功并说明 app-server initialized successfully。因此不能把它当作已经证明无后台副作用的离线配置读取，也不应直接拿来在当前后台旁边做预检。

上述试验未装入任何账号凭据或提交 Model Turn。目录已清理；一次退出后的临时目录删除遇到 Windows EPERM，稍后有界重试清理成功，不据此推断有模型连接残留。

提案要求在“下一次官方后台初始化前”完成恢复及存储预检，而实际生效配置通过原生接口要在初始化后才能取得。正常运行中的切换可以先读取现有后台配置；冷启动恢复没有这个前提。不能把输入一个 `file` 常量的单元测试当成该问题已解决，也不能无说明地实现第二套原生配置合并器。

**用户已同意的设计细化**：关闭官方工作准入，以唯一后台核对原生配置；停止并确认退出后完成凭据恢复，再正式启动和认证确认。全过程仍最多一个后台，不关闭 Desktop 或其他 Harness。`design.md` 与凭据生命周期 spec 已同步。采用前仍必须验证受支持版本／配置的初始化不会自动恢复工作，且能确认旧写入者已退出；不能把授权或隔离探针当作生产接线完成。

## 第二批验证结果

- `npm run typecheck`、`npm run lint`：通过。
- 使用 `tests/vitest.config.js` 的 13 个聚焦测试文件，**229 项通过**；其中 2 项通过显式 `CODEXHOST_TEST_NATIVE_LAUNCHER` 运行真实新编译的 Windows launcher 私有文件 IPC，而不是 mock DACL。
- `cargo test --locked --manifest-path crates/platform/Cargo.toml private_files`：4 项通过。
- `cargo test --locked --manifest-path crates/launcher/Cargo.toml --bin codexhost private_file_command`：2 项通过。
- platform 全 targets、launcher `codexhost` binary 的聚焦 Clippy（`-D warnings`）：通过。
- home 级锁调整后又运行了相关 4 个 TS 测试文件，32 项通过；类型检查与 Lint 再次通过。
- 未执行 Desktop E2E、真实 Refresh Token 轮换、Linux/macOS 实机测试。当前 Rust 仅安装 Windows 编译 target；Unix 原语不能据 Windows 检查宣称已验证。
- 截至第二批，接入前仍需完整的原生闲置核对、现存／孤儿进程协调和 loopback 私有监听器访问控制验证；文件 DACL 与独占锁测试不等于整个账号系统的安全验收。

## 第三批：原生接口、连接恢复与私有监听器

- 新增 `OfficialAccountRuntime`：支持版本严格限定为 0.153.4；核对真实 `config/read`、原生账号模式、持久化／已加载 Thread、队列与目标。身份检查调用原生 `account/rateLimits/read` 并核对前后原生文件身份，不增加 OAuth 刷新器。
- 新增通用 `process-identity` Rust/launcher 查询与 TS IPC，以及共享 home 的 `OfficialProcessRecord`。记录 PID 与出生身份；活着的前任、观察失败及 spawn→登记间的未确认窗口均阻断，确认退出后才删除见证。尚未完成生产协调接线，也不证明整个子进程树已停止。
- `OfficialRuntimeOwner` 保存每客户端初始化，隔离旧代次响应／server request；重连只按原 ID 按需恢复，不重放 Turn。官方 `thread/read` 的实时 Model／推理强度用于停止前快照，避免覆盖后来选择的 Model；恢复后再次原生读取核对。元数据修改不自动加载 Thread。
- 新 loopback backend 使用官方 `--ws-auth capability-token --ws-token-sha256`：每后台生成随机能力令牌，命令行只含摘要，连接使用 Authorization header，私有传输错误不回显关闭原因。真实 0.153.4 验证无令牌／错误令牌不能连接、正确客户端可分别初始化；旧生产监听器尚未因此完成替换。
- 原生探针现覆盖 stdio 和两个 loopback 客户端：使用原生命名操作使空草稿具备可恢复 rollout，保留原 ID；修改 Model 后重启仍保留选择；已有目标／队列在配置启动中不加载 Thread，到达合成 endpoint 的请求计数不增加。无实际账号、无 Turn 提交、无推理。
- `thread/queue/start` 的 Turn 响应现纳入工作登记；清空队列不释放仍运行的 Turn，畸形成功响应保持 fail-closed。
- 勾选 2.4、2.5、2.6，当前 **10/62**。组成层、完整工作准入、登录事务、UI、迁移和旧代码删除仍未完成。

### 新的边界事实与未完项

- 未禁用 plugins 的隔离初始化出现后台 Git 同步和进程退出后目录占用；禁用该原生 feature 后探针可正常清理。需完成通用进程树监督／旧写入者协调，不能把 top-level PID 消失当成全部后台活动已退出。探针的 `plugins=false` 不是偷偷修改用户配置或生产支持默认配置的证明。
- 一次合成失败 Turn 探针观察到终态之后仍有 `ThreadStatus.systemError`；当前检查保守地保持 busy。错误显示状态与真实活动的核对、后台终端及 `thread/shellCommand` 的持续生命周期仍需完善，不能靠忽略错误状态放行。
- 该机器上合成 HTTP Turn 请求未到达 loopback fixture 而得到 502；清除代理环境覆盖也未消除现象。最终回归不提交 Turn，只使用原生命名、目标／队列和只读状态；endpoint 计数不是完整网络流量审计，不能替代真实身份／刷新验收。

### 第三批执行结果

- `npm run typecheck`、`npm run lint`：通过。
- `tests/vitest.config.js` 下 16 个聚焦文件、**258 项通过**；显式传入原生 launcher 与 stock CLI 路径，包含 3 项真实 Windows IPC 和 2 项真实原生 bootstrap/loopback 场景。
- `cargo fmt --all --check`、platform `process_identity` 测试（1 项）、platform 全 targets 与 launcher `codexhost` 的 Clippy `-D warnings`：通过。
- 未执行 Desktop E2E、完整 UI／Host 集成、真实 Refresh Token 轮换和 Linux/macOS 实测；不提交现场认证或对话，也尚未提交本变更的 Git commit。
