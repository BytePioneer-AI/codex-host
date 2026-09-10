## Context

本提案将“账号是运行环境所有者”改为“账号是当前官方后台使用的认证身份”。用户明确接受同一 Host 的所有 Codex 会话全局切换，不需要账号并发运行；SSH 远程仅需原生单账号。

当前实现的主要耦合：

- `CodexRuntimePool` 以 accountId 建立进程／连接，`forThread()` 依赖 `ThreadAccountStore`，后者拒绝重新绑定已存在的 Thread。
- `AccountOfficialListeners` 在 Windows Desktop / Remote Control 路径按 home 创建监听器。Unix SSH 路径则一直共享一个官方监听器。
- `app-server-host.ts` 包含账号级请求命名空间、登录路由、Thread 绑定、多源历史列表、账号级实时额度；`run()` 将官方后台故障升级为 Desktop input 关闭和外部 Session 的全局清理。
- Renderer 和 CDP 草稿预热链路保存 per-Thread/per-draft Account，向 `thread/start` 注入 `__codexhostAccountId`；这与新语义冲突。
- 当前账号元数据不存 Token，但每个账号的 home 同时拥有认证、会话和配置。直接删除账号目录会连同会话一起删除，不能照搬到共享 home。

可行性证据见 [evidence.md](evidence.md)：Windows Codex CLI 0.153.4 下，热登录后的旧模型 WebSocket 仍可能使用 A；停止进程、替换凭据、重启并恢复同一 Thread 能使用 B 且保留上下文。真实刷新轮换、完整数据迁移和 Desktop 长连接保持尚未全部验证。

## Goals / Non-Goals

**Goals:**

- 每个 Host 官方运行时所有者最多持有一个 Codex 后台，一个共享原生 home；不同账号可以顺序使用同一会话。
- Codex 受控重启不触发 Desktop、Host、其他 Harness、外部 Mapping Store 或委派服务的整体退出。
- 官方后台继续负责当前账号运行凭据；Host 的额度子系统参照 OpenCodex 管理非当前账号的额度读取与必要 OAuth 刷新，使用同一私有凭据槽、single-flight、generation/CAS 和原子写回，不把该能力扩展为请求级账号路由。
- 原有多账号后台、绑定、历史扇出和草稿覆盖彻底退出正常运行路径；仅保留一次性旧格式读取。
- 迁移非破坏、幂等、可核对；不能安全处理的旧数据不被隐藏为“迁移成功”。

**Non-Goals:**

- 不支持按 Thread 独立选账号、账号并行执行、运行中无缝换身份或自动耗尽额度轮换。
- 不承诺绝对不更换进程 PID；“一个后台”指最多一个存活的官方后台，不是一个永不退出的进程。
- 不实施 SSH 多账号，不跨 Host 同步凭据，不改变 Harness 的原生认证。
- 不为登录／额度查询创建额外官方后台；非当前账号额度由 Host 使用私有凭据直接请求 WHAM，不通过隐藏切换实现。
- 不借机重构整个 Host 协议、升级 Harness SDK 或重新实现官方 Session 存储。

## Decisions

### 1. 单个运行时所有者与一个共享 home

正常路径变为：

```text
Desktop 连接 A ─┐
Desktop 连接 B ─┼─ Host 会话（外部 Harness 继续运行）
Remote Control ┘             │
                   单个官方生命周期所有者
                   当前代次 + 独占账号事务
                             │
                    唯一 Codex app-server
                             │
                  shared CODEX_HOME / auth
                    sessions / native DBs
                             ↑
                非当前账号私有凭据快照
```

- 本地 stdio Host：官方生命周期由其 Host 实例持有。
- Windows Desktop / Remote Control：生命周期由 `run-host-runtime.ts` 的共享监听器所有者持有，注入所有 `AppServerHost`；每个 Host session 仍可有独立官方客户端连接，但不能各有后台、切换锁或凭据写入者。
- SSH：保留一个长寿命监听器，账号库操作能力为禁用。不能通过 `process.platform` 推断账号策略；Linux/macOS 本地 Host 支持切换，SSH Host 不支持。
- 全局范围是明确的 Host 身份及共享官方所有者，而不是整台机器或任意 Renderer 窗口。相同 home 的多个托管所有者必须复用现有所有权或拒绝并发修改；不通过后台轮询建立第二套发现服务。无法协调的独立 stock CLI／外部凭据写入者应在切换前拒绝或在身份／文件竞争检查时失败，不能宣称可安全并发刷新。
- 优先保留现有原生 `CODEX_HOME`；`HOME`、配置、项目、Model/Provider 设置不随账号切换。其他账号 home 的配置差异在迁移清单中显式处理，不按账号在运行时覆盖共享配置。

