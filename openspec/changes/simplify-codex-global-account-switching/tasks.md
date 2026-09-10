## 1. 固化实施边界与可验证接口

- [x] 1.1 对照 `design.md` 删除清单盘点 Host、共享契约、Renderer、CDP、包出口和测试的旧账号路由引用；标出真正需要保留的多客户端 RPC 与 External Thread 聚合职责。
- [x] 1.2 从支持的官方二进制生成协议并确认真实退出等待、协议重新初始化、Thread 恢复和轻量受认证身份确认接口；将不支持版本／存储的禁用条件记录为可测能力规则。
- [x] 1.3 列出所有官方工作准入点及终态，包括 pending turn/start、工具／审批、实时、压缩、队列／自动继续与跨 Harness 委派，确定哪些原生行为需要暂停或报告 busy。
- [x] 1.4 确认 Windows 私有 DACL 与 POSIX 权限的既有平台实现；缺少原语时先定义不携带账号语义或命令行秘密的最小 native/platform 接口。
- [x] 1.5 建立合成账号、同工作区不同用户、旧 v1 布局和可注入进程／文件故障的测试 fixture，不提交现场凭据、真实对话或临时日志。

## 2. 单个官方后台生命周期与 Host 隔离

- [x] 2.1 将 `CodexRuntime` 与官方连接改为可等待真实退出的单实例生命周期，复用现有 Broker 与帧处理；补停止超时、输出先关闭、进程晚退出测试。
- [x] 2.2 在本地 stdio 与 Windows 共享监听器组成层注入单个官方所有者；多个 AppServerHost 客户端共享后台、gate 和状态，验证同时最多一个进程。
- [x] 2.3 解耦 `app-server-host.ts` 中官方失败与 Host 全局 finally：受控停止、替代启动失败及回滚失败不关闭 Desktop input、外部 Session、Mapping Store 或委派服务。
- [x] 2.4 实现官方连接代次与 per-client 请求相关性，保存并向新连接重放初始化握手；拒绝旧代次响应及通知，不向 Desktop 重发 initialize 响应。
- [x] 2.5 记录最小原生 Thread 恢复与订阅状态，按需恢复原 ID，覆盖两个客户端 attach 同 Thread；不记录账号绑定或重放已完成 Turn。
- [x] 2.6 增加生命周期聚焦测试：进程顺序退出／启动、非幂等请求不重放、旧 server request 回复不串线、恢复单个 Thread 失败不关闭其他会话。

## 3. v2 账号元数据与私有凭据

- [x] 3.1 将 `AccountRepository` 的运行模型改为共享 home、当前账号引用和账号身份／显示元数据；v1 reader 移至迁移边界，去除 default 删除回退。
- [x] 3.2 实现稳定本地账号 ID 与原生用户＋工作区关联、重复身份更新，覆盖同 Team 不同用户和邮箱变化，禁止仅凭工作区 ID 定位凭据。
- [x] 3.3 实现文件型原生认证的能力预检、私有槽位和原子安装，覆盖损坏、缺失、未知字段格式、路径异常、keyring／外部 Token／API Key 的不支持提示，不改写原生存储设置。
- [x] 3.4 实现并验证 POSIX 0700/0600、Windows 实际 DACL 的私有文件创建与检查；覆盖临时文件、快照、恢复备份以及权限建立失败时无秘密落盘。
- [x] 3.5 保持当前官方存储为刷新权威，停止确认后保存最新凭据；补原生 Token 轮换后的 A→B→A 测试与过时元数据身份核对。
- [x] 3.6 加入输出脱敏与文件写入失败测试，确认秘密不进入元数据、浏览器 RPC、命令行、日志或 fixture；账号模型工作不创建独立 OAuth 刷新客户端（非当前额度读取的受限刷新由 6.9 单独定义）。

## 4. 全局切换事务与恢复

- [x] 4.1 实现唯一所有者上的准入 gate 与所有连接的官方工作登记；busy 检查与工作提交原子化，外部 Harness 自身运行不阻塞切换。
- [x] 4.2 实现 ready/changing/unavailable 和幂等当前账号选择；并发切换／切换中提交明确失败，不做隐藏排队或自动重放。
- [x] 4.3 实现停止确认→保存最新源凭据→安装目标→启动初始化→身份及认证就绪确认→提交／广播的完整顺序，确认成功前不开放 Codex 工作。
- [x] 4.4 实现最小无秘密事务记录及目标失败回滚；目标发生刷新时先保全其最新凭据，再恢复源，回滚失败只使 Codex unavailable。
- [x] 4.5 实现启动恢复与单写入者检查：覆盖凭据已换元数据未提交、当前文件比快照新、外部身份变化及无法确认旧后台退出的 fail-closed 行为。
- [x] 4.6 对每个阶段执行进程退出、断电式重启、rename／保存失败、认证／网络失败注入，核对源目标不串号、不倒退 Token、没有同时两个后台。

