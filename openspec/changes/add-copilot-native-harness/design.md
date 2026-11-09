# Design

## Context

本设计服务于 [proposal](proposal.md) 和 [Copilot 行为规格](specs/copilot-harness-session/spec.md)。涉及原生权限、认证、持久身份与跨包发行，因此显式提供技术设计。

当前仓库已有公共 `HarnessAdapter` / `HarnessSession`、动态插件 Loader、目录驱动 Desktop、Thread 持久化、预热、空闲释放和委派 Coordinator。Copilot 目录目前只有 [能力清单](../../../packages/adapters/copilot/CAPABILITIES.md)，尚无运行实现。清单按最新 skill 保留全部 39 行，静态证据不等于已支持。

设计依据是 SDK `v1.0.25`（提交 `339e55beb4b75e5923e4ddc9208f377efa0c15f5`）的官方发布源码；源码标记配对 CLI `1.0.102`，尚未实测该组合。此前仅发现当前工具 PATH 中没有 `copilot`，不能据此判定机器未安装。实施阶段先按公共 discovery 完整发现，再确定实际验证版本。

主要仓库依据：

- `packages/harness-adapter/src/text-session.ts`、`plugin.ts`：公共运行契约与工厂上下文。
- `packages/shared-contracts/src/harness-models.ts`、`harness-plugins.ts`：能力、目录与 Manifest schema。
- `.agents/skills/codexhost-add-harness/references/`：能力优先级及各项验收规范。
- `packages/adapters/qoder/src/plugin.ts`：SDK 插件工厂和安装管理组合；只参考职责，不复制整包。
- `packages/host-runtime/test/installed-harness-plugins.test.ts`、`tests/release/host-bundle.test.mjs`：真实加载、隔离产物和核心 Bundle 边界。

既有历史、权限、委派等规格继续适用，本提案仅增加 Copilot 的具体行为。skill 的清单没有列出源码中的所有可选接口；以当前类型为准，不借此删除现有接口。尤其后台活动的正确清理仍然必须满足，即使完整 Subagent 能力放在 P2。

## Decisions

### 1. 官方 SDK 连接显式本地 CLI

连接方向固定为：

```text
Desktop / 公共委派
  → Host 公共 Thread Runtime
  → Copilot 插件的 HarnessAdapter / HarnessSession
  → 官方 Copilot SDK（headless stdio RPC）
  → 用户安装的 Copilot CLI
  → 原生工具、会话存储和认证
```

使用 `CopilotClient`、`RuntimeConnection.forStdio({ path })`，显式选择发现的 CLI，设置 `mode: "copilot-cli"`。SDK 管理 RPC 编解码和原生回调，插件只做契约适配。该模式及显式连接接口来自 [官方 Types](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/types.ts) 和 [Client](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/client.ts)。

Paseo 当前采用 `copilot --acp`，说明 ACP 是可行传输，但不能替代对 Copilot 原生身份、配置和历史的验证。此方案使用原生接口减少协议转换，直接使用 SDK 暴露的历史与权限能力。首次不引入 ACP 双栈、FFI 或共享常驻服务；遇到缺口先判断具体原生方法是否可用，不静默换协议。

一个可写公共 Session 拥有一个独立 Client/CLI 进程；检查使用短期 Client。这样 cwd、环境、认证覆盖和关闭归属明确，代价是并发 Thread 的进程开销。空闲释放沿用 Host 公共机制。

复用 `harness-discovery`，支持 `CODEXHOST_COPILOT_COMMAND` 的显式覆盖。发现结果必须转换为 SDK 实际支持的启动描述，分别验证 macOS/Linux 可执行文件、Node 脚本和 Windows shim。错误时不回退到 SDK 自动下载的 runtime；插件和 CLI 分别记录版本，不根据 SDK 版本号推测用户 CLI 一定兼容。

### 2. 登录交给原生运行时复用

