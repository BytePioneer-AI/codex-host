# pi-rpc-capability-probe Specification

## Purpose
TBD - created by archiving change capture-pi-rpc-capabilities. Update Purpose after archive.
## Requirements
### Requirement: 通过可注入命令启动 Pi RPC 且不建立版本约束

Pi RPC Probe MUST 按内部显式命令、`PI_COMMAND`、默认 `pi` 的优先级选择本机可执行程序，并 MUST 以独立 argv 追加 `--mode rpc` 和场景参数。Probe MUST NOT 检测、记录、比较或限制 Pi/Harness 版本，MUST NOT 使用 ACP 或 Pi SDK，并 MUST 只按实际 RPC 行为判定能力。

#### Scenario: 使用默认本机命令

- **WHEN** 未提供内部命令且 `PI_COMMAND`未设置
- **THEN** Probe MUST 启动 PATH 中的 `pi`并传入独立的 `--mode rpc`参数
- **AND** Probe MUST NOT 执行版本查询或加载 Pi npm SDK

#### Scenario: 使用环境覆盖命令

- **WHEN** `PI_COMMAND`指向可执行程序或平台脚本
- **THEN** Probe MUST 将其作为单个命令路径启动
- **AND** Probe MUST NOT 将该值作为 Shell 命令行拆分或求值

#### Scenario: 使用测试注入命令

- **WHEN** Hermetic 测试注入 Fake Pi 命令和前置参数
- **THEN** 注入 MUST 优先于环境和默认命令
- **AND** Probe MUST 仍以结构化 argv 追加 RPC 参数

#### Scenario: 命令不存在或无法进入 RPC

- **WHEN** 选择的命令不存在、不可执行或无法启动 RPC 模式
- **THEN** Probe MUST 返回明确的安装、启动或协议错误
- **AND** 诊断 MUST NOT 将失败归因于未知或不支持的版本

### Requirement: 严格处理 LF JSONL 和请求关联

Probe MUST 将 Pi stdout 作为严格 LF JSONL 协议通道，以字节 LF 分帧并支持跨 Chunk UTF-8 解码。Probe MUST 为未遇到 LF 的单个 Frame Buffer 设置可配置字节上限。Probe MUST 为 Command 分配唯一请求 ID，区分 Response 与异步 Event，隔离 stderr，并对写入背压、Malformed Frame、未知 Response 和 stdout EOF 给出有界结果。

#### Scenario: Frame 跨任意 Chunk 和 UTF-8 边界

- **WHEN** Fake Pi 将多个 JSON 对象、单个对象或多字节字符拆分到任意 stdout Chunk
- **THEN** Probe MUST 只按字节 LF 恢复完整 Frame
- **AND** 每个 JSON 对象 MUST 恰好解析一次且内容不损坏

#### Scenario: Frame 超过缓冲上限

- **WHEN** stdout 持续输出超过配置上限的字节且没有 LF 分隔符
- **THEN** Probe MUST 产生结构化 Frame 过大错误并释放残余缓冲
- **AND**相关 Pending Command MUST 有界失败而不是继续增长内存

#### Scenario: 收到并发 Response 和 Event

- **WHEN** 多个 Pending Command 的 Response 与异步 Event 交错到达
- **THEN** Probe MUST 按 Response ID 只完成对应请求
- **AND** Event MUST 按接收顺序进入独立事件流

#### Scenario: 收到未知合法 Event 或新增字段

- **WHEN** stdout Frame 是合法 JSON Envelope，但包含 Probe 未认识的 Event 类型或附加字段
- **THEN** Probe MUST 将其隔离为未知协议证据并继续维护已知请求关联
- **AND** 未知内容只有在破坏必需状态机时才可导致 Gate 场景失败

#### Scenario: 收到 Malformed Frame 或未知 Response

- **WHEN** stdout 出现非空且无法解析的 Frame、重复 Response ID 或无法对应 Pending Command 的 Response
- **THEN** Probe MUST 产生结构化协议错误并保存受限诊断
- **AND** MUST NOT 忽略该 Frame、伪造成功或让相关请求永久等待

#### Scenario: stderr 产生诊断