替代方案：保留 pool 并强制一次只加载一个账号仍保留了账号 home、Thread 归属和历史扇出的复杂度；直接热改认证不能消除旧模型连接，均不采用。

### 2. 受控重启不是 Host 退出

复用官方连接、请求 Broker、帧解析和协议初始化代码，将其生命周期改为可替换的单个 Codex runtime，而不是新建一套协议栈。

- 生命周期所有者控制停止、等待真实进程退出、启动、初始化和连接代次。连接 `close()` 必须提供可等待的退出结果；销毁 stdout 或从 Map 删除条目不是旧后台退出的证据。
- 每代官方连接使用代次标识隔离请求、服务端请求响应、输出与缓存。保留必要的多 Desktop 客户端请求相关性，不因删除账号命名空间而删除真正需要的 RPC 防串线逻辑。
- 重新向新后台发送保存的 `initialize` 参数与 `initialized`，但不向 Desktop 伪造第二次初始化响应、不重建 Desktop 传输。
- 仅记录已加载／订阅 Thread 的原生 ID、恢复所需参数与连接订阅归属，不维护第二份聊天历史，不重新引入 Thread→Account 绑定。在下次官方请求前按需 `thread/resume`，恢复现有订阅；同一 Thread 的多客户端 attach 仍由唯一官方后台处理。
- 不重新发送已完成 Turn，不自动重放 `turn/start`、重置卡、命令、审批等非幂等操作。运行时边界上的只读请求明确失败后由调用者重新读取。
- 调整 `app-server-host.ts` 的 `runtimeFailure` 竞赛与 `finally` 边界：受控停止及切换回滚失败仅影响 Codex；不能进入关闭 `desktopInput`、`#externalRuntime`、`#externalAdapters`、委派 API 或 Mapping Store 的路径。
- 外部 Harness→Codex 的新委派请求受 Codex gate 限制；外部 Harness 自身运行、工具、问题／审批以及外部目标委派保持正常。已经被 Codex 工作依赖的活跃委派不能被误判为空闲。

### 3. 一个独占事务，阻止检查空闲与提交请求之间的竞态

公开状态保持 `ready / changing / unavailable` 三种；操作类型和阶段用于错误说明与小型恢复记录，不设计通用工作流引擎。

`ready` 允许当前账号的普通官方工作；`changing` 拒绝新的 Codex 工作；`unavailable` 保持其他 Harness 可用，提供 Codex 恢复或重新登录入口。未登录也是可表达状态，不伪造当前账号。

切换步骤：

1. 获取 Host 范围的独占账号操作锁并关闭官方工作准入；在同一所有者上检查所有连接的官方工作。
2. 活跃 Turn、正在提交且未得到终态的 `turn/start`、命令／工具、审批／用户问题、实时会话、压缩、登录以及已准入未完成的官方非幂等请求都算 busy。原生队列／自动继续若可能自发启动工作，也必须纳入原生暂停或 busy 判定；不能只依赖 Renderer 的发送按钮。busy 时原样返回，不取消、不排队等待静默执行。
3. 目标身份、受支持凭据后端、权限和恢复能力预检通过后，发布 changing，记录无 Token 的事务阶段及源／目标账号引用。
4. 正常停止旧后台，等待进程退出及官方请求结算。不能确认退出时禁止写目标凭据；若不得不强制终止，须确认其退出并验证最新凭据完整后才能继续，否则进入 unavailable。
5. 读取此刻共享 home 中的最新官方凭据，校验实际用户／工作区身份，将其原子保存到源账号私有槽位。不能用登录初始快照覆盖原生刷新结果。
6. 原子换入目标凭据，启动唯一后台，完成协议初始化。核对原生凭据中的稳定身份、官方 `account/read` 身份和受认证的轻量只读请求；身份不符、认证失败或网络无法确认均不得提交切换成功，不通过付费 Model Turn 验证每次切换。
7. 提交当前账号元数据，撤销旧代次的身份、实时额度、可用 Model／权限缓存；完成必须的连接就绪工作后重新开放准入，向所有该 Host 客户端广播结果。Thread 逐个按需恢复，恢复单个 Thread 失败不销毁其他 Thread。

