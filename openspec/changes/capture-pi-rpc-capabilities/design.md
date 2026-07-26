## Context

Gate A 已证明 Codex Desktop 可以经过 codexhost Shim 透明调用官方 Codex CLI，但正式 Launcher 仍只提供 `inspect`，正式 Shim 仍透明转发，TypeScript Workspace 中的 Protocol Core、HarnessAdapter、PiAdapter、Mapping Store 和 Renderer 均没有业务实现。下一步若直接定义 Host 类型或实现 PiAdapter，会把 Pi RPC 的 Turn 终态、Session Tree、Interaction、History 和 Fork 猜测固化到生产模块。

Gate C 必须先回答用户本机 Pi 官方 RPC 的可观察事实。产品已经确定 Pi 使用 Native Mode：codexhost 调用用户本机可执行程序并复用其 Model、Provider、认证、配置和 Native Session。产品同时确定不安装、更新或管理 Harness 版本；因此本变更既不收集 Harness 版本，也不维护任何版本门禁或兼容矩阵。

当前静态调查和最小只读实验只能作为场景设计输入，不能代替 Gate 证据。已知需要重点验证的风险包括：严格 LF JSONL、Prompt 接受响应可能早于 Agent 事件、`agent_end` 后仍可能重试或续跑、`tool_execution_update.partialResult` 为累计快照、实时事件没有 Session Entry ID、Extension UI 可能早于 Prompt Response，以及 `fork` 与 `clone` 不直接等同于任意 Host Turn Checkpoint。

## Goals / Non-Goals

**Goals:**

- 建立可重复、可审查且不依赖正式 Adapter 的 Pi RPC Capture。
- 通过真实 Pi 证明或否定 MVP 所需的 Stream、Tool、Question、Cancel、History、Model 和 Fork 能力。
- 找到可在实时完成和历史重读之间保持稳定的 Native Session、Native Turn Ref 和 Native Checkpoint 候选。
- 明确 Agent Loop、无 Agent Loop Command、重试、Compaction、取消和进程退出的终态条件。
- 真实能力证据和 Gate 报告只保存在本地忽略目录；仓库只用 Fake Pi 合成 Fixture 固化自动化断言。
- 为后续最小 Shared Contracts 和 PiAdapter 提供事实输入，而不是提前设计它们。

**Non-Goals:**

- 不实现正式 PiAdapter、HarnessAdapter、Protocol Core、Renderer、Mapping Store 或 Host Event 投影。
- 不检测、记录、比较、限制或展示 Pi/Harness 版本。
- 不使用 ACP、Pi SDK、Print/JSON 或 TUI 作为 codexhost 的 Pi 接入方案；Gate 可以调用同一本地 Pi 的原生非 RPC 入口追加测试 Turn，以验证 Native Session 互操作。
- 不由 codexhost 安装、更新或修改 Pi，不修改用户全局 Pi 配置。
- 不承诺 Gate Extension 会进入生产包；它只构造可控验证场景。
- 不验证 Codex Desktop 对 Pi 事件的最终 UI 投影，该工作属于 Gate B、Gate D 和后续垂直链路。

## Decisions

### 1. 以可执行命令和运行时行为为唯一兼容依据

Gate 和未来 Adapter 使用以下优先级选择 Pi 命令：内部显式注入的 `configuredCommand`、`PI_COMMAND`、默认 `pi`。环境变量只表示单个可执行程序或脚本路径；固定参数由调用方以 argv 数组追加，禁止把环境值作为 Shell 命令行拆分或求值。

Gate 不调用 `--version`，不在 Capture、Fixture、Capability Matrix、报告或 Harness Inspection 中保存版本，也不按 SemVer 推断命令和事件。能力由真实 RPC 场景判定：可选命令缺失时记录不支持；MVP 必需行为缺失时 Gate 失败；未知版本本身永远不是错误。

Windows 命令脚本、带空格路径、PATH 发现和直接可执行文件使用平台安全的进程启动方式。测试通过内部命令数组注入 `process.execPath` 和 Fake Pi，不要求把参数编码进 `PI_COMMAND`。

替代方案是绑定 Pi npm 包或维护最低版本。前者改变 Native Mode 和进程隔离边界，后者与产品决策冲突，因此拒绝。

### 2. Gate 代码只进入 tools/tests，不进入生产模块

`tools/gate-c/`承载命令解析、进程启动、LF JSONL、请求关联、场景编排、Capture 和本地报告生成。Fake Pi、Gate Extension 和测试输入作为 Gate 专用 Fixture 或辅助程序存在。仓库协议样本只由 Fake Pi 固定合成场景生成，行为回归由 Gate 专用测试读取。

