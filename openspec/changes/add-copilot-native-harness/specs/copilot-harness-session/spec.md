# Spec Delta

## Purpose

定义 GitHub Copilot 作为独立 Harness 在 codexhost 中的可观察行为，涵盖目标 Host 上的原生认证、持续可写会话、双向交互、历史恢复和产品接入。用户通过公共 Thread 操作使用 Copilot，并保留其原生能力、权限语义和会话归属。

## ADDED Requirements

### Requirement: Copilot is an independent discoverable Harness

系统 SHALL 将 Copilot 作为 `copilot` Harness 通过公共插件目录提供；其 Thread SHALL 保持固定归属。插件缺失、不可用或请求失败 SHALL 返回明确状态，不得将请求交给官方 Codex 或其他 Harness。

#### Scenario: Copilot is enabled

- **WHEN** 目标 Host 启用有效的 Copilot 插件
- **THEN** Desktop SHALL 展示其名称、图标、连接说明及实际可用性
- **AND** 新 Thread SHALL 通过共享路由归属于 Copilot

#### Scenario: A persisted Thread loses its plugin

- **WHEN** 用户打开已有 Copilot Thread 而目标 Host 缺少插件
- **THEN** 系统 SHALL 报告所属 Harness 不可用并保留映射和原生身份
- **AND** 重新启用兼容插件后 SHALL 可以按原生恢复能力继续该 Thread

### Requirement: Authentication reuses the target Host's native context

Copilot SHALL 使用目标 Host 的原生认证上下文，在相同 OS 用户、配置位置和凭据库可访问时复用已有 Copilot 登录，并遵循原生显式环境认证的优先级。系统 MUST NOT 复制凭据、暗中切换用户配置位置或在检查时启动登录流程；诊断与持久引用 MUST NOT 包含凭据。

#### Scenario: Stored native login is available

- **WHEN** 用户已在目标 Host 登录 Copilot，凭据库可访问且不存在更高优先级的认证覆盖
- **THEN** Copilot SHALL 使用该原生登录，无需在 codexhost 再次输入 Token

#### Scenario: Explicit environment authentication takes precedence

- **WHEN** 目标执行环境包含有效且优先于存储登录的原生认证配置
- **THEN** Copilot SHALL 遵循原生优先级
- **AND** 系统 SHALL NOT 将此次执行描述为必然使用最近一次交互登录的账号

#### Scenario: Remote credentials are unavailable

- **WHEN** 远程 Host 或其他 OS 用户无法访问本机登录，且没有其他可用原生认证
- **THEN** 系统 SHALL 返回认证不可用的明确状态及原生登录指引
- **AND** SHALL NOT 将本机凭据复制到该环境或自动发起登录

### Requirement: Inspection is side-effect-free and scoped

Copilot 检查 SHALL 尊重目标 Host、工作目录与刷新请求，返回真实的可用性、Model、Thinking、权限目录和能力。检查 SHALL NOT 创建用户会话或提交用户内容；临时资源 SHALL 在检查后释放。原生尚未确认的有效配置 SHALL 保持未知；目录中的初始推荐选择 SHALL 与原生有效配置区分。

#### Scenario: Installation and authentication failures differ

- **WHEN** CLI 缺失、认证缺失或原生协议不兼容
- **THEN** 检查 SHALL 分别报告对应的类型化原因
- **AND** SHALL NOT 静默改用另一套运行时或模型

#### Scenario: Catalog refresh follows context

- **WHEN** 用户刷新检查或切换到不同的工作目录或 Host
- **THEN** 检查 SHALL 重新读取对应范围的原生信息
- **AND** 轻量可用性结果 SHALL NOT 替代完整目录结果

### Requirement: Draft preparation and recovery preserve native ownership

Copilot SHALL 支持轻量草稿准备、顺序多轮执行及同一原生身份的冷恢复。首次用户 Turn 前 SHALL NOT 留下需要用户清理的原生空会话。所有支持的打开路径 SHALL 将本次 Thread 环境覆盖传递到真正执行工具的环境；恢复 SHALL 保留原生权威配置和历史。

#### Scenario: A prepared draft is discarded

