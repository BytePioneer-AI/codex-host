## Context

基线为 upstream main `fb70358c`。codexhost 通过 `@anthropic-ai/claude-agent-sdk` 驱动用户本机安装的 Claude Code（`resolveClaudeCodeExecutable`），不使用 SDK 自带的 CLI，所以行为取决于用户的 CLI 版本。

现有链路：Renderer 档位菜单 → Host `codexhost/thread/thinking/select` → Claude Adapter `setThinkingOption` → SDK Transport：
- 启动：`query({ thinking, effort, ... })`，`effort` 由档位决定（`auto`/`off` 不传）。Claude Code 在首条消息时才懒启动。
- 切换：`applyFlagSettings({ alwaysThinkingEnabled, effortLevel })`，Off 时只发 `alwaysThinkingEnabled: false`。
- 子智能体：只有主线程的 `Agent`、`Task`、`SendMessage` 工具调用会投影为子智能体委派项；后台子智能体按 `background-occupancy` 规则挂起回合；子线程通过官方 `getSubagentMessages()` 读取。
- 审批：Transport 只在有活动回合时接受 `canUseTool`，回合结束时关闭全部待处理请求。

原生事实（来源：SDK 各版本 `sdk.d.ts` 比对、本机 Claude Code 2.1.287 二进制，以及用用户账号做的实测，见 Verification）：
- `Settings.ultracode` 最早出现在 SDK 0.3.154（Claude Code 2.1.154）。2.1.154–2.1.283：Ultracode = xhigh + 持续的 dynamic workflow 编排；2.1.284 起与档位解耦，`ultracode: true/false` 只开关它，只发改变档位的 `effortLevel` 而不带 `ultracode` 键会关闭它。
- **`applyFlagSettings` 在 SDK 会话里不会因 Ultracode 不可用而失败**：不可用时请求照样成功，只是不生效；旧版本把 `ultracode` 当未知键合并。
- 原生 `get_settings` 控制请求返回 `applied.{effort, ultracode, ultracodeRequested, ultracodeAvailable}`。SDK 实现了 `Query.getSettings()`，但未写入公开类型。2.1.153 的读回没有 `ultracode` 字段；部分版本只有 `applied.ultracode`。
- Workflows 的开关：用户设置 `enableWorkflows`、环境变量 `CLAUDE_CODE_WORKFLOWS` 与 `CLAUDE_CODE_DISABLE_WORKFLOWS`、组织策略；Pro 套餐默认关闭。
- 关闭 Thinking（`alwaysThinkingEnabled: false`）或保持 xhigh 时，已请求的 Ultracode 不会自动清除，必须显式写 `ultracode: false`。
- Workflow 工具：输入为 `script`/`name`/`scriptPath` 等；先请求一次权限（`displayName: "Workflow"`，`description` 为脚本 `meta.description`），随后 `task_started`（`task_type: "local_workflow"`、`workflow_name`、`description`），工具结果为 `{ status: "async_launched", taskId, runId, transcriptDir, ... }`，运行在后台。
- `task_progress` 中未写入 SDK 类型的 `workflow_progress` 数组：`workflow_agent` 项含 `index`、`label`、`phaseTitle`、`agentType`、`model`、`state`（`start`/`progress`/`done`/`error`）、`agentId`、`startedAt`、`promptPreview`、`resultPreview`、`error` 等；排队时为不带 `agentId`、`startedAt` 的 `start`。只在变化时出现；智能体每次调用工具时另有不带 `workflow_progress` 的 `task_progress`。
- 智能体的消息不会转发到主消息流；其工具审批经 `canUseTool` 到达，带 `agentID`，可能在主回合结果之后。
- 结束时依次有 `task_updated`、`task_notification`（completed/failed/stopped），随后 Claude 在新的片段中汇总。主回合进行中 `interrupt()` 会连带停止 Workflow（`task_notification` 为 stopped）。
- 提示里含 "ultracode" 关键词时，即使未开启 Ultracode 也会触发 Workflow（先加载 `workflow-authoring` 技能）。
- 智能体转录写在 `<session>/subagents/workflows/<runId>/agent-<agentId>.jsonl`，首条为带 "[Workflow harness — computed task]" 外层包装、逐行缩进两格的任务文本。SDK 0.3.220 的 `getSubagentMessages()` 沿 `parentUuid` 回溯时跳过附件记录导致断链，只返回最后几条；0.3.289 能读到完整转录。