本变更不从 `packages/adapters/pi` 导出 RPC 类型，也不向 `shared-contracts` 增加 Native Ref。Gate 结束后的独立 change 再依据 Fixture 固化最小正式契约。这样可以允许 Probe 保存 Pi 专属细节，而不把单一 Harness 的协议泄漏到公共接口。

### 3. 自持严格 LF JSONL 客户端，不导入 Pi 包内 RpcClient

Gate Client 直接启动所选命令并追加 `--mode rpc`。stdout 作为唯一协议通道，以字节 `0x0A` 分帧，使用流式 UTF-8 解码处理跨 chunk 字符，不使用会识别 Unicode 行分隔符的通用 Line Reader。EOF 非空尾帧按 Pi 官方 Reader 行为保留`unterminated`标记后解析；未遇到 LF 的单帧缓冲具有可配置字节上限。每个 Command 使用唯一请求 ID，Response 与异步 Event 分流；stderr 只进入有界诊断缓冲。

无法解析的非空 stdout Frame、重复/未知 Response ID、协议 stdout EOF 和进程提前退出必须使相关请求以结构化协议或进程错误收敛。输出写入尊重背压；关闭先停止新请求，再有界结束 stdin、等待进程，必要时升级清理。未知但合法的 Event 或新增字段可以被本地 Capture 原样保存，不得仅因不认识就破坏已关联请求。

导入全局 Pi 包内 `RpcClient`会依赖 npm 安装布局、隐藏本变更需要验证的 Framing 行为并产生包版本耦合，因此拒绝。

### 4. 使用四层验证 Profile 隔离确定性与真实 Native Mode

1. Hermetic Profile 启动 Fake Pi，覆盖 Chunk、UTF-8、LF/CRLF 输入容忍、并发 Response/Event、Malformed Frame、stderr、背压、EOF、超时、Crash 和关闭。
2. Isolated Pi Profile 使用临时 cwd、独立 Session 目录和显式资源开关验证真实 Pi 控制面、Session、Entry Tree 和进程行为，不要求模型调用。
3. Gate Extension Profile 只显式加载仓库内受控 Extension，确定性触发早到 Question、`select`/`confirm`/`input`/`editor`、超时/取消和无 Agent Loop Command；它不加载成生产默认 Extension。
4. Native Live Profile 使用用户当前 Provider、认证、Model 和未被显式资源开关禁用的适用设置快照，在临时项目和独立 Session 中运行真实 Stream、Tool、Edit、Cancel、History、Model 和 Fork；不加载任意用户 Extension、Skill、Prompt Template 或 Theme。

Hermetic 测试进入普通质量门禁。依赖本地 Pi、认证、网络或模型调用的 Profile 只能通过显式 Gate 命令运行；命令执行前显示将使用 Native Mode 和临时目录，结束后清理 Gate 创建的进程及非证据临时文件。

### 5. Prompt 接受、Agent Loop 和稳定终态分别建模

Capture 在发送 Prompt 前分配场景和请求关联，允许缓冲早于 Prompt Response 的 Event/Interaction。Prompt 成功 Response 只证明输入通过 Preflight，不等于 Agent 已启动或 Turn 已完成。

启动 Agent Loop 的场景从 `agent_start`开始，只有 `agent_settled`且状态回读为非 Streaming 后才能判为稳定收敛；`agent_end`、单次 `turn_end`或 Assistant Message End 均不能单独作为最终终态。Probe 必须捕获重试、Compaction、Steer/Follow-up 队列对该顺序的影响，并证明每个已启动的 Agent Run 只产生一个派生 Gate 终态。

Extension Command 或 Input Handler 可以成功处理 Prompt 而不启动 Agent Loop。Gate Extension 提供确定性命令，Probe 结合 Prompt Response、事件观察和状态回读验证无 Agent Loop 的独立完成判据。若无法无竞态地区分，Gate 必须记录为关键终态缺口。

### 6. Tool 证据按 Call ID 关联，Patch 与 Tool 能力分离

Tool Start、累计 Update 和 End 按原生 Tool Call ID 关联；Update 的 `partialResult`按完整快照保存和比较，禁止按文本 Delta 追加。Gate 覆盖成功、失败、取消、并发或交错 Tool，以及未知自定义 Tool。