- **WHEN** 创建草稿后未发送消息即关闭
- **THEN** 系统 SHALL 释放资源，原生侧 SHALL 没有需要用户清理的残留会话

#### Scenario: First message establishes durable identity

- **WHEN** 草稿首次接受用户输入并形成原生历史
- **THEN** 系统 SHALL 发布对应的持久原生身份，并将后续 Turn 写入同一会话

#### Scenario: Idle release or Host restart is followed by another message

- **WHEN** 已持久化的 Copilot Thread 在空闲释放或 Host 重启后接收消息
- **THEN** 系统 SHALL 恢复同一原生会话，读取完整历史，并执行新的 Turn
- **AND** SHALL NOT 把旧历史重新作为实时输出或新用户输入发送

#### Scenario: Resume cannot find its native session

- **WHEN** 所引用的原生会话缺失或身份不属于 Copilot
- **THEN** 系统 SHALL 返回类型化错误并保留源映射
- **AND** SHALL NOT 创建替代空会话伪装恢复成功

### Requirement: Turns preserve the full native execution lifecycle

Copilot SHALL 将一次已接受的用户输入及其原生执行映射为一个有序 Host Turn，保留流式文本、公开 Reasoning、工具、命令、可靠文件修改和压缩事实。每个接受的 Turn SHALL 有且只有一个终态；请求受理、内部推理循环结束或文本停止 SHALL NOT 单独被视为整个 Turn 完成。

#### Scenario: A response contains multiple tool loops

- **WHEN** 原生执行多次模型请求和工具调用后完成用户任务
- **THEN** 系统 SHALL 在同一个用户 Turn 中按顺序呈现实际内容
- **AND** 流式累积内容与最终内容 SHALL 一致，普通 Item 与交互终结后才发布 Turn 终态

#### Scenario: File output lacks a reliable diff

- **WHEN** 原生只提供工具结果或文件路径，不能证明实际修改内容
- **THEN** 系统 SHALL 保留真实工具内容并省略不可证明的文件 Diff

#### Scenario: Another start arrives while busy

- **WHEN** 同一 Session 的前一 Turn 尚未终结时收到第二个开始请求
- **THEN** 系统 SHALL 返回可重试的忙碌错误，不排队、并发或抢占
- **AND** 被拒绝的请求 SHALL 不产生 Turn 生命周期事件

### Requirement: Cancellation and shutdown settle work honestly

Copilot SHALL 仅取消匹配的活动 Turn，等待可确认的原生终态后允许续跑，并隔离迟到输出。不可恢复故障或关闭 SHALL 终结所有已接受的生命周期并释放等待。关闭 SHALL 在 60 秒内结束公共输出且保留历史，失败后再次关闭 SHALL 重试未完成的资源回收。

#### Scenario: Cancellation is acknowledged before work stops

- **WHEN** 原生受理取消但工具或交互尚未终结
- **THEN** 系统 SHALL 保持该 Turn 未终结，直至获得确认或报告明确故障
- **AND** SHALL NOT 提前报告成功取消

#### Scenario: A cancelled session continues

- **WHEN** 文本生成、工具执行或交互等待中的 Turn 已确认取消
- **THEN** 同一 Thread SHALL 能接受下一条消息
- **AND** 旧 Turn 的事件 SHALL NOT 更新新 Turn

#### Scenario: Native process exits unexpectedly

- **WHEN** 活动执行期间原生进程意外退出
- **THEN** 系统 SHALL 关闭交互、终结活动内容和 Turn，报告脱敏故障并释放资源
- **AND** 后续操作 SHALL 通过同一原生身份恢复或返回明确恢复错误

### Requirement: Native approvals and questions remain bidirectional

Copilot SHALL 将原生审批和提问映射为公共 Interaction，保留授权范围和有效答案约束。响应 SHALL 只作用于对应的活动交互；非法、重复或迟到响应 SHALL 被拒绝。取消、超时、故障或关闭 SHALL 解除原生等待并且每个 Interaction 只关闭一次。

#### Scenario: An approval allows only one action

- **WHEN** 原生请求只允许单次授权
- **THEN** Desktop SHALL 只提供能准确映射到原生的动作
- **AND** SHALL NOT 将该选择升级为 Session 或永久授权