- **WHEN** Pi 或 Fake Pi 向 stderr 写入文本
- **THEN** Probe MUST 将其保存到有界诊断缓冲
- **AND** stderr MUST NOT 参与 JSONL Frame 解析或请求关联

### Requirement: 有界监督 Pi RPC 进程生命周期

Probe SHALL 监督自己创建的 Pi 进程及测试后代，停止接收新请求后有界关闭 stdin、Pending Request、Interaction 和进程。正常退出、启动失败、Crash、超时、stdin EOF 和强制关闭 MUST 具有唯一且可解释的结果，Gate 结束后 MUST NOT 留下由本次运行创建的孤儿进程。

#### Scenario: Pi 正常关闭

- **WHEN** 场景完成且 Probe 请求关闭 RPC 进程
- **THEN** Probe MUST 停止新请求、有界等待 Pending 工作并关闭 stdin
- **AND** MUST 排空 stdout/stderr 后记录正常退出

#### Scenario: Pi 在请求期间退出

- **WHEN** Pi 在一个或多个请求、Agent Run 或 Interaction 未完成时退出
- **THEN** 所有 Pending 操作 MUST 以同一个进程退出事实收敛
- **AND** Probe MUST NOT 将其标记为成功或无限等待

#### Scenario: 温和关闭超时

- **WHEN** Pi 或其测试后代在关闭宽限期内未退出
- **THEN** Probe MUST 升级为平台安全的强制清理
- **AND** MUST 复核本次运行创建的进程已结束或明确报告清理失败

#### Scenario: 普通质量检查

- **WHEN** 开发者或 CI 运行普通 Hermetic 测试
- **THEN** 测试 MUST 使用 Fake Pi 覆盖 EOF、Crash、超时和后代清理
- **AND** MUST NOT 要求本机安装 Pi 或访问模型网络

### Requirement: 隔离真实 Pi 控制面和 Native Mode 场景

真实 Pi 验证 MUST 使用临时工作目录和独立 Session 目录，并 MUST 将 Hermetic、隔离控制面、Gate Extension 和 Native Live 场景分开。Probe MUST NOT 修改用户全局 Pi 配置、项目工作文件或非 Gate Native Session。

#### Scenario: 执行隔离控制面场景

- **WHEN** Probe 验证真实 Pi 的状态、Session、Entries、Tree 或 Gate Extension
- **THEN** Probe MUST 使用合成 cwd、独立 Session 目录和明确资源参数
- **AND** 场景 MUST NOT 依赖用户项目内容或产生模型费用，除非该场景明确标记为 Native Live

#### Scenario: 执行 Native Live 场景

- **WHEN** 操作者显式启动需要真实 Agent Loop 的 Gate 命令
- **THEN** Pi MUST 使用用户当前 Native Mode 的 Model、Provider、认证和未被显式资源开关禁用的适用设置快照
- **AND** Probe MUST NOT 据此声明任意用户 Extension、Skill、Prompt Template、Theme 或项目资源已经继承
- **AND** Probe MUST 在运行前明确该场景可能访问模型或网络
- **AND** 所有文件修改 MUST 限于 Gate 临时工作目录

#### Scenario: 普通检查未显式启用真实 Gate

- **WHEN** 运行 `npm run check`或普通测试命令
- **THEN** 流程 MUST NOT 启动本机 Pi、读取用户 Pi 配置或调用真实模型

### Requirement: 捕获 Prompt 接受、Agent Loop 和稳定终态

Probe MUST 在发送 Prompt 前建立请求和场景关联，并 MUST 分别记录 Prompt Preflight 接受、Agent Loop 启动和稳定终态。启动 Agent Loop 的场景只有在收到实际稳定收敛证据后才可完成；`agent_end`、`turn_end`或单条 Message End MUST NOT 单独视为最终终态。

#### Scenario: 普通流式 Agent Run

- **WHEN** Pi 接受 Prompt 并启动 Agent Loop
- **THEN** Probe MUST 捕获 Prompt Response、`agent_start`、流式 Message、`agent_end`和 `agent_settled`的实际顺序
- **AND** 只有 `agent_settled`与非 Streaming 状态一致后才可生成稳定 Gate 终态