## Goals / Non-Goals

**Goals：** 在档位菜单中提供 Ultracode；新旧原生语义下行为一致；未生效时绝不静默降级，并告诉用户原因；Workflow 智能体像 Agent 子智能体一样可见、可点开、可审批；修正过时的主规格。

**Non-Goals：** 独立于档位的 Ultracode 开关；替用户打开 Workflows；Workflow 阶段映射到计划面板、运行日志、统计信息展示；单个 Workflow 智能体的停止、暂停、续跑；冷读取历史时还原 Workflow 卡片；改动共享契约、Host 或 Renderer。

## Decisions

### Ultracode

1. **Ultracode 作为档位选项。** 原生也把它放在 `/effort` 里；codexhost 的档位选择、保存、恢复与委派都以 `thinkingOptionId` 为单位，加一个选项即可复用，改动只在 Claude Adapter 内。
   备选：独立开关（可表达 "High + Ultracode"）。需要共享契约、Host、Renderer 各加一套状态，留待以后。

2. **Ultracode 固定为 `xhigh` + `ultracode`。** 旧语义本就强制 xhigh；固定后两种语义结果一致，档位标签与实际 effort 一致。

3. **以写入后的读回为准，失败即关闭。** 所有模型、所有版本都列出 Ultracode，不读 CLI 版本、不按模型隐藏。每次进入 Ultracode（启动、会话中切换、Ultracode 下换模型）都在写入后调用 `getSettings()`，只有 `applied.ultracode === true` 才算生效；方法不存在、调用失败、字段缺失或为 `false` 都按未生效处理。`getSettings` 没有公开类型，通过结构化访问调用，缺失时同样失败即关闭。
   备选一：以 `applyFlagSettings` 是否报错为准。实测不可用时不报错，会静默降级，不采用。备选二：解析 `--version` 判断旧版本。多一次进程启动，且仍无法覆盖 Workflows 关闭、模型不支持等情况；读回已能区分旧版本（无字段），不采用。

4. **按读回区分原因。** 读回无 `ultracode` 字段 → `unsupported`（需 2.1.154+）；`ultracodeAvailable === false` 且 Workflows 由设置或环境变量明确关闭 → `configurationRequired`（到 `/config` 打开 Dynamic workflows）；Workflows 明确打开 → `unsupported`（模型不支持）；无法判断 → `configurationRequired`，提示同时涵盖两个条件；读不到 → 可重试的 `nativeFailure`。Pro 用户默认会走"无法判断"分支，提示里包含打开 Workflows 的方法。

5. **只在需要时发送 `ultracode` 键。** 进入发 `{ alwaysThinkingEnabled: true, effortLevel: "xhigh", ultracode: true }`，离开在原载荷上追加 `ultracode: false`；两端都不是时载荷与现在完全相同、也不读回。这样从未选择 Ultracode 的用户（包括旧 CLI 用户）的行为不变，也满足 2.1.284 起的规则，并能清除关闭 Thinking 时残留的请求。

6. **发送消息前确认，未生效则中止该消息。** 懒启动时以 `effort: "xhigh"` 启动，`initializationResult()` 后写入并读回，确认后才写入用户消息。未生效时 Transport 关闭这次启动的进程，`startTurn` 返回带原因的错误（与"未安装"同样在回合被接受前失败，不产生回合事件），保存的档位仍为 Ultracode，用户改档位或打开 Workflows 后重发即可。恢复、Fork、回滚、编辑重发、委派都经同一启动路径。
   备选：降级为 xhigh 继续执行。会让用户以为在用 Ultracode，不采用。