重复切换到当前且已验证的账号是无重启的幂等操作。并发第二次切换明确返回 busy；不会排成一串不可见的身份切换。切换期间提交的 Codex 输入不得在切换结束后自动以新账号发出。

### 4. 原生刷新与凭据保管

账号记录中的本地 `accountId` 是稳定随机 ID，与用户身份及工作区关联，不等同于 JWT 中的工作区 `account_id`。关联至少考虑原生认证 issuer、稳定用户 subject／user ID 与工作区；邮箱只是显示信息。两个用户属于同一 Team 不得合并；同一已验证用户＋工作区重复登录则更新原记录。

- 账号元数据 v2 保存当前账号引用、账号身份与显示字段、共享 home 引用；不再为每个账号保存运行 home。浏览器契约不暴露凭据或私有凭据路径。
- 当前原生凭据文件是运行期间的最新权威来源，官方后台维护当前身份。非当前槽位同时是额度读取凭据来源；额度子系统可在明确 generation/CAS 栅栏下刷新并原子写回该槽。非当前账号的普通 WHAM 读取不修改凭据；只有 OAuth 刷新／槽位写回阶段进入全局准入计数。账号切换不得在该刷新飞行中安装同一槽位，避免旋转后的 Refresh Token 只存在于错误一侧。
- 当前快照落后时，正常切换或启动恢复先识别共享 home 的真实身份和最新内容，再更新正确槽位；不能按过时元数据把 B 的 Token 写进 A。
- 首版围绕已验证的官方文件型 ChatGPT OAuth 存储实现。预检遇到 OS keyring、外部 Token 注入、API Key 或未知格式时保留正常原生使用，禁用不安全的管理操作并说明原因；不得静默改 `cli_auth_credentials_store` 或降级为明文。未来支持其他原生存储需单独验证原子切换和撤销语义。
- 私有快照和事务涉及的秘密文件采用独立用户私有目录、原子替换和原生平台访问控制：POSIX 目录 `0700`／文件 `0600`，Windows 验证或建立不允许无关用户访问的 DACL，不能把 Node `mode: 0o600` 当成 Windows ACL 保障。官方共享 `CODEX_HOME` 例外接受 `CodexSandboxUsers` 的只读／遍历 ACL 及其继承到 `auth.json` 的只读 ACE，但拒绝 Sandbox 写入、删除、所有权／DACL 修改和宽泛主体读取；Host-owned slot、Journal、备份、writer lock 与进程 witness 必须放在不继承该 ACL 的严格私有目录。
- 秘密不得进入共享契约、Renderer、诊断、命令行参数、版本库、普通备份目录或复现 fixture。原生文件型认证本身不是静态加密；必须如实说明保护边界。OS 密钥库支持不通过本提案顺带实现。
- 若需要平台文件权限或进程等待原语，复用／扩展 native/platform 公共能力；Rust 不处理账号语义、Token 字段或 Host 请求。

运行中的当前凭据仍优先由官方刷新；额度子系统只在私有非当前槽位上承担 OpenCodex 风格的 Refresh Token 客户端，并以稳定本地账号 ID、JWT 用户＋工作区身份、槽位摘要及 credential generation 防止跨账号写回。该刷新能力不得用于模型请求、自动切换或 Thread 路由。

### 5. 回滚与崩溃恢复

记录最小事实：事务 ID、源／目标账号引用、操作类型、凭据安装／验证／提交阶段、私有快照引用；不得包含 Token。写入顺序和原子替换需支持每个边界的故障注入。

| 故障点 | 处理 |
| --- | --- |
| busy／预检／停止确认失败，尚未换凭据 | 不安装目标；保持源账号可用，或在停止状态不明时只关闭 Codex 准入 |
| 源最新凭据无法安全保存 | 不覆盖共享凭据；尝试以同一源凭据恢复，失败则 unavailable |
| 目标已启动但认证失败 | 先结束目标后台；若它刷新了目标凭据，先校验并保存目标最新内容，再恢复源快照、重启并确认源身份 |
| 源回滚也失败 | current 不得伪装 ready；展示 unavailable 和可重试／重新登录，其他 Harness 保持工作 |
| 凭据已换但元数据未提交时崩溃 | 关闭工作准入，核对所有权与实际文件身份；必要时先用唯一后台初始化并读取原生配置，停止确认后恢复事务，再正式启动验证；不能只信 current 指针 |
| 成功提交后崩溃 | 保留成功提交的新当前账号；不拿旧备份倒退原生已刷新的 Token |