#### Scenario: Interaction 早于 Prompt Response

- **WHEN** Extension 在 Prompt Preflight 中发出阻塞式 Interaction
- **THEN** Probe MUST 将该请求关联到预先建立的场景
- **AND** MUST 能在 Prompt Response 尚未到达时发送对应 Interaction Response

#### Scenario: 自动重试、Compaction 或队列续跑

- **WHEN** `agent_end`后 Pi 继续执行自动重试、Compaction、Steer 或 Follow-up 队列
- **THEN** Probe MUST 保持同一 Agent Run 未完成
- **AND** 最终 MUST 只从稳定收敛产生一个派生 Gate 终态

#### Scenario: Command 不启动 Agent Loop

- **WHEN** Gate Extension Command 成功处理输入但不触发 `agent_start`
- **THEN** Probe MUST 通过 Prompt Response、事件观察和状态回读明确判定无 Agent Loop 完成
- **AND** MUST NOT 为等待不存在的 `agent_settled`而永久挂起

### Requirement: 捕获 Tool 生命周期和可靠 Patch

Probe MUST 按原生 Tool Call ID 关联 Tool Start、Update 和 End，并 MUST 将 `partialResult`作为累计快照而非文本增量。Probe MUST 覆盖成功、失败、取消、交错和未知 Tool，并 MUST 将可靠原生 Patch 与通用 Tool 能力分开判定。

#### Scenario: Tool 产生累计更新

- **WHEN** 同一个 Tool Call 产生多个 `tool_execution_update`
- **THEN** Probe MUST 以每次最新的 `partialResult`替换此前快照
- **AND** MUST NOT 重复追加此前已包含的输出

#### Scenario: 多个 Tool Call 交错

- **WHEN** 两个或更多 Tool Call 的 Start、Update 和 End 交错到达
- **THEN** Probe MUST 使用原生 Call ID 独立关联每个生命周期
- **AND** 每个 Call MUST 得到成功、失败或取消结果

#### Scenario: 成功 Edit 返回 Patch

- **WHEN** Pi 在 Gate 合成文件上成功执行 Edit 并返回原生 Patch
- **THEN** Probe MUST 验证 Patch 是可应用到修改前内容的标准 Unified Patch
- **AND** Patch 结果 MUST 与 Tool 实际写入内容一致

#### Scenario: Tool 没有可靠 Patch

- **WHEN** Edit 失败，或 Write、Bash、自定义/未知 Tool 未提供可靠原生 Patch
- **THEN** Probe MUST 只记录 Tool 能力和结果
- **AND** MUST NOT 通过 Tool 参数、Git、文件监听或自行比较文件推断生产 File Change

### Requirement: 验证 Question 往返且不制造 Approval

Probe SHALL 通过显式 Gate Extension 使用官方 Extension UI 验证 `select`、`confirm`、`input`和 `editor`的阻塞式往返。每个 Interaction Response MUST 回到相同原生 Request；通用 UI 请求在没有明确原生 Permission/Approval 类型和 Action 语义时 MUST 归类为 Question，MUST NOT 推断为 Approval。

#### Scenario: 回答阻塞式 Question

- **WHEN** Gate Extension 发出带唯一 ID 的阻塞式 UI Request
- **THEN** Probe MUST 捕获其种类、结构和关联 ID
- **AND** 回答 MUST 只完成同一原生请求并使原操作继续

#### Scenario: 用户取消或 Question 超时

- **WHEN** Probe 对 Interaction 返回取消，或故意不响应直到原生超时
- **THEN** Gate MUST 捕获 Pi 对原操作的真实取消/超时结果
- **AND** Pending Interaction MUST 从 Probe 中收敛并关闭

#### Scenario: 重复或错误 Interaction Response

- **WHEN** Probe 发送重复 Response 或不存在的 Interaction ID
- **THEN** Gate MUST 记录 Pi 和客户端的实际处理结果
- **AND** MUST NOT 误完成另一个 Pending Interaction

#### Scenario: Confirm 文案表示权限