#### Scenario: A question is answered or cancelled

- **WHEN** 用户提交有效选择、自由文本或取消提问
- **THEN** 系统 SHALL 按原生问题约束转交一次对应回答或取消
- **AND** SHALL NOT 通过普通消息模拟响应或自动替用户回答

#### Scenario: Response races with shutdown

- **WHEN** 用户回答与 Turn 取消或 Session 关闭同时发生
- **THEN** 只有一次响应或取消 SHALL 生效，等待 SHALL 被释放
- **AND** 答案 SHALL NOT 进入后续交互

### Requirement: Configuration reflects confirmed native state

Copilot SHALL 接入已验证的原生 Model、Thinking 和 Permission Mode 控制，公开实际选项、生效范围及完整确认状态。省略配置 SHALL 保持原生默认选择；请求值 MUST NOT 冒充已生效值。工作模式 SHALL NOT 被误映射为 Permission Mode。

#### Scenario: A new Thread receives an initial model selection

- **WHEN** Copilot 返回非空可用模型目录且用户没有有效的已有选择
- **THEN** Desktop SHALL 使用 Adapter 公布的初始模型，优先 Auto，否则使用目录中的第一个可用模型
- **AND** 唯一可选项为 Auto 时 SHALL 直接预选 Auto，用户无需额外点选即可发送
- **AND** 初始选择 SHALL NOT 冒充原生已生效状态或改写用户的 CLI 默认配置

#### Scenario: A model change alters thinking options

- **WHEN** 原生接受新的 Model 并报告新的 Thinking 选项
- **THEN** 系统 SHALL 一并更新已确认 Model、Thinking 和可用选项
- **AND** SHALL NOT 沿用旧模型的无效选项

#### Scenario: A configuration change occurs during execution

- **WHEN** 用户在活动 Turn 中请求原生支持的 Model 或 Thinking 切换
- **THEN** 系统 SHALL 按原生确认的生效语义处理，不能仅因 Turn 活动而拒绝

#### Scenario: Draft configuration is not yet confirmed

- **WHEN** 原生尚未确认草稿请求的配置
- **THEN** 系统 SHALL 保留“请求”与“已生效”的区别
- **AND** SHALL NOT 报告切换已完成或为确认配置留下需要用户清理的空会话

#### Scenario: Native configuration is rejected

- **WHEN** 原生因权限、模型资格或无效选项拒绝配置
- **THEN** 系统 SHALL 返回明确错误，保留最后确认的状态且不因单次拒绝自动破坏 Session

### Requirement: Unattended intent is enforced or rejected

Copilot SHALL 对无人值守全权限执行意图给出明确结果：只有原生权限、执行限制与交互策略被验证等价时才能接受，否则在产生会话执行副作用前返回类型化拒绝。系统 MUST NOT 静默忽略意图、统一批准所有回调或自动回答问题。

#### Scenario: Explicit permission conflicts with unattended intent

- **WHEN** 调用方同时指定了与无人值守意图冲突的 Permission Mode
- **THEN** 创建 SHALL 被明确拒绝

#### Scenario: Native policy cannot guarantee unattended execution

- **WHEN** 目标版本不能确认所需执行策略
- **THEN** 系统 SHALL 返回不支持或配置错误，并报告委派限制
- **AND** SHALL NOT 开始执行后再隐式等待无人处理的交互

### Requirement: Read-only history has stable evidence-based identity

Copilot SHALL 提供完整的只读会话快照，具有稳定的逻辑 Turn 身份、Item 身份及当前确认配置；实时终态与历史身份 SHALL 一致。历史读取 SHALL NOT 触发模型执行或修改会话。缺少可靠持久终态时 SHALL 使用未知结果；分页失效 SHALL NOT 被当作完整空历史。

#### Scenario: Repeated reads and appended history preserve identity

- **WHEN** 未变更历史被重复读取，或只追加新的 Turn
- **THEN** 既有逻辑 Turn 和 Item 的身份及顺序 SHALL 保持稳定
- **AND** 读取 SHALL 不向实时输出流重新发布历史