冷启动没有现存后台可提供实际生效的配置。允许在工作准入关闭时顺序执行一次配置核对启动：确认没有旧写入者，初始化唯一后台，仅调用原生只读配置接口，不 attach 或恢复用户 Thread；停止并确认退出后重新读取原生凭据，再完成恢复及正式启动。该顺序已获用户批准。只有经验证初始化不会自动恢复工作的版本／配置才允许该启动；出现未知活动、无法确认停止或不支持存储时保持 fail closed，不建立 Host 自己的原生配置合并器，也不使用带额外后台副作用的 doctor 作为离线读取。任何原生凭据更新仍按停止后的实际身份保全。

源、目标都只有一个凭据写入者。恢复需要 Host 范围的锁；无法证明一致性时停止 Codex 操作，而不是挑一个邮箱相似的账号继续。跨用户／工作区切换前 UI 提示后续请求会携带既有上下文到新身份。

### 6. 添加、重新登录和删除复用同一个事务

为严格遵守一个后台，添加账号不创建隔离认证后台：

1. 提示“添加期间当前 Host 的 Codex 暂不可用，其他 Harness 不受影响”，要求官方工作空闲。
2. 停止并保存原账号，清理共享 home 的当前认证（不调用可能影响原身份的远端撤销），启动唯一的未登录后台，发起官方设备代码登录。
3. 以官方完成事件＋实际身份确认成功，不以某条列表记录出现邮箱作为成功依据。仅创建事务内临时记录，不提前增加“已连接账号”。
4. 登录成功后停止该后台、保存新账号最新凭据；取消、超时或失败也停止后台并处理原生落盘结果，然后恢复原账号并重启。任何结果都不能让潜在的迟到登录覆盖已恢复的账号。
5. 有原账号时添加成功不自动全局切换；无原账号时，成功的新账号成为当前账号，取消则回到已确认的未登录状态。

重新登录保存账号沿用此流程并验证目标身份；当前账号重新登录也是全局独占操作。现有 Desktop 原生 `account/login/start`、cancel、logout 不能绕过 gate；受支持登录模式由相同协调器处理，未支持的模式先明确拒绝，不直接热转发。

删除只允许非当前账号，删除其凭据与元数据，不删除共享 home 或任何 Thread；当前账号须先显式切换或安全退出登录，不再自动回退“原生默认账号”。原生目录保护意义由共享 home 所有权表达，不继续保留 `isDefault` 的账号级删除特例。

### 7. 公共契约、账号 UI 和额度

- 使用显式 `codexhost/account/switch` 替代旧 `activate` 的“新任务默认”含义。账号 list 返回版本化能力、当前账号、`ready/changing/unavailable` 及列表；switch 有明确的 busy、unsupported、authentication-failed、rollback-failed 等稳定错误类别。
- 元数据中的已提交当前账号与“后台此刻已就绪”不得混为一谈：changing 可以显示“正在从 A 切换”，只有 ready 才表示当前身份可接收工作；unavailable 不显示成功当前标记。广播带 Host 归属及单调递增修订，丢弃旧 Host、旧连接代次的刷新结果。
- 同步替换 Renderer 客户端、版本绑定和测试。旧 `activate`、旧账号草稿参数被明确拒绝为不支持／需要更新，而不是偷偷重新解释为全局切换。删除 `__codexhostAccountId` 的生产者与解析器，兼容拦截只用于安全拒绝，不用于路由。
- Thread inspection 保留 owner/locked 的 Harness 归属意义，删除固定 Account 字段；用独立的 Host 当前账号快照显示 Codex 身份，不把所有旧 Thread 重写为新绑定。
- 设置页和现有 Codex 账号菜单调用同一个全局 switch。Harness 锁定不再阻止已存在 Codex 会话切换账号；切账号不能切 Harness。保留现有头像／邮箱组件，仅删除 per-draft 选择状态。
- 更新全部“默认／设为默认／只影响新任务”文案。切换成功后，所有该 Host Composer、设置页和用量浮窗显示同一当前账号，其他 Host 不变。
- 当前账号的额度、重置卡和可用 Model 重新读取。非当前账号 inspect 使用其私有凭据直接读取 WHAM，可并发但有总量上限、超时和 per-account single-flight；不启动辅助进程、不切换共享认证。所有成功结果按账号原子持久化并带获取时间，失败返回 last-good 快照。非当前账号 consume 仍在后端拒绝。
- Thread 累计 Token／上下文用量仍来自原生 Thread，跨账号继续时不清零；它不是某个账号的历史账单。账户级额度必须跟随当前身份，不从旧 Thread→Account Map 查询。