- **WHEN** Extension 使用 `confirm`询问是否允许危险操作，但 RPC Envelope 没有明确 Approval 语义
- **THEN** Capability Matrix MUST 将其记录为 Question
- **AND** MUST NOT 因文案、Tool 名称或布尔返回值声明 Approval Capability

#### Scenario: Pi 没有原生 Approval

- **WHEN**所有受测 RPC 场景都没有明确 Permission/Approval 类型和 Action
- **THEN**报告 MUST 将 Approval 记录为不存在或未观察到
- **AND**该结果 MUST NOT 单独导致 Gate C 失败

### Requirement: 验证取消后的真实停止和可继续性

Probe MUST 在实际 Streaming、Tool 执行和 Pending Interaction 场景中发送 Abort，并 MUST 使用事件、状态和后续行为证明取消已真正收敛。Abort Response 本身 MUST NOT 被视为 Agent 已停止的充分证据。

#### Scenario: 取消流式 Agent Run

- **WHEN** Probe 在 Assistant Streaming 期间发送 Abort
- **THEN** Probe MUST 捕获 Assistant/Agent 的实际取消顺序和稳定终态
- **AND** 状态回读 MUST 表明进程不再 Streaming

#### Scenario: 取消正在执行的 Tool 或 Question

- **WHEN** Abort 发生在 Tool 或阻塞式 Interaction Pending 期间
- **THEN** Tool 和 Interaction MUST 各自得到可解释的结束或取消结果
- **AND** MUST NOT 留下悬空回调或仍运行的 Gate 子进程

#### Scenario: 取消后继续下一 Turn

- **WHEN**前一个 Agent Run 已被证明取消并收敛
- **THEN**同一 Pi RPC Session MUST 能接受并完成一个新的普通 Prompt
- **AND**新 Prompt 的事件 MUST NOT 关联到已取消请求

#### Scenario: 空闲时重复 Abort

- **WHEN** Probe 在 Pi 已空闲时发送一次或多次 Abort
- **THEN** Probe MUST 记录幂等成功或明确原生错误
- **AND** Session MUST 保持可查询且不得伪造取消终态

### Requirement: 从 Native Session Tree 验证历史和稳定 Turn 身份

Probe SHALL 使用 Pi RPC 的 Session 状态、Entries、Tree 和 active leaf 验证 Native Session 身份、恢复和历史。Native Turn Ref 候选 MUST 在同一 Session 中唯一，MUST 在实时完成、关闭/恢复、重复读取和追加历史后保持稳定，并 MUST 不依赖消息正文或 Host ID。

#### Scenario: 创建并恢复 Native Session

- **WHEN** Probe 创建 Session、完成 Turn、关闭进程并按原生 locator 恢复
- **THEN** 恢复后的 Native Session 身份和 active branch MUST 对应原 Session
- **AND** 已完成 Turn 的 Entry ID 和顺序 MUST 保持不变

#### Scenario: 实时 Turn 对齐历史 Entry

- **WHEN** 一个成功或取消的 Agent Run 达到稳定终态
- **THEN** Probe MUST 通过完成后的 Entries/Tree 找到其稳定 Native Turn Ref 候选
- **AND** 重复读取 MUST 返回相同候选而不依赖 Message 文本匹配

#### Scenario: 失败 Agent Run 缺少确定性证据

- **WHEN** 当前 Gate 环境无法确定性构造并恢复失败 Agent Run
- **THEN** Probe MUST 将失败 Turn 的稳定 Native Turn Ref 标记为后续 Adapter 未决项
- **AND** MUST NOT 从成功或取消 Turn 的结果推断失败 Turn 已验证

#### Scenario: 原生客户端追加 Turn

- **WHEN** 同一 Pi 可执行程序在 RPC 关闭后通过原生客户端继续该 Session
- **THEN** 再次 RPC 恢复 MUST 读取新增 Turn
- **AND** 所有未改变的既有 Entry 和 Native Turn Ref 候选 MUST 保持不变

#### Scenario: Session 存在分支

- **WHEN**原生 Session Tree 包含非 active 分支
- **THEN**Probe MUST 使用 Tree 和 active leaf 确定当前可见历史
- **AND** MUST NOT 把 append 顺序中的废弃分支误投影为 active 对话

#### Scenario: 只读取 get_messages

