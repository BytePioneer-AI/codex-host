# Claude Code 后台命令原生展示

Claude Code 的后台 Bash 任务（`run_in_background` 或原生后台化，`task_type: "local_bash"`）在 Codex Desktop 原生子任务列表中显示为只读节点，打开后以原生 Shell 组件显示命令、输出和结果。Desktop 自行渲染，codexhost 不新增 Renderer UI，也不启动替代任务或额外的模型 Session。首版不提供单任务停止按钮，也不实时尾随输出；打开详情和结束时读取最新输出。

## 用户可见行为

- 标题为 `Background command · <原生描述>`，`agentRole` 为 `background-command`；运行中在 Active，结束后进入 Done。
- 后台命令运行时父 Turn 可以结束，父对话可以继续发送；父 Thread 在 Turn 之外保持 active，直到没有运行中的原生子节点。
- 详情只读，拒绝直接输入。命令只取自原生 Bash 工具输入；取不到时命令为空，不用描述冒充。退出码不解析，原生结束摘要（如 `... completed (exit code 0)`）作为原文显示在详情顶部。
- 结果未知时详情写明 `Result unknown`，退出码为空，原生 Footer 显示 Exit code unknown。输出文件读不到（已清理或路径未观测到）时，详情明确写出 `Native output is unavailable.`，不显示替代内容。
- 真正的子 Agent（`local_agent`）继续走原有 Subagent 链路，不重复显示。

## 状态语义

`HostBackgroundTask.status` 为 `running | completed | failed | stopped | unknown`：

- `background_tasks_changed` 是完整活跃集合，整体替换。离开集合但未观测到原生结果时为 `unknown`，不是成功；之后的完整集合再次列出该任务时恢复 running，而迟到的 `task_started` 边沿不会恢复。
- `task_updated`（`completed/failed/killed`）和 `task_notification`（`completed/failed/stopped`）提供原生结果；原生结果可替换 `unknown`，但不回退为 running，也不被另一种结果改写。实测 CLI 2.1.273 的顺序是空集合先于 `task_updated`，后者不带 `tool_use_id`。
- CLI 进程关闭、替换或故障时，该进程报告的运行中任务变为 `unknown`。Host 重启后不恢复运行状态，节点显示为未加载。

## 所有权

- `packages/adapters/claude-code/src/background-commands.ts` 独占原生解释：在 SDK Transport 的原始消息入口（每个 CLI 进程一份）处理活跃集合、任务事件、Bash `tool_use` 与 `tool_result`。运行中的输出路径只在 `tool_result` 文本中（`tool_use_result` 仅有 `backgroundTaskId`），终态路径来自 `task_notification.output_file`。
- 同一形状的任务通知也会被既有 Subagent 解析识别；Transport 对本进程已识别为后台命令的任务丢弃其 `subagent.settled`，真正的 Agent 与未知类型任务不受影响。
- Transport 通过 Thread 事件通道直接交给 Session，不进入 Turn 批次；Session 发出公共 `backgroundTask.changed`，并保存本 Session 的观测事实供详情读取。
- 详情由 `ClaudeCodeAdapter.backgroundTasks.readSnapshot` 提供：优先使用活 Session 的事实；没有时从原生 transcript 取 Bash 命令、输出路径和已送达的通知；通知只认 `origin.kind: "task-notification"` 的原生 envelope，且 `tool-use-id` 必须是已观测的 Bash 调用，普通用户文本不影响状态或路径。输出文件只在 Adapter 读取，按工具输出上限读取末尾。
- 公共契约（`@codexhost/harness-adapter`）区分后台任务与子 Agent：任务 ID 不进入 `nativeSubagentId`，也不交给 Subagent transcript 读取。历史 Item 结果可为 `running`/`unknown`，投影为 `inProgress`/`completed`，不附带退出码。
- Host 复用只读子节点（列表、`thread/started`、状态通知、拒绝输入、运行中子节点计数）。MappingStore 子节点记录用 `nativeBackgroundTaskId`（与 `nativeSubagentId` 二选一），只存定位元数据，不存输出。运行中的后台命令计入父 Thread 的运行中子节点，因此空闲释放显示 `busy/background`，不会释放正在运行任务的 Session。

## 验证

定向测试覆盖原生证据顺序、Agent 去重、无 `tool_use_id`、乱序与重复、`unknown` 后的原生结果、transcript 恢复、输出文件丢失、无 Turn 时的 Host 投影、只读详情和拒绝输入、父对话继续、单 Session、空闲释放占用以及 Host 重启不误报运行。真实 Desktop 端到端验证需在加载本改动的运行制品上单独进行。