7. **会话中切换与换模型未生效时恢复原状。** 切换：恢复原档位载荷（含 `ultracode: false`），返回原因，不发布新档位。换模型：`setModel` 后重新写入 Ultracode 并读回，未生效则改回原模型并重新写入 Ultracode，返回原因，不发布新模型。恢复后同样读回确认：切换的恢复确认 Ultracode 已关闭，换模型的恢复确认 Ultracode 重新生效。恢复本身失败或读回不符时原生状态未知，Transport 通过 `onFault` 让会话进入故障态。

### Workflow 子智能体

8. **一次 Workflow 运行 = 一个委派项，由独立的生命周期管理。** 新增 `ClaudeWorkflowLifecycle`（`workflow-lifecycle.ts`），不复用只支持单个子智能体的 `ClaudeSubagentLifecycle`。主线程 `Workflow` 工具调用登记一次运行；第一条原生任务帧（`task_started`）到达时以其描述为说明开启委派项（委派项的说明在开启后无法修改，而工具调用时只有脚本，不解析脚本）；工具结果报错或未在后台启动时据结果结束该项。

9. **按 `index` 维护智能体。** `subagentId` 固定为"Workflow 调用 ID:序号"，排队阶段也有稳定身份；拿到 `agentId` 后写入 `nativeSubagentId`，Host 据此注册可点开的子线程。描述为标签，`role` 为 `agentType`、缺省为阶段标题，`model` 为原生模型 ID。状态：无 `agentId`/`startedAt` 的 `start` → 排队，`start`/`progress` → 运行，`done` → 完成（摘要为 `resultPreview`），`error` → 失败（摘要为 `error`）。未知状态与畸形项忽略，单帧最多读取 500 项，字符串均有界。每次有变化时用 `subagents.replace` 更新整张卡片。

10. **刷新子线程。** 某个智能体状态变化时为它发出 `subagent.transcript.changed`；不带 `workflow_progress` 的 `task_progress`（智能体调用了工具）无法对应到具体智能体，为该运行中所有运行中的智能体发出；运行结束时为全部智能体发出一次。Host 只刷新已打开的子线程。

11. **跨片段识别运行。** 主回合结束后的进度帧由新的累积器处理，它不知道之前的工具调用。带 `workflow_progress` 或 `task_type: "local_workflow"` 的任务帧自带身份；不认识的调用 ID 的 `task_progress` 报为 `workflow.activity`，由 Adapter 按调用 ID 匹配，不认识则忽略。

12. **回合占用与取消。** 工具结果为后台启动时，以"调用 ID + 任务 ID"占用回合，委派项保持打开；主回合结果到达时回合挂起，不结束 Workflow 项；`task_notification` 结束委派项（未完成的智能体按结果标为完成、失败或中断，从未开始的标为中断）并记为待汇总，Claude 汇总结束后回合完成。取消见第 15 条。
    备选：不占用回合，Workflow 结束后以自主回合汇总。回合结束后无法继续更新卡片，也无法作答智能体审批，不采用。

13. **智能体审批跨越主回合结果。** Transport 的待处理审批改为会话级，按来源分为主线程与智能体（`agentID`）两类：主线程片段结束时只关闭主线程的请求；挂起期间的请求（包括挂起中续写片段的主线程请求）经空闲处理器发给 Adapter；挂起结束（`setIdleLive(false)`）、Transport 关闭或没有可显示的回合时拒绝智能体请求。Adapter 在挂起时保留智能体请求对应的 Host 交互，回合真正结束时一并关闭。审批标题前加该智能体的标签（来自最近的进度帧），便于区分多个智能体的同名工具请求。
    这也修正了现有行为：挂起回合中续写片段的工具审批此前会被直接拒绝。