成功内置 Edit 在合成测试文件上执行，Gate 单独验证原生 Result 是否带可应用的标准 Unified Patch，并以磁盘结果校验 Patch，而不是仅检查字段存在。失败 Edit、Write、Bash 和未知 Tool 没有可靠原生 Patch 时只形成 Tool 能力证据，不通过参数、文件监听、Git 或前后文件 Diff 推断生产 File Change。

可靠 Patch 是可选观察项：缺失不会单独使 Gate C 失败，但报告必须明确后续 UI 只能展示 Tool。

### 7. Question 使用受控 Extension，Approval 只接受明确原生语义

Gate Extension 使用官方 Extension UI 构造阻塞式 `select`、`confirm`、`input`和 `editor`，覆盖 Prompt Preflight 早到请求、Agent Tool 内请求、正常回答、用户取消、超时、错误/重复 Response ID、Abort 和进程退出。Probe 必须证明回答回到同一个请求并使原操作继续或按原生规则取消。

这些 UI 请求默认全部归类为 Question 证据。即使 Extension 用 `confirm`保护危险 Tool，只要原生协议没有明确的 Permission/Approval 类型和 Action 语义，就不得报告 Approval Capability。没有 Approval 是合法结果，不影响 Gate PASS。

Gate Extension 证明的是官方 RPC/Extension 通道的技术可行性。是否为 MVP 提供受控生产 Extension 是 Gate 结果之后的产品/架构决策，不能由测试 Extension 的存在偷偷决定。

### 8. Session Entry Tree 是历史和身份实验的事实输入

每个真实场景使用 Pi 自己创建和持久化的独立 Native Session。Probe 通过 RPC 获取 Session 状态、Entries、Tree 和 active leaf，不直接修改 Session JSONL。原始 Session 文件只用于诊断、原生客户端互操作和证据交叉检查，不成为生产读取方案。

Native Turn Ref 候选必须满足：同一 Native Session 中唯一；实时 Agent Run 完成后可定位；关闭/恢复和重复读取后不变；追加后既有 Ref 不变；成功、失败或取消的可重建 Turn 都有稳定身份。Probe 应重点验证 user Entry ID，但报告必须以实测结果为准。

历史实验覆盖 RPC 创建、关闭后 RPC Resume、使用同一 Pi 可执行程序在原生客户端追加 Turn、再次 RPC Resume，以及 Tree 分支切换后的 active branch。`get_messages`只能作为当前上下文对照，完整身份结论必须来自 Entries/Tree。

### 9. Checkpoint 与 Fork 按实际上下文截止位置验收

Native Checkpoint 只有在 Probe 能从该位置创建独立 Native Session 时才成立，不能因为存在 Entry ID 就声明可 Fork。Gate 至少验证当前最后一个已完成 Turn 和一个非最后已完成 Turn。

每次 Fork/Clone 必须证明：新旧 Native Session 身份和持久化位置不同；来源 Session 不被修改；派生 Session 的 active branch 包含目标 Turn 及其祖先；不包含目标之后的用户消息或 Assistant/Tool 上下文；恢复派生 Session 后可继续下一 Turn。Model/Thinking 变化位于 Turn 间时，报告还必须记录派生 Session 的实际有效状态。

Probe 可以比较 `fork(nextUserEntry)`、`clone()`和官方 RPC 暴露的其他组合，但不得通过改写 Session 文件制造成功。若官方 RPC 无法覆盖任意当前可见已完成 Turn，Gate C 必须 FAIL 或形成明确架构调整，Gate Extension 不用于隐藏该缺口。

### 10. Model、Thinking 和命令目录只按当前 Session 实际结果判定

Native Live Profile 调用当前进程的 Model Catalog，选择两个实际可用且已认证的 Model 执行 Turn 间切换，并通过状态回读和后续 Turn 证明生效。环境只有一个可用 Model 时，该场景记为 BLOCKED 并说明解除条件，不按版本推断不支持。Thinking 选项和命令目录同样只写入本地忽略 Capture。

命令目录验证 Extension Command、Prompt Template 和 Skill 的实际结构，并单独捕获无 Agent Loop Command。内置 TUI 命令若未出现在 RPC Catalog 中，不得由 codexhost 补造。Catalog、状态和 Model 对象中的 base URL、路径、价格、自定义配置和认证信息不得进入提交 Fixture。

### 11. 真实证据只保存在本地忽略目录

真实 RPC Frame、Session、Prompt、模型文本、Tool 输出、路径、本地配置、能力矩阵和 Gate 报告全部写入 `.codexhost/gate-c/`，不得提交。开发阶段不实现真实证据脱敏、Golden 生成或可提交报告流程。