- **WHEN** `get_messages`与完整 Entries/Tree 在 Compaction 或分支后表达不同内容
- **THEN**历史身份结论 MUST 以 Entries/Tree 为准
- **AND** `get_messages` MUST 只作为上下文对照而非完整历史事实源

### Requirement: 验证真实 Checkpoint 和精确 Fork

Probe MUST 只把实际能够创建独立 Native Session 的位置视为 Checkpoint。Gate MUST 验证从当前最后一个已完成 Turn 和至少一个非最后已完成 Turn Fork，派生 Session 必须精确包含目标 Turn 及其祖先且不包含之后的会话上下文。

#### Scenario: Fork 非最后已完成 Turn

- **WHEN**来源 Session 至少包含目标 Turn 和一个更晚 Turn
- **THEN**Probe MUST 通过官方 RPC 创建身份不同的派生 Native Session
- **AND**派生 active branch MUST 截止于目标 Turn且不包含更晚用户、Assistant 或 Tool 上下文

#### Scenario: Fork 当前最后已完成 Turn

- **WHEN**目标是来源 active branch 的最后已完成 Turn
- **THEN**Probe MUST 通过官方 Fork/Clone 能力创建独立 Session
- **AND**派生 Session MUST 包含目标完成上下文并可恢复继续

#### Scenario: 验证来源与派生 Session 隔离

- **WHEN**Fork/Clone 完成并向派生 Session 追加新 Turn
- **THEN**来源 Session 的 ID、文件和 Entry Tree MUST 保持不变
- **AND**派生 Session MUST 使用新的原生身份和持久化位置

#### Scenario: Turn 间存在 Model 或 Thinking 变化

- **WHEN**Checkpoint 附近存在 Model/Thinking Change Entry
- **THEN**Gate MUST 记录派生 Session 实际继承的状态和精确 Entry 截止位置
- **AND** MUST NOT 仅因消息上下文正确就忽略状态越界

#### Scenario: 官方 RPC 无法精确 Fork

- **WHEN**所有官方 `fork`、`clone`及其合法组合都无法从任意当前可见已完成 Turn 创建精确派生 Session
- **THEN**Gate C MUST 结论为 FAIL 或要求明确的产品/架构调整
- **AND**Probe MUST NOT 直接改写 Session 文件或通过 Gate Extension 隐藏该缺口

### Requirement: 验证当前 Session 的 Model、Thinking 和命令目录

Probe SHALL 从当前 Pi RPC Session 读取实际 Model、Thinking 和命令目录，并验证 Turn 间 Model 切换的实际生效状态。Probe MUST NOT 根据 Harness 版本推断目录，不得补造 RPC 未返回的内置 TUI 命令。

#### Scenario: 读取并切换两个实际可用 Model

- **WHEN** Native Mode 中存在至少两个已认证且可调用的 Model
- **THEN** Probe MUST 在 Agent Run 之间调用原生 Model 切换
- **AND**状态回读和切换后的 Turn MUST 证明目标 Model 实际生效

#### Scenario: 环境只有一个可用 Model

- **WHEN**当前 Native Mode 无法提供第二个可调用 Model
- **THEN**Model 切换场景 MUST 标记为 BLOCKED 并给出环境解除条件
- **AND** MUST NOT 按命令版本推断切换能力存在或不存在

#### Scenario: 读取命令目录

- **WHEN**当前 Session 加载 Extension Command、Prompt Template 或 Skill
- **THEN**Probe MUST 捕获 RPC 实际返回的命令种类和必要结构
- **AND**未返回的内置 TUI 命令 MUST NOT 被加入能力结果

#### Scenario: 资源被显式禁用

- **WHEN**隔离或 Native Live Profile 显式禁用 Prompt Template、Skill 或用户 Extension
- **THEN**Probe MUST 只记录 RPC 实际返回的受控命令目录
- **AND** MUST NOT 将缺失资源声明为已加载或已验证

#### Scenario: Catalog 包含本地敏感配置

- **WHEN** Model、状态或命令对象包含 base URL、价格、绝对路径、自定义配置或认证信息
- **THEN**原始值 MUST 保持在本地忽略证据中
- **AND**这些本机值 MUST 只进入本地忽略 Capture，仓库合成 Fixture MUST NOT 读取它们