14. **Workflow 审批显示原生描述。** 现有审批映射已使用原生 `displayName` 与 `description`，后者即脚本的 `meta.description`；不在审批中显示脚本。阶段标题只在脚本中，不解析。

15. **取消会停止本回合的后台工作。** 回合拥有仍在运行的后台子智能体或 Workflow 时，取消除了中断正在进行的主回复，还对这些任务逐个调用原生 `stopTask`，并等到 Claude Code 报告每个任务已停止（后台任务集合不再包含它）才结束回合。实测停止请求约 20 毫秒返回，随即收到 `stopped` 通知；停止普通 Agent 后 Claude Code 会自动开始一段新的回复来回应停止通知，所以回合在停止确认后还要保持一个续写静默窗口，期间开始的回复片段会被中断，不会变成自主回合。停止或中断在取消时限内得不到确认时，关闭 Claude Code 进程（进程关闭会结束它运行的所有任务），下一个回合恢复原生会话。主回复的结果未能证明已被中断时，仍按现有规则判为失败。回合没有后台工作时，取消行为不变。
    这同时修正了改动前的行为：挂起期间取消只把后台子智能体标为中断，原生任务仍在运行，之后 Claude 还会以自主回合继续回复。

15. **子线程首条提示去掉外层包装。** 识别到 "[Workflow harness — computed task]" 包装且正文逐行缩进时，显示去缩进后的任务原文；否则原样显示。

16. **升级 SDK 到 0.3.289。** 只为修复转录断链；codexhost 仍使用用户安装的 CLI。升级后类型检查与全部现有测试无需修改。

## Risks / Trade-offs

- **`get_settings` 与 `workflow_progress` 都是未公开接口，CLI 升级可能变化** → 读回失败即关闭并给出可操作的提示；进度项严格校验、未知内容忽略；文档注明已验证的 CLI 版本。
- **SDK 升级跨度较大（0.3.220 → 0.3.289）** → 类型检查与全部现有测试通过；实机验证覆盖文本回合、Ultracode、Workflow 与子线程读取；如维护者希望单独升级，可把依赖提交拆成独立 PR。
- **长时间的 Workflow 会让回合持续占用** → 与 Claude Code 自身"等 Workflow 结束再汇总"一致；用户可随时取消，取消会停止 Workflow。
- **单张卡片可能有很多智能体** → 单帧上限 500 项且顺序稳定；Codex 卡片只显示状态与摘要，不显示阶段分组与用量。
- **"无法判断原因"时提示较长** → 优先用设置与环境变量判断；Pro 用户的默认情况会得到打开 Workflows 的明确指引。
- **冷读取历史时 Workflow 显示为普通工具项** → 与现有 Agent 子智能体一致；运行时创建的子线程记录仍可打开。
- **Ultracode 消耗额度明显增加** → 文档说明；不替用户默认开启，也不替用户打开 Workflows。

## Verification

- 单元测试：档位与载荷（各方向切换）；读回判定与错误映射；启动前确认成功/失败（失败时不写入消息、进程关闭）；会话中切换与换模型的恢复及恢复后读回、恢复失败或读回不符时故障；Workflow 工具、任务帧、进度各状态、跨片段识别；委派项开启、更新、后台启动、结束、取消、未启动；智能体审批跨越主回合结果、挂起中续写片段的审批、挂起结束时拒绝；Adapter 级的挂起、刷新、作答、汇总后完成；取消时停止并确认后台任务、拦截停止后的自动回复、停止未确认时关闭进程、未证实的中断仍判失败；普通 Agent 审批在前台、挂起、取消、断连与迟到回复下的处理；子线程首条提示去包装。
- 实机（用户同意使用其 Claude 账号；Linux x64，Claude Code 2.1.287，SDK 0.3.289；结果见 tasks 第 1 节）。
- Desktop：由用户确认档位菜单、失败提示、Workflow 卡片与子线程、审批、取消，并提供截图。