## 5. 添加登录、取消、重新登录与删除

- [x] 5.1 用同一独占事务实现单后台设备代码登录；有原账号时完成后恢复原账号，无原账号时首次成功成为当前账号；无额外认证后台。
- [x] 5.2 将“已连接账号”提交改为原生完成＋身份确认，登录前只使用事务内临时记录；同身份重复登录更新而不是复制条目。
- [x] 5.3 实现取消、超时、错误与迟到成功处理，结束登录后台后恢复源凭据；补取消后旧事件／写入不能改变当前账号的测试。
- [x] 5.4 将当前账号重新登录以及 Desktop 原生登录／退出请求纳入相同 gate；不支持模式在改写前拒绝，不保留直接热转发旁路。
- [x] 5.5 改为只删除非当前账号的凭据与元数据，当前账号先显式切换或受控退出；覆盖删除原生来源账号不删除共享 home／Thread 的测试。

## 6. 公共契约、Thread 路由与额度替换

- [x] 6.1 升级 `shared-contracts` 的账号列表、能力、状态、switch、稳定错误和变更通知；明确当前身份与 changing/unavailable 的差别，移除 per-account home、active/isDefault 的旧语义。
- [x] 6.2 同步升级 RendererModelClient、Host 方法分派与版本绑定；旧 activate 和 per-draft 参数仅明确拒绝，不作为新语义别名。
- [x] 6.3 将 start/resume/fork/read/archive 等官方请求统一送到单后台，删除 pending Thread bindings 和按登录账号挑后台；保留外部 Harness 路由与请求相关性。
- [x] 6.4 删除官方账号列表扇出，保留“单官方源＋External Thread”分页聚合；旧 multi-account 游标明确失效并触发首页重读，补分页／归档／Fork 回归。
- [x] 6.5 从 Thread inspection 和用量路由移除固定 Account，Thread 累计 Token 与当前账号额度独立；换账号不清空原生累计用量。
- [x] 6.6 将重置卡消费限定为当前账号；额度读取边界由 6.8–6.11 更新为 OpenCodex 风格的非当前私有凭据 WHAM 查询，仍不启动额外官方后台或隐藏切换。
- [x] 6.7 将 Model、身份和配额刷新绑定 Host 与连接代次，广播单调修订并丢弃旧结果；不自动选择替代 Model 或改变 Provider。
- [x] 6.8 参照 OpenCodex 实现 Host 级 per-account WHAM 额度服务：有界并发、超时、per-account single-flight、成功快照合并和原子持久化；磁盘与 RPC 不含凭据。
- [x] 6.9 为非当前私有凭据实现受控 OAuth 刷新、401 单次重放、稳定身份复核及槽位摘要 CAS 写回；刷新／写回阶段进入全局 gate，普通读取不阻塞整个账号库，切换不能安装已被旋转淘汰的凭据。
- [x] 6.10 扩展账号额度契约和 Renderer，所有已连接账号均读取并保留额度，显示 live/cached 与获取时间；手动刷新和失败不得清除其他账号 last-good 快照。
- [x] 6.11 增加 Host、持久化、多窗口与 Renderer 回归：A/B 并发额度、重启恢复、失败保留、迟到结果／凭据 CAS、当前账号 Native 读取及非当前 reset consume 拒绝。

## 7. Renderer 与 CDP 全局账号体验

- [x] 7.1 删除 `renderer-codex-account-state.ts` 草稿 override 与 `agent-selection-state.ts` 固定 Account 字段，保留 Harness owner/locked 语义及原有草稿功能。
- [x] 7.2 删除 `renderer-binding-probe.ts`、`versioned-renderer-adapter.ts`、`renderer-draft-prewarm-runtime.ts` 中账号选择注入、提交记忆和 `__codexhostAccountId` 生产路径，补 Harness carrier 不受影响测试。
- [x] 7.3 复用账号显示组件，由设置页提供唯一保存账号列表和全局 switch；Composer 只读同步当前身份，明确作用范围、跨账号上下文及“添加时暂停 Codex”的提示。
- [x] 7.4 更新各语言“当前账号／切换账号”文案、busy/恢复错误、未登录状态、非当前额度与删除交互；移除“只影响新任务”的陈旧承诺。
- [x] 7.5 同步该 Host 的多窗口设置、所有 Codex Composer、Model 与用量浮窗；测试旧请求晚到、快速切 Host 和切换失败不显示假成功。
- [x] 7.6 增加 Renderer E2E：已有 Codex Thread 能换账号但不能换 Harness、添加取消无重复条目、非当前额度显示 direct-live 或 last-good 新鲜度、其他 Harness 账号区保持原行为。
- [x] 7.7 从 Harness 选择器删除 Codex 保存账号列表、账号点击切换与多账号徽标；始终保留单一 Codex Harness 选项，并验证设置式全局切换仍同步 Composer 当前身份和额度。