### Requirement: 隔离真实 Gate 证据并只提交合成 Fixture

Gate SHALL 将真实 RPC Frame、Session、Prompt、模型文本、Tool 输出、路径、配置、能力矩阵和报告写入 Git 忽略目录。仓库只可接收由 Fake Pi 和固定合成数据生成的确定性 Fixture；开发阶段 MUST NOT 实现或依赖真实证据脱敏流程。

#### Scenario: 生成真实 Capture

- **WHEN**任一真实 Pi 场景保存协议、Session 或报告证据
- **THEN**证据 MUST 写入 `.codexhost/gate-c/`或其他专用 Git 忽略目录
- **AND** MUST NOT 由普通测试、Fixture 或报告命令复制到可提交路径

#### Scenario: 生成合成 Fixture

- **WHEN**显式 Fixture 命令从 Fake Pi 场景生成确定性证据
- **THEN** Fixture MUST 只包含固定合成 ID、路径、消息和 Tool 输出
- **AND** MUST NOT 读取本机 Pi、用户 Session、用户配置或真实模型响应

#### Scenario: 普通检查读取 Fixture

- **WHEN**普通检查验证 Gate Fixture
- **THEN**测试 MUST 只读取仓库内的 Fake Pi 合成 Fixture
- **AND** MUST NOT 访问 `.codexhost/gate-c/`中的真实证据

#### Scenario: 更新合成 Golden

- **WHEN**协议或 Gate 判定逻辑与已评审合成 Golden 不同
- **THEN**测试 MUST 失败并要求显式更新
- **AND** MUST NOT 在测试失败路径自动覆盖 Golden

### Requirement: 分层执行并明确判定 Gate C

工程 MUST 提供进入普通质量门禁的 Hermetic/Fixture 测试和独立显式运行的真实 Pi Gate。Gate 报告 MUST 对每个场景给出 `PASS`、`FAIL`或 `BLOCKED`，并 MUST 只在所有 MVP 必需 Pi RPC 行为均有真实通过证据时将总体结果标记为 `PASS`。权威报告 MUST 来自同一次显式 Gate 执行，MUST NOT 记录具体 Git 提交或自动拼接各 Profile 独立运行的最新目录。

#### Scenario: 所有必需能力成立

- **WHEN**真实 Pi 启动/关闭、Stream、Tool、Question、Cancel、History/Resume、稳定 Native Turn Ref、两个实际 Model 间切换和精确 Fork 均通过
- **THEN**Gate 报告 MUST 标记总体 `PASS`
- **AND**本地报告 MUST 指向本地真实 Capture 和仓库内的 Hermetic 自动化检查
- **AND**报告 MUST 说明 Agent Loop 由 Pi 执行

#### Scenario: 必需行为被证明不成立

- **WHEN**环境足以执行场景但任一必需 RPC 行为、终态、身份、Fork 或安全不变量确定失败
- **THEN**总体 Gate MUST 标记为 `FAIL`
- **AND**报告 MUST 记录失败阶段、证据、产品影响和下一决策

#### Scenario: 外部条件阻止判定

- **WHEN**命令不可执行、认证/网络不可用、缺少第二个实际 Model 或其他外部条件使必需场景无法完成
- **THEN**总体 Gate MUST 标记为 `BLOCKED`
- **AND**报告 MUST 分别列出已通过、失败和被阻塞场景及解除条件

#### Scenario: 可选能力不存在

- **WHEN**未观察到 Approval、Reasoning 或可靠 Edit Patch，但全部必需行为成立
- **THEN**Capability Matrix MUST 如实记录这些能力不存在或未观察到
- **AND**这些结果 MUST NOT 单独阻止总体 `PASS`

#### Scenario: Gate 不是 PASS

- **WHEN**总体结论为 `FAIL`或 `BLOCKED`
- **THEN**开发步骤和后续变更 MUST NOT 把 Pi RPC Gate C 标记为已验证
- **AND** MUST NOT 通过版本门禁、伪造能力、解析 TUI 或修改 Session 文件提升结论