官方明确说明 SDK 可以复用 Copilot CLI 登录后保存的凭据，见 [SDK 认证文档](https://github.com/github/copilot-sdk/blob/v1.0.25/docs/auth/authenticate.md#github-signed-in-user)。插件设置 `useLoggedInUser: true`，不传 `gitHubToken` 或 Token Provider，不读取、复制或导出 Token。

不新增 `baseDirectory`、隔离 HOME 或替代 COPILOT_HOME；保留目标 Host 的用户配置。原生环境认证可以优先于存储登录，见 [认证优先级](https://github.com/github/copilot-sdk/blob/v1.0.25/docs/auth/authenticate.md#authentication-priority)。因此“允许复用本地登录”不意味着“强制使用系统凭据库中的账号”。SSH 的认证取自远程 Host，不能依赖本机 Keychain。

工厂环境作为基础，Session environment 覆盖其上，包括 `undefined` 删除覆盖的语义；不修改全局 `process.env`。检查不调用交互式登录。认证探测只记录脱敏状态和认证来源，不记录环境变量值；存储登录测试在受控子进程中排除 Token 覆盖，与环境认证测试分开，避免把后者误判为登录复用成功。BYOK 下不能仅根据 GitHub 登录布尔值误报整个 Harness 不可用，需结合实际原生配置核实。

### 3. 按映射难度实施，而非把接口存在当作能力完成

| 能力与清单项 | 原生候选 | 公共映射与必须确认的语义 |
|---|---|---|
| A3 检查 | `getStatus`、`getAuthStatus`、`listModels` | 直接映射状态和目录；验证无会话副作用、cwd、缓存刷新及登录来源 |
| A4/A5/A8 创建执行恢复 | `createSession`、`send`、`resumeSession` | 对应 open/execute；必须探测逻辑消息身份、早到事件、冷恢复和权限恢复 |
| B8 文本与工具 | message/reasoning/tool/compaction 事件 | Item 类型可直接对应；真实 command、diff、截断及 delta 去重需样本验证 |
| B9/B10 双向交互 | permission、user-input、elicitation 回调 | 对应 Interaction；确认授权范围、自由文本、多选、取消和无法表示的 schema |
| A6/A10 取消关闭 | `abort`、`disconnect`、`stop` | 请求与终态分离；验证工具/交互中取消、清理及下一轮可写 |
| B1/B2 Model/Thinking | `models.list`、`session.model.list`、`setModel`、`model.setReasoningEffort`、`model.getCurrent` | opaque Ref 和完整状态；探测动态 effort、活动期生效点和读回 |
| B3/B4 权限/执行意图 | `permissions.getMode/setMode` | Permission Mode 可对应；unattended 必须独立证明，不能直接等同 allow-all |
| A7 历史 | `getEvents`、`eventLog.read`、`sessions.readPersistedEvents` | 必须确认持久身份、分页完整性、compaction 和终态证据 |
| B5/B7 派生 | `sessions.fork`、`history.rewind` | 必须验证排他边界、空前缀、源不变、当前配置继承及副本续写 |
| B12 自主输出 | continuation、idle、autopilot 事件 | 独立逻辑 Turn、根/子归属和后台活动边界均需实测 |
| B13 用量 | `session.usage_info`、`assistant.usage` | 直接映射可靠字段；确认单位、累计范围、刷新和历史恢复 |
| B15 接收委派 | 现有 Coordinator 和普通 Thread | 不增加专用执行接口；验证完整环境传播、观察、取消与重启续跑 |

“直接映射”只表示公共契约已有容器，仍需回归测试与原生验证。官方 [Session](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/session.ts)、[事件类型](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/generated/session-events.ts) 和 [RPC 类型](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/generated/rpc.ts) 是静态依据。RPC 中的实验性方法不能仅凭类型存在就宣称目标 CLI 支持。

### 4. 生命周期、预热与配置确认

`inspect` 无需创建 Session；成功缓存按真实 cwd/配置作用域区分，refresh 绕过 Adapter 和 SDK 内部缓存，临时 Client 最终关闭。availability 结果不写入完整目录缓存。

`open(create)` 默认惰性创建原生会话：保存请求配置，首次 Turn 或首个配置命令时才初始化原生 Session。初始 state 只包含已确认事实，不能把默认目录选项或 requested 值当 effective。未发消息的草稿关闭后不留原生历史。

**首次 Turn 前的配置选择是探测门槛 G2。** 首选由公共 Composer 草稿将选择作为 create 输入保存，首轮原生创建时确认。必须实测已预热草稿是否会直接发出 Session select：若会，需验证原生是否支持无持久副作用的配置准备，或可安全释放且自动清理的未提交会话。禁止返回假 completed，也禁止让配置请求无限等待首次消息。若现有原生方式与公共草稿流程无法同时满足这两项契约，先记录通用缺口并修订方案，不能通过 Copilot 专用 UI 分支交付。

`open(resume)` 恢复原生身份，当前环境覆盖生效；保存的 Model/Thinking/权限是恢复提示，原生确认状态优先。不同 Session 的订阅、定时器和进程均由所属实例释放。

配置使用原生 setter 与权威读回，完整更新 Model、effort 及可选项。权限 `manual/assisted/allow-all` 与工作模式 `interactive/plan/autopilot` 是不同维度，后者不塞进权限下拉框。自定义 Agent/工作模式选择不在本次新增公共 UI 范围，但原生默认行为产生的输出必须正确处理；不能安全处理的模式须在启动前明确拒绝。

无人值守意图只在验证原生权限、沙箱/执行限制及交互策略等价后接受。无法保证时 open 在执行副作用前返回类型化拒绝，并把接收委派的相关限制写清楚。不能用 `approveAll` 或自动回答实现表面上的完成。

### 5. 一个用户 Turn 包含完整 Agent Loop

发送前建立事件订阅；原生创建期间先收集初始化事件，调用 `send` 前绑定本次 Host turnId。SDK 返回的是逻辑 messageId，事件可能先到，使用有界缓冲关联早到事件。缓冲溢出或无法关联时返回明确故障，不无限堆积。

Host turnId、事件 id、逻辑 messageId 和原生 `assistant.turn_*` 的 turnId 分开管理。后者是内部循环边界，不能拆成多个用户 Turn。只有原生用户消息实际进入历史且身份稳定后，才发布可持久化 NativeTurnRef；无法建立身份的普通 Turn 不发布成功终态。

`abort` 只表示取消受理；`assistant.idle` 和 `session.autopilot_stopped` 均不能单独证明所有工作停止。以匹配请求的原生终态、工具/交互状态和 `session.idle` 等证据共同裁决。取消超时走故障路径，保留历史供冷恢复，不能先宣布取消成功再让旧回调污染新轮。

文本、工具和交互共享一条有序公共输出流。重复 delta/完整消息去重；未知工具保留通用结构化内容。文件修改只使用原生可靠 diff；局部 diff 标记 fragment。原生未公开的 Reasoning 不推断。

原生自主 continuation 与隐藏注入、子 Agent 消息分开识别。完整 Subagent observe/readTranscript 是 P2，但正确区分根消息、追踪仍运行的后台工作、避免提前释放属于 P0/P1 的生命周期正确性，不能延期。如果涉及当前类型中的 detached Item，按现有契约处理并补充专项测试；不照搬过时的“终态后绝无任何后台事件”假设。

### 6. 历史事实、身份和派生

历史映射与实时内容投影共享归一化规则，但历史读取不会重新发送 outputs。候选稳定逻辑 Turn key 为持久根 `user.message.data.messageId`；该字段在类型中可选，因此 G3 必须验证已验收版本在成功、失败、取消和冷读取中的可用性。若改用持久事件 id，必须同时证明实时关联、重读与追加历史稳定，不能随机补造身份。

Native Ref 的 locator 只保存恢复所必需的非敏感原生位置及格式版本，不存 Token、环境副本或 Transcript。具体 locator 字段在 G3 通过后固定并加 schema/负向测试；不为其他 Harness 扩展公共格式。

活动 Session 优先使用官方只读事件方法；离线检查/派生定位优先评估 `sessions.readPersistedEvents`。完整分页必须具有一致 generation/边界且最终 `cursorStatus=ok && hasMore=false`；expired 返回空页不能视为完整。最多有界重试，仍失败则不返回部分成功快照。

`session.idle` 属于临时事件，不能假设历史含有它。缺少可靠持久终态时 historical outcome 使用 unknown；Item outcome 同样只基于真实完成证据。压缩前后顺序、隐藏消息过滤和原生文件变化纳入样本。

Fork checkpoint 锚定一个逻辑根 Turn 的完成边界；编码保持稳定，执行时读取新鲜历史找到下一根用户事件作为 `sessions.fork.toEventId` 的**排他**边界，末尾位置在 G5 验证后选择准确调用方式。不能把 NativeTurnRef 直接当 toEventId，也不能让“末尾 checkpoint”在后续追加历史后改变含义。

Rollback 使用最后根用户事件之前的原生前缀，创建新身份交给 Host 公共替换事务。单轮到空前缀必须验证；如需 rewind，只对副本使用 conversation 模式，绝不触碰源或使用 conversation-and-files。派生会话在执行前应用当前已确认配置并读回；权限/Model 配置失败时关闭新资源，源和 Host 映射保持有效。只清理本操作明确创建的失败副本，不能误删源；已提交用户消息的 Session 正常 close 永不调用 deleteSession；未提交草稿的 close 只删除本实例明确创建的原生空会话。

### 7. 原生探测与交付门槛

探测在临时工作目录、独立测试会话中进行，记录 SDK/CLI 版本、平台、认证方式、Model、权限、local/SSH 环境和脱敏事件样本。只有后续实施阶段运行真实模型请求；本提案未运行 Copilot，也未读登录凭据。

| 门槛 | 要回答的具体问题 | 通过条件 / 失败处理 |
|---|---|---|
| G1 启动与认证 | 显式本地 CLI 是否被使用；SDK 是否复用存储登录；环境覆盖如何生效 | 无 Token 覆盖的存储登录验证、环境认证独立验证、未登录无 OAuth、副作用与进程清理检查；失败则阻断该环境 ready |
| G2 预热与配置 | inspect 是否无 Session；草稿选择是否能真实确认且不留下空会话 | 对比原生会话列表/存储，覆盖预热选择、丢弃和首次发送；无法同时满足则修订通用方案，禁止假状态 |
| G3 稳定历史 | messageId 是否持久；压缩/分页后逻辑 Turn 和 Item 能否对齐 | 多轮成功/失败/取消、重复读取、追加、冷恢复与 cursor expired；不能满足则阻断普通 Thread 交付 |
| G4 取消与交互 | 哪个信号确认执行已停止；原生回调如何取消 | 文本/工具/审批/提问中取消、迟到响应、故障及续跑；无可确认终态时故障并恢复，不伪造取消 |
| G5 精确派生 | 中间/末尾排他边界、单轮空前缀、当前配置能否保留 | Fork/rollback 后快照精确、源与文件不变、副本可写；缺少原生能力须记录证据并拒绝，接口存在但未验证不能算完成 |
| G6 权限与配置 | 原生模式能否读回；活动期切换；unattended 是否等价 | 成功/拒绝后状态一致、恢复一致、权限冲突拒绝；无人值守未证明就明确拒绝 |
| G7 自主活动与用量 | 根/子/自主事件如何区分；何时真正空闲；Usage 的单位和恢复来源 | 真实事件序列无丢失和串轮，后台不被提前释放，用量不重复且未知不估算 |
| G8 包装与产品 | SDK 运行资源是否完整；目录驱动 UI 和委派是否可用 | 仓库外 Loader、payload、Desktop、委派链路通过；按平台/远程环境分别记录，不外推已验证范围 |

先解决 G1–G4 与配置预热冲突，再固化身份和事件实现；G5–G7 决定 P1 条件能力的具体实现和声明。必做 P0 失败不能只关闭能力开关就完成任务；原生有则必做的 P1 也不能因实现困难直接写“不支持”。若必须缩减普通 Thread 范围，先修订本提案再交付。

### 8. 插件职责、发行与验证

建议插件内按实际职责拆为工厂/Manifest、发现与安装、Adapter 检查与打开、Session 生命周期、事件/工具投影、Interaction、历史与派生、配置和用量；实现时仅在职责足够独立时拆文件，不预建空层。复用公共输出、校验、诊断和 discovery 工具，SDK 类型不越过插件边界。

插件外预期改动限定为根 `tsconfig.json` references、`package-lock.json`、`scripts/release/harness-plugins.json`、预装集合/发行与公共路径集成测试、文档索引和 README 能力表。若 SDK 有外置依赖或动态资源，按既有 runtimePackages/打包机制显式纳入；仅在真实 Bundle 证据显示不足时调整通用打包逻辑。Host 核心 Bundle 不包含 SDK，不新增静态 Adapter 注册。

验证分四层：

1. 插件公共行为与原生进程 fixture：覆盖事件早到、乱序/迟到、拒绝、取消、崩溃、交互竞态、分页和历史边界，回放脱敏真实样本。
2. 隔离 Loader 与发行 Bundle：从仓库外加载，断开 workspace/node_modules 借用，验证独立实例、关闭及未安装 CLI 的准确状态。
3. 原生环境：执行 G1–G7，分开记录静态依据、合成测试与真实请求结果。macOS/Linux/Windows 的启动和资源路径逐项核实；SSH 认证与工具环境单列。
4. Desktop/公共委派：Picker、连接页、配置、交互、取消/调整方向、Usage、Fork/回滚、重启恢复、Host/Thread 切换；委派验证首轮、续轮、busy、read/wait、取消、人工接管及重启后续写。

实现检查从根 package scripts 选取类型、lint/边界和必要构建，聚焦 Vitest 使用 `tests/vitest.config.js`。不默认跑全仓；构建通过不能代替原生与 UI 验收。每项完成时更新能力清单的源码路径和测试/实测证据；P2 保留明确后续范围，不声明已实现。

## Risks / Trade-offs

- [实验性历史/权限 RPC 与用户 CLI 不匹配] → 固定 SDK 基线并验证目标 CLI 范围，已知不兼容版本给出明确错误；升级重新跑相关原生门槛，不自动切换协议。
- [系统凭据库在 GUI、SSH 或受管进程不可达] → 分环境验证认证；保持目标 Host 自己的配置和登录，失败引导原生 CLI 登录，不导出凭据。
- [惰性 Session 与首轮前配置确认冲突] → G2 先验证公共调用路径与原生无残留能力；不能同时成立时作为设计缺口处理，先于生产实现收敛。
- [临时终态不持久化、compaction 改变事件可见性] → 使用稳定原生身份，明确 unknown 和不可用 Checkpoint，完整分页失败不返回截断成功。
- [每 Session 一个进程增加开销] → 先保持隔离与清理正确，复用 Host 空闲释放；没有测量证据前不引入共享进程池。
- [结构化提问或原生模式超出公共表达能力] → 记录具体字段/语义缺口，给出明确失败而非自动批准；必要的通用扩展另行修订规格、schema、Host、Renderer 和测试。
- [P2 Subagent 功能未完成但原生已启用后台行为] → 本次仍处理后台存活、归属、取消及自主输出；不能安全处理的模式显式拒绝，不宣称完整 Subagent Transcript。

## Migration

这是新增 Harness，无既有 Copilot Host 映射需要迁移。部署时随发行提供插件并按现有预装启用机制加载；用户保持自己的 CLI 安装和登录，Host 重启后发现新插件。

回滚插件发行或禁用 Copilot 时保留 Host 映射及原生会话文件，已有 Thread 显示 Harness 不可用；重新安装兼容插件后按保存的原生身份恢复。不得将 Copilot Thread 改路由到 Codex。SDK/CLI 更新前验证 locator 与历史兼容性；无法解析的版本明确拒绝恢复，不重写源数据。

## 原生门槛收敛（2026-10-22）

G2–G4 的最小实验已执行，证据和未覆盖矩阵见 [原生验证](../../../packages/adapters/copilot/test/NATIVE-VERIFICATION.md)。CLI 1.0.102 的空会话在列表中不可见但会留下磁盘目录；草稿配置命令可创建本实例独占的原生空会话、真实 setter/读回后完成，在未提交任何根用户消息的 close 中 disconnect + deleteSession 并验证清理。首次根用户消息建立持久身份后不再删除。Host 的预热配置路由直接调用 Session select，因此不能只保存 requested 并返回 completed。

逻辑 Turn 身份固定为根 user.message.messageId；parentAgentTaskId 在本机根消息上也出现，不能用它判断 Subagent，根/子归属使用事件 agentId。Session Ref locator 使用 `{ storage: "copilot-cli", version: 1 }`，不固定 HOME 或复制配置。取消依据 abort 后 session.idle.aborted，等待中的回调一并解除。历史没有持久 idle 时 outcome 为 unknown。G1 的当前认证来源为 gh-cli；存储 OAuth 与有效环境 Token 优先级尚未实测。

生产实现把无人值守意图映射到原生 allow-all 与显式 sandbox 配置，保留原生提问/表单回调和人工接管。创建时拒绝明确冲突的权限；后续用户选择实时传给原生，恢复尊重其当前权限。Native Ref 中的 executionPolicy 是恢复 sandbox 启动配置所需的不可变提示，不把 Permission Mode 永久锁住。

URL elicitation 的浏览器打开/原生完成关联不在当前 HostQuestion 契约内；目前明确返回 unsupported。若扩展，应使用 Harness 无关的可选 external-action Interaction，一并设计本地/远程 Host 的动作与回调，不以普通文本回答伪装浏览器动作。


模型资格门槛：CLI 1.0.102 的 Free 账号仅可选择 Auto，headless 具体模型目录不包含这个虚拟路由。Adapter 仅在原生 GitHub 认证或会话 Copilot provider 证明 Copilot 上下文时提供 Auto；不从内置模型表生成具体选项。显式配置先验证原生目录，避免低层 setter 暂存了不可选模型后在执行时被原生切回 Auto。Thinking 独立设置、校验已公布选项并读回；Auto 没有 effort 选项。详细对照和验收见原生验证记录的模型目录排查。


初始 Model 选择：Adapter 对实际可用目录提供 defaultModel 作为 Desktop 的初始推荐选择，优先 Auto，否则选择原生顺序中的第一个可用模型。只有一个 Auto 时直接显示并选择 Auto。Renderer 保留既有用户偏好优先的公共流程；本次接入不修改 Renderer 生产代码。该产品初始选择与原生 effectiveModel 分离，真正执行前仍验证资格并读回；不改用户的原生配置，也不为直接省略 Model 的 open 请求强制填值。


账号额度与 Credits 按用户追加范围接入：新鲜账号查询使用原生 quota.refresh 的 providerQuotas，只有 authoritative_budget/account_snapshot/succeeded 的预算可投影为限额与百分比；未知单位不展示数量，无限额度不伪造成零。为获得单位创建独占临时草稿，不发送输入，查询后 disconnect/delete/stop，失败草稿在 close 重试清理。浮窗缓存 15 秒；显式检查重新解析原生认证，刷新先移除旧缓存，前后身份不一致时丢弃结果。会话 totalNanoAiu 按官方 nano-AIU 定义除以 1e9，保留完整状态；partial/unavailable 不显示为完整 Credits，不转换 USD。全部走现有可选公共契约，不修改 Host/Renderer。


实时性能投影：用 assistant.message 的 apiCallId 和 originatingMessageId 关联根逻辑 Turn，再匹配 assistant.usage；支持两种到达顺序，按调用去重并有界保留。生成 TPS=本轮原生 outputTokens 总和 / Σ(duration-outputTtftMs)，API 平均速度使用 Σ(duration)；outputTokens 已含推理，不重复相加。缺失计时停止本轮对应指标更新，不用字符数、工具等待或整轮墙钟时间替代；最近有效测量留在当前连接，冷恢复不回填临时事件。assistant.usage 的 inputTokens 已含缓存，最近命中率为 cacheReadTokens/inputTokens；累计使用 getMetrics 的 uncached+cache_read+cache_write，经 sessionCacheUsage 交公共 Host 计算平均值。公共契约与 Renderer 不变。