#### Scenario: Compaction or hidden native records appear

- **WHEN** 历史包含压缩、隐藏注入或子 Agent 消息
- **THEN** 系统 SHALL 按原生可见逻辑投影，避免将它们误识别成根用户 Turn
- **AND** 缺失信息 SHALL 被如实表达，不能伪造完整性或成功终态

#### Scenario: A persisted-history cursor expires

- **WHEN** 分页过程中原生日志代际或读取边界失效
- **THEN** 系统 SHALL 从可靠边界有界重读或返回明确错误
- **AND** SHALL NOT 用部分结果覆盖已知完整历史

### Requirement: Native derivation preserves exact conversation boundaries

Copilot 原生支持精确派生时，系统 SHALL 提供同目录 Fork 和回滚最后一个完整逻辑 Turn。派生 SHALL 获得不同原生身份，保留精确前缀并可独立续写；回滚 SHALL 保留当前有效配置。派生失败 MUST NOT 修改源会话；所有操作 SHALL 保留项目当前文件状态。

#### Scenario: A middle or terminal checkpoint is forked

- **WHEN** 用户从有效的中间或末尾 Checkpoint 创建 Fork
- **THEN** 新会话 SHALL 包含所选 Turn 及其祖先，不包含其后 Turn
- **AND** 继续对话 SHALL 只写入派生会话

#### Scenario: The last logical turn has multiple internal loops

- **WHEN** 用户回滚包含多个工具和推理循环的最后一轮
- **THEN** 派生会话 SHALL 移除整个逻辑 Turn 而非只移除最后一条助手消息
- **AND** 源会话及工作区文件 SHALL 保持原状

#### Scenario: A single-turn history is rolled back

- **WHEN** 只有一轮的会话执行回滚
- **THEN** 系统 SHALL 返回可继续执行的空前缀派生会话并保留当前配置

#### Scenario: A derivation cannot be performed exactly

- **WHEN** Checkpoint 无效、源正忙或目标版本缺少可保证精确性的原生能力
- **THEN** 系统 SHALL 返回对应的类型化错误，且不改动源会话或文件
- **AND** SHALL NOT 用可见消息重放模拟 Fork 或成功回滚

### Requirement: Autonomous output and background activity retain ownership

Copilot SHALL 对可完整观测的原生自主执行提供独立、有序的 Turn，避免混入用户 Turn 或丢弃后台结果。原生后台活动 SHALL 保持正确归属并阻止不安全的空闲释放。无法安全投影的原生模式 SHALL 明确报告限制，并在启用或恢复该模式前拒绝不安全执行。

#### Scenario: An autonomous continuation follows a user turn

- **WHEN** 原生在未收到新的用户请求时开始可观测的自主执行
- **THEN** 系统 SHALL 建立相应自主 Turn，保留可见输入和唯一终态
- **AND** SHALL NOT 向已终结的用户 Turn 追加普通 Item

#### Scenario: Background work outlives a foreground response

- **WHEN** 前台回答结束但原生仍有工具或子任务运行
- **THEN** 系统 SHALL 保留其真实状态和归属，避免错误判定可释放
- **AND** SHALL NOT 因完整 Subagent Transcript 尚未提供而忽略后台活动

### Requirement: Session usage reports only native facts

Copilot SHALL 将原生可靠会话用量映射为公共完整快照，区分上下文占用、累计用量与费用单位，未知值保持为空或省略。会话花费 SHALL NOT 被当作账号剩余额度，美元与 credits SHALL NOT 混用。

#### Scenario: Usage updates or is restored

- **WHEN** 活动会话或恢复后的原生历史提供可靠用量
- **THEN** 系统 SHALL 发布对应快照，保持原生单位且避免重复累计
- **AND** 没有可靠依据的字段 SHALL 不显示推算值

### Requirement: Copilot accepts delegation as a persistent ordinary Thread

Copilot SHALL 通过公共委派路径接受实际支持的配置与执行意图，并提供发送、只读观察、取消及重启后续跑。工具环境 SHALL 使用本次 Thread 提供的目标 Host 信息。人工交互 SHALL 通过既有 Desktop 入口处理；接收委派 SHALL NOT 被描述成已支持向下委派。