### 8. 删除与替换清单

这是完成标准，不是可选后续清理。保持正常路径只有一种实现；短期开发分步提交不等于发布双架构开关。

| 当前模块／概念 | 最终动作 | 保留或替代的职责 |
| --- | --- | --- |
| `codex-runtime/codex-runtime-pool.ts`、`UnknownCodexThreadAccountError` | 删除模块和公共出口 | 单个 runtime 的受控生命周期、真实退出等待 |
| `codex-runtime/account-official-listeners.ts` | 删除模块和公共出口 | Windows 一个共享监听器，由所有者顺序替换 |
| `account/thread-account-store.ts`、`bindThread`、`forThread`、历史账号发现 | 删除正常运行实现和注入项 | 一次性迁移读取旧绑定作核对；不再写新绑定 |
| `multi-account-thread-list.ts`、`codexhost:official-accounts:v1:` 游标 | 删除官方账号扇出聚合 | 保留官方单源与 External Thread 的现有聚合；旧游标明确失效并从首页重读 |
| `CodexRuntime.account`／输出中的账号进程归属 | 移除进程按账号的所有权 | 输出带连接代次；账号仅是当前认证快照 |
| `app-server-host.ts` pending Thread bindings／登录账号查找／按账号请求 key | 删除账号路由分支 | 保留 per-client/代次 RPC 相关性、原生登录事务、外部 Harness 路由 |
| `#officialUsageAccountByThread` 和绑定式额度选择 | 删除固定归属 | Thread 用量与 Host 当前账号额度分离 |
| `AccountRepository` v1 每账号 codexHome、default 删除回退 | 替换 v2 元数据；v1 只在迁移 reader | 本地账号 ID、稳定身份、当前指针，不秘密落元数据 |
| `renderer-codex-account-state.ts` 的草稿 override、`agent-selection-state.ts` 的固定 Account | 删除状态和恢复路径 | 复用 Harness 状态、Host 当前账号快照 |
| `renderer-binding-probe.ts`、`versioned-renderer-adapter.ts`、`renderer-draft-prewarm-runtime.ts` 的 selectAccount／提交覆盖 | 删除注入和绑定 | 不影响 Harness carrier、权限、Model 及草稿预热本身 |
| `renderer-codex-account-options.ts`、settings accounts 组件 | 保留展示，替换行为与文案 | 全局切换、当前账号状态和 stale 配额 |
| `codex-accounts.ts` 旧 `activate`、`codexHome`、`active/isDefault` 和 inspection Account 语义 | 原子升级契约及调用者 | 当前账号／能力／状态；不把旧字段永久留作别名 |
| pool / binding / multi-account-list / renderer-account-isolation 测试 | 删除过时断言，改写测试 | 单实例、跨窗口全局切换、历史连续性及其他 Harness 不受影响 |

清理要遍历 `src/index.ts`、包出口、fixtures、E2E、文档及过期 build 产物，不能只让 TypeScript 编译通过。账号凭据条目的 `accountId`、其他 Harness 账号字段、External Thread Mapping Store 不是删除目标。

## Risks / Trade-offs

- [后台切换导致 Host finally 关闭外部 Session] → 将官方代次与 Host 生命周期解耦；用真实流式外部 Turn、工具与审批跨切换 E2E 验证。
- [多窗口同时提交／延迟旧事件] → 一个所有者上的准入锁、在途工作登记、代次与广播修订；旧响应不能更新新身份或落盘。
- [停止期间刷新 Token 或回滚倒退 Token] → 等待进程退出后保存最新原生凭据，目标失败后也先保全其有效新快照；原子阶段故障注入。
- [其他未托管 Codex 使用同一原生 home] → 明确单写入者前提、托管所有权与外部修改检测；不能把一次文件哈希检查宣传成对任意外部进程的完整锁。
- [新增账号需要暂停所有 Codex] → UI 提前告知、有取消／超时恢复，不影响其他 Harness；不为体验回退额外认证后台。
- [账号权限不同导致历史无法继续或 Model 不可用] → 原样展示原生失败，更新 Model 目录但不偷偷选替代 Model、不丢弃历史、不自动改账号。
- [新账号可见原会话上下文] → 全局切换范围与跨账号上下文提示明确可见，不声称切换能隔离历史。
- [丢失项目／归档等附加信息] → 分类盘点与一致性备份、受支持类型逐项验证，未知类型阻断自动迁移完成。
- [多账号直接额度读取导致 Token 竞争或秘密泄漏] → 仅使用严格私有槽位，额度请求进入全局准入计数；非当前 Token 刷新使用 single-flight、槽位摘要 CAS、身份复核和原子写回，当前账号继续走官方后台；RPC、日志和磁盘额度快照不含凭据。