仓库中的 Fixture 只能由 Fake Pi 和固定合成数据生成，用于验证 Envelope、事件顺序、字段存在性、错误收敛和 Gate 判定逻辑。合成 Golden 不得在测试失败路径自动更新，更新必须使用显式命令。

本地 Gate 报告包含代码提交、操作系统/架构、命令来源类别、场景状态、能力矩阵、证据路径和结论，但不主动执行 Pi/Harness 版本查询。权威报告要求干净且执行前后提交不变的 Git 工作树，只由一次显式 `gate:c`进程内的完整 Profile 结果生成；独立 Profile 运行仅用于诊断，不按各自“最新目录”自动拼接。

### 12. Gate 只以必需行为和完整证据判定

Gate C 结论为 `PASS`、`FAIL`或 `BLOCKED`。PASS 要求真实 Pi 的启动/关闭、Stream、Tool、Question 往返、Cancel、History/Resume、稳定 Native Turn Ref、两个实际 Model 间切换以及从已完成 Turn 精确 Fork 全部成立，并且 Agent Loop 明确由 Pi 执行。

FAIL 表示可执行程序和必要环境可用，但已证明任一必需行为或安全不变量不成立。BLOCKED 仅用于未安装/不可执行、缺少认证/第二个可用 Model、网络或外部环境条件导致无法判定。Approval、Reasoning 或可靠 Patch 不存在属于能力矩阵结果，不单独导致 FAIL。

普通 `npm run check`只运行 Hermetic 和合成 Fixture 回归，不要求本机安装 Pi。真实 Gate 使用独立命令，并在报告前运行受影响的格式、Lint、类型、测试和构建检查。

## Risks / Trade-offs

- [用户 Native Mode 可能访问付费模型或私有 Provider] → 真实场景必须显式运行，使用最小固定 Prompt，并在运行前展示边界；原始响应不提交。
- [用户 Extension 或项目资源使结果不确定] → 隔离、Gate Extension 和 Native Live Profile 分开；Native Live 只继承 Provider、认证、Model 和未被显式禁用的适用设置，不加载任意用户资源。
- [Gate Extension 证明通道却被误认为生产方案] → 报告分别标记默认 RPC 与显式 Extension 证据，生产注入必须另行决策。
- [模型可能不按 Prompt 调用指定 Tool] → 使用最小明确 Prompt、可重复场景和结果断言；无法稳定触发时标记 BLOCKED，不伪造事件。
- [Session/Model 响应包含本地配置] → 所有真实证据和报告只写入 Git 忽略目录，不生成可提交的真实 Fixture。
- [Fork 表面成功但包含目标之后上下文] → 对比新旧 Entry Tree 和 active branch，继续 Turn 前先断言精确截止位置。
- [未知新增事件使严格 Schema 拒绝可用 Pi] → Gate 传输层先识别 Envelope，未知 Event 隔离记录；只有破坏必需状态机时才影响结论。
- [真实 Gate 仅在一个操作系统执行] → 协议能力结论不维护平台矩阵；进程启动/清理由双平台 Hermetic 测试覆盖，发布前仍执行双平台完整 E2E。

## Migration Plan

1. 增加 Gate-only 命令、Fake Pi、忽略目录和 Hermetic 测试，不改变任何生产入口。
2. 完成隔离 Pi、Gate Extension 和 Native Live 场景，生成本地原始证据。
3. 使用本地真实 Capture 运行 Gate 判定并形成本地能力验证记录；仓库回归只读取 Fake Pi 合成 Fixture。
4. 按证据修正开发步骤和技术设计；若 Gate 非 PASS，停止把受影响能力作为后续实现前提。
5. Gate PASS 后，由独立 change 定义最小 Shared Contracts 和 PiAdapter 契约；Gate 工具仍不进入发布包。

## Open Questions

- Prompt Response、早到 Interaction、`agent_start`和状态回读能否形成无竞态的接受/启动判据？
- 自动重试、Compaction、Steer/Follow-up 和无 Agent Loop Command 的完整事件顺序是什么？
- Abort 后哪个事件与状态组合能证明 Agent、Tool 和 Pending Interaction 已真正停止？
- 哪个 Session Entry 或组合键满足 Native Turn Ref 的实时/历史稳定性要求？
- 官方 `fork`/`clone`组合能否精确覆盖任意当前可见的已完成 Turn？
- 成功 Edit Patch 在多编辑块、CRLF 和失败场景中是否保持可应用和可归因？
- Question 是否只能通过 Extension UI 提供，以及若生产 MVP 需要受控 Extension，应采用什么安装和信任边界？