#### Scenario: A delegated task continues after cancellation or restart

- **WHEN** 委派任务完成或取消后再次发送，或 Host 重启后恢复
- **THEN** 系统 SHALL 在同一原生会话中继续，并提供一致的历史和进度

#### Scenario: Delegation needs human input

- **WHEN** 允许人工交互的委派执行出现原生审批或提问
- **THEN** 系统 SHALL 保持交互可见，并通过既有 Thread 链接供用户处理
- **AND** SHALL NOT 为使任务自行结束而伪造回答

### Requirement: Distribution and capability claims match verified behavior

Copilot SHALL 提供可独立加载的插件、手动安装与登录指引、针对实际 CLI 的版本检查和显式更新。声明的能力 SHALL 与已验证的目标版本一致；P0 与 P1 交付条件 SHALL 完成后才宣布普通 Thread 与 Desktop 接入完成，无法提供的条件能力 SHALL 明确拒绝并记录原生依据。

#### Scenario: Installation is managed through Desktop

- **WHEN** 用户检查或显式更新 Copilot
- **THEN** 系统 SHALL 针对实际发现的安装报告版本并执行受支持的更新方式
- **AND** 不可自动管理的渠道 SHALL 提供手动指引，不更新另一套安装或中断既有会话

#### Scenario: A packaged plugin is moved outside the workspace

- **WHEN** 发行插件通过真实 Loader 在隔离目录加载
- **THEN** 插件 SHALL 具备完整依赖和资源，并区分原生 CLI 未安装与插件损坏

#### Scenario: Desktop switches Host or Thread

- **WHEN** 用户切换 Host、Thread 或重新挂载输入界面
- **THEN** Copilot 的图标、目录、配置、交互和历史 SHALL 对应当前目标
- **AND** 异步旧结果 SHALL NOT 覆盖当前 Thread 的状态


### Requirement: Native account allowance and AI Credits preserve their units

Copilot SHALL 通过原生 SDK 提供当前认证的账号额度及可确认的会话 AI Credits。账号查询 SHALL NOT 发起模型 Turn；仅为获得权威单位创建的临时草稿 SHALL 在查询后清理。账号缓存 SHALL 有限期、在刷新或认证变化时失效，未知值 SHALL NOT 显示为零。

#### Scenario: Native quota reports an authoritative budget

- **WHEN** 原生返回具有明确单位的账号预算及剩余百分比
- **THEN** 系统 SHALL 保留原生已用、限额、剩余百分比和可用的重置时间
- **AND** SHALL NOT 将 advisory balance、无限额度或会话花费当成有限账号预算

#### Scenario: Native session reports AI credit cost

- **WHEN** 原生返回可靠的累计 nano-AIU
- **THEN** 系统 SHALL 按原生单位换算为累计 AI Credits，并在重复刷新或恢复时替换快照
- **AND** 部分、不可用或缺失金额 SHALL NOT 被报告为完整花费或零花费


### Requirement: Native performance measurements preserve their timing scope

Copilot SHALL 在可可靠关联原生模型请求时提供当前或最近逻辑 Turn 的生成速度和 API 平均速度，并提供原生口径的最近及累计缓存命中事实。生成速度 SHALL 排除首字等待与工具执行时间，API 平均速度 SHALL 保留原生 API 的首字等待。

#### Scenario: A Turn contains several model requests

- **WHEN** 同一逻辑 Turn 的多个模型请求提供可靠输出 Token、API 耗时和首个输出耗时
- **THEN** 生成速度 SHALL 使用这些请求的总输出 Token 除以总生成耗时
- **AND** 已含推理的输出 Token SHALL NOT 再加推理 Token，重复事件与其他 Turn/子 Agent 的事件 SHALL NOT 重复计入

#### Scenario: Timing is unavailable after recovery

- **WHEN** 原生历史不包含可靠计时或某次请求缺少必要字段
- **THEN** 系统 SHALL 不伪造生成速度；同一连接保留最近有效值，冷恢复等待新的实时计时
- **AND** 累计缓存数据可以独立从原生快照恢复