## 8. 旧数据迁移与 SSH 单账号

- [x] 8.1 实现独立 v1 布局盘点、共享 home 选择和迁移预检；覆盖 active 非原生账号、缺失 home、配置差异及第二账号为空的快速路径。
- [x] 8.2 实现受保护的一致性备份与迁移记录，确认所有旧官方后台退出；补 WAL、读取失败和目标目录冲突测试，不自动删除源目录。
- [x] 8.3 导入原生凭据及 v2 元数据，按真实身份去重，保留既有账号选择意图；不确定条目标记需重新登录，不虚构已连接账号。
- [x] 8.4 实现并验证受支持 legacy/paginated rollout 与归档迁移，保留 Thread ID、内容及路径，通过官方列表／恢复核对而非只统计文件数。
- [x] 8.5 完成项目／分组、关系、动态工具、附件、记忆等附加数据的支持矩阵；受支持类型逐项验证，未知 schema 或无法保留的数据明确阻断，不覆盖合并原生 DB。
- [x] 8.6 实现同 ID 同内容幂等跳过、同 ID 冲突阻断、中断重试和提交前撤销；v2 有新工作后禁止整体旧 home 回滚，补源原件保留测试。
- [x] 8.7 只有验证后提交 v2 并禁用旧绑定读取；迁移阻断只影响 Codex，不引入旧多后台 fallback，也不阻止其他 Harness 服务。
- [x] 8.8 为 SSH Host 增加明确单账号能力，前后端禁用账号库 mutation、保留远程原生身份与额度；验证直接 RPC 不能绕过、无本地凭据传输。
- [x] 8.9 区分 Windows 本地 Remote Control 共享连接与 SSH 模式；测试 Linux/macOS 本地能力不被操作系统判断错误禁用。

## 9. 删除旧架构并收敛出口与文档

- [x] 9.1 删除 `codex-runtime-pool.ts`、`account-official-listeners.ts`、`UnknownCodexThreadAccountError` 及出口和实例化点，确认账号数量不影响后台数量。
- [x] 9.2 删除正常运行 `thread-account-store.ts`、bindThread/forThread/历史发现与 `multi-account-thread-list.ts`，旧格式只保留在迁移 reader、安全拒绝和迁移测试中。
- [x] 9.3 移除 app-server-host 的账号路由 Map、固定用量账号 Map 和旧登录解析分支，检查按职责新增模块而不继续膨胀大型 Host 文件。
- [x] 9.4 改写或删除 pool／binding／multi-account-list／renderer-codex-account-isolation 等旧测试、fixtures 和过期包出口，保留真正的 per-client 协议隔离回归。
- [x] 9.5 更新 `docs/codex-accounts.md`、受影响远程文档、升级与回退说明，明确账号全局语义、后台短暂停机、额度范围与存储支持边界。
- [x] 9.6 按 design 删除清单检查 src、tests、docs、包入口及构建输出；确认没有可运行双架构开关、额外认证后台、per-draft 账号或旧游标解码路由。

## 10. 集成验证与完成门槛

- [x] 10.1 运行 `npm run typecheck`、`npm run lint`；用 `tests/vitest.config.js` 执行上述变更所属的聚焦测试，不默认运行无关完整测试套件。
- [x] 10.2 用 `tests/e2e/playwright.config.js` 验证多窗口共享当前账号、busy 竞态、协议重连、失败回滚与 UI 同步，并记录实际执行命令和结果。
- [ ] 10.3 在真实 Desktop 中验证切换只改变官方后台 PID、Desktop/Host PID 不变；外部 Harness 流式 Turn、工具／审批及取消跨切换继续正常，失败路径也不触发全局清理。
- [ ] 10.4 使用隔离授权账号复现 A→B→A 原会话连续性并观察实际请求身份；单独验证原生 Refresh Token 轮换和写回，不用模型自报身份或 401 模拟代替真实刷新验收。
- [ ] 10.5 执行 Windows 文件权限、Linux/macOS 本地生命周期与 Linux SSH 单账号验证；未覆盖平台明确保持不支持能力，不能声称已跨平台通过。
- [ ] 10.6 更新 `evidence.md` 和支持矩阵，确认迁移数据、凭据残留、旧代码删除及所有 specs 场景一致；运行本 change 的 OpenSpec 严格校验后才标记完成。