## Migration Plan

1. **先独立盘点与预检**：在启动官方后台前读取 v1 元数据、所有旧 home、绑定、native DB/rollout/附件与配置差异，核对路径及源进程所有权。实际生效的原生存储配置可在上述受限的唯一后台配置核对启动中读取；确认退出后才导入或安装凭据。报告不含凭据或对话正文。
2. **选择共享 home**：优先使用旧受保护原生 home，不因 activeAccountId 指向 B 就把 B 的 home 当作唯一历史源。保留已选默认账号的意图，在所有旧工作停止且目标身份确认后把它转换为全局当前账号；升级首次 UI 明确提示语义变化。
3. **一致性备份**：停止并确认所有旧官方后台退出，保留原目录；对仍可能存在 WAL 的 DB 使用原生一致性备份／完整关闭快照，不能只复制 `.sqlite` 主文件。备份中含认证的数据仍需私有权限。
4. **凭据导入**：按真实用户＋工作区导入槽位，合并同一身份的重复占位条目，但不合并同 Team 不同用户。缺失、撤销、损坏或身份不确定的条目要求重新登录，不冒充已连接账号。
5. **历史分类导入**：若非原生 home 完全无 Thread／附加数据则直接跳过历史复制。对受支持 legacy/paginated rollout 保留 Thread ID、内容、归档状态和必要路径；通过官方扫描／恢复验证。附加项目、分组、关系、工具、附件、记忆等必须按数据类别验证，不把多份 SQLite 覆盖合并；不复制账号配置覆盖共享配置。
6. **冲突与不支持数据**：同 ID 同内容可幂等跳过；同 ID 不同内容、未知 schema、无法保留的附加数据或配置差异产生明确阻断清单。原数据不删除，不生成新 Thread ID 掩盖冲突。迁移未完成时不启用新 Codex 工作，也不运行旧多后台 fallback；其他 Harness 保持可用，用户可处理数据或停止应用后回到未迁移版本。
7. **验证后提交 v2**：以逐 Thread ID、内容／必要元数据、archive、原生读取和恢复结果验证，不能仅比较总数。通过后原子提交元数据／迁移完成记录，停止读取旧路由绑定，失效旧列表游标，开放单后台。
8. **保留可恢复原件**：不在此变更自动删除旧 home、旧凭据备份或原生历史。仅删除代码中的旧运行路径。后续用户明确清理前说明原件可能含秘密及过期 Refresh Token，不能盲目恢复旧快照。
9. **回滚范围**：v2 提交前可凭迁移记录撤销本次已确认创建且未被修改的目标文件并保持源目录；提交后已产生新对话／Token 刷新时不得自动恢复整个旧 home，使用前向修复或单独验证的导出回迁。发布说明明确版本回退限制。

## Open Questions

以下是实施前或相应阶段的验证门槛，不改变上述产品语义，也不能以保留多后台掩盖未完成：

- 当前支持的官方版本是否都有可等待的完整退出、轻量受认证身份确认，以及已加载 Thread／订阅的可靠恢复？不满足的平台／版本先禁用账号管理，不以真实切换已完成发布。
- 如何通过现有 native/platform 接口完成 Windows 私有 DACL 检查及创建？须在实现前给出平台权限测试，不引入 secret 经命令行传递的接口。
- 官方自动继续、队列、实时与委派链路有哪些在途状态需要计入 gate？先用实际支持协议列出登记点并补测试，不能只统计 `turn/completed`。
- 真实原生 Refresh Token 轮换、刷新失败及切换／崩溃边界，需要隔离测试账号授权后实测；本次 401 回调试验不替代这一门槛。
- 哪些旧 native DB 附加数据可通过原生导入／扫描恢复，哪些需要版本受限的迁移？完成受支持矩阵前不得宣称任意旧多 home 无损迁移。
