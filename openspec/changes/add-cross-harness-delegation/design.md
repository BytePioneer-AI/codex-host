## Context

Host Runtime 已经具备实现跨 Harness 委派所需的几乎全部零件，本变更主要是接线而非造管线：

- `app-server-host.ts` 的 Subagent 子 Thread 物化路径已经在做**无请求上下文的主动推送**：`createProvisional` → `commitNative` → `externalThreadValue` → `writer.json({ method: "thread/started" })`。委派子 Thread 与它的差异只有四处：Native Session 是目标 Harness 自己的、`harnessId` 是目标 Harness、关系字段是 Delegation 而非 Subagent、且子 Thread 可写。
- `mapping-store` 已有 Create Request ID 幂等机制。
- `harness-subagent-session` 已有后台工作与自主 Turn 契约，但跨 Harness 委派首版不复用主动唤醒链路，只提供显式读取与等待。
- `thread-list-aggregator` / `external-thread-list` 已有 cwd、limit、cursor、排序、归档等过滤能力。
- 适配器拉起 Harness 进程时 `env` 完全可控（例如 `sdk-transport.ts` 的 `withNodeRuntimeOnPath`）。
- `official-request-broker.ts` 已经提供「Host 向官方 App Server 发带外请求」的机制：内部前缀 ID 的响应在 `app-server-host.ts` 的官方输出循环中被拦截消费而不回送 Desktop，现已用于 `thread/list` 与限流刷新。原生 Codex 作为委派目标可直接复用它。
- `officialEnvironment()` 目前主动剥离全部 codexhost 内部环境变量后再传给官方 App Server。

## Goals / Non-Goals

**Goals:**

- 用户在 Harness A 中一句话即可把任务交给 Harness B，子会话立即出现在 Codex Desktop 左侧列表并可直接交互。
- A 保留编排权：由 A 决定何时等待、何时读取、如何使用结果。
- 每个 Thread 单一 Harness 归属，Native Session 不共享、不迁移。
- 委派链路对所有已注册 Harness 一致可用，包括原生 Codex 作为发起方与被委派方。

**Non-Goals:**

- 编排框架（DAG、决策门、协商问答）。
- 为观察子会话另造 UI 或抓取 Transcript。
- 修改原生 Codex 请求的转发与透传语义。

## Decisions

### 发起方统一通过薄 Agent Skill 发现委派能力

codexhost 维护一份权威 Skill 模板，并在用户级目录安装两份内容完全一致的副本：

```text
~/.agents/skills/codexhost-delegation/SKILL.md
~/.claude/skills/codexhost-delegation/SKILL.md
```

`~/.agents/skills` 覆盖读取共享 Agent Skills 根目录的发起方；Claude Code 不读取该根目录，因此使用其原生的 `~/.claude/skills` 目录。只有两个固定目的地时，直接维护副本比引入 symlink、Windows junction、断链修复与卸载顺序更简单。两份文件不得因 Harness 而分叉。

Skill 是 discovery stub，而不是 CLI 手册。它只说明：用户明确要求委派或使用有效 `@<harnessId>` 时，可通过 codexhost 创建归属目标 Harness 的独立会话；执行前必须运行 `codexhost delegate --help` 获取当前版本的完整命令与规则；不得凭记忆猜测参数、标识、等待或结果回流行为；用户只是在讨论 Harness 时应忽略。命令、参数、错误码和结果回流语义只由随二进制提供的帮助负责。

首次安装及后续 codexhost 更新时，安装器都检查两处文件的受管版本与内容摘要。缺失或低于当前内置版本的受管副本通过同目录 staging 文件和原子替换更新；当前且摘要一致的副本保持不变。若目标文件存在但不再匹配 codexhost 上次记录的受管摘要，视为用户修改或非受管冲突，不得静默覆盖。安装完成后应验证两个目标文件均存在、版本与内容一致。

Host 不再扫描用户 Turn 来决定是否追加提示，也不向任何 Harness 注入委派说明。这样外部 Harness Transcript 不会保存额外提示，原生 Codex 官方历史也不会被污染；同时保留原生 Codex 请求的原始转发语义。调用方 Thread 身份仍由 CLI 显式参数或 Host 提供的运行时上下文解析，与 Skill 安装位置无关。

Skill 只服务发起方的能力发现。被委派方由 Host 直接创建 Session/Thread 并投递任务，无论目标 Harness 是否安装、加载或理解该 Skill，都不得影响委派执行。

### CLI 不做 Runtime 发现，连接参数由 Host 提供

Host 向它拉起的 Harness 进程提供 `CODEXHOST_CLI_PATH`、`CODEXHOST_RUNTIME_ENDPOINT`、`CODEXHOST_RUNTIME_TOKEN`、`CODEXHOST_THREAD_ID`；并把前三项通过显式白名单放行给官方 App Server，使原生 Codex 的工具调用继承后也能连回同一 Runtime。`officialEnvironment()` 的剥离行为对白名单之外的变量保持不变，避免把内部路径与更新状态暴露给官方进程。

由此 CLI 不需要在多个 Runtime 之间消歧或校验实例身份。连接参数不完整时失败并明确报错，不回退到 PATH 猜测——猜测正是 npm 版与安装包版串线的来源。

调用方身份分两种来源：外部 Harness 一个进程对应一个 Session，可由环境承载；原生 Codex 一个进程服务全部 Thread，可在 Host 中由当前唯一活跃 Turn 推断，存在多个活跃 Turn 时要求命令提供显式父 Thread 参数。

### 不设委派深度上限，Host 不从任务文本自动触发委派

Skill 只在 Agent 处理用户请求并判断该请求确实要求委派时引导其调用 CLI。Host 为目标创建和投递的任务 Turn 不执行委派语法扫描，也没有额外提示注入，因此任务文本中偶然包含 `@<harnessId>` 不会由 Host 自动触发再次委派。

深度上限仍被移除：它会误伤用户在子会话中明确发起的新委派。每次实际委派都必须由当前发起方 Agent 主动调用 CLI，并形成独立 Delegation 记录。

### 原生 Codex 作为委派目标复用带外官方请求

创建原生子 Thread 与投递任务通过 `OfficialRequestBroker` 完成，其响应被拦截而不回送 Desktop。官方针对该 Thread 的通知本来就流经 Host 的官方输出转发，因此只需增加一个针对被跟踪 Thread 的旁路留存，即可提取终态与结论组成结构化结果——不需要为原生条目建立完整投影。子 Thread 在 Desktop 的显示与列表聚合沿用官方既有语义，无需额外工作。

### 委派关系独立存储，不复用 Subagent 字段

Subagent 子 Thread 语义是「同一 Harness 内的只读附属品」，`external-thread-list` 会将其从会话列表中排除。委派子 Thread 恰恰必须出现在列表里，且属于另一个 Harness、可写。两者若共用字段，现象会是「会话建出来了、CLI 拿得到 ID、就是左侧不显示」。因此 Delegation 关系单独记录。

### 委派血缘从 Delegation 记录解析，不走 `thread/list` 的 parent 过滤

现行契约在 `parentThreadId` / `ancestorThreadId` 过滤下会省略外部记录，且明确要求不得把外部血缘当作 Codex Subagent 关系。改动该契约会影响 Desktop 自身的列表行为，风险大于收益。因此 `thread list --parent` 由 Delegation 记录解析，普通过滤（cwd、limit、cursor、排序）仍映射到 `thread/list`。

### 委派 Session 统一使用无人值守执行策略

`delegate start` 在创建目标 Session 时携带统一的 `unattended-full-access` 执行意图，而不是让 Coordinator 拼接 Harness 私有命令。各 Adapter 在自身所有权内将该意图转换为委派默认权限设置：Claude Code 使用 `auto` Permission Mode，由 Claude Code 判断哪些操作可自动执行；Grok 使用 `always-approve`；Pi 与 OMP 以 `--approval-mode yolo` 启动。DeepSeek Harness 使用最新版 Host Remote `commands/execute` 执行 `/permission danger-full-access`，并在任务投递前同时校验命令成功以及历史中最终的 `permission/preset=danger-full-access`、`sandbox/mode=danger-full-access`、`approval/policy=never`；最新版调用必须显式传递空的 `images` 列表。原生 Codex 的官方 `thread/start` 显式携带 `approvalPolicy: "never"` 与 `sandbox: "danger-full-access"`。

该策略只用于委派创建，不改变用户从 Desktop 创建普通 Thread 时选择的权限。未来恢复或继续委派 Thread 时应保留 Native Session 已记录的权限状态，而不是回退到 Adapter 默认值。若目标 Harness 声明支持该执行意图但无法应用，创建 SHALL 失败并走现有回滚，不得留下等待人工审批的半运行委派。

### 委派创建与结果观察解耦，由发起方 Agent 自主编排

`delegate start` 只负责创建目标 Session/Thread、投递任务并立即返回子 Thread 标识与深度链接，不等待目标完成，也不建立完成后主动回流义务。发起方 Agent 可按当前任务需要自主选择：立即调用 `thread wait` 等待、使用短超时取得检查点、通过 `thread read` 读取当前结果、让子任务在后台运行后稍后再检查，或创建后不再跟踪。

外部 Harness 的委派 Turn 并非由 Desktop 发起，因此 Renderer 没有本地乐观用户消息。Host 必须把委派任务作为该实时 Turn 的初始 `userMessage` 投影到 `turn/started`、运行中快照与 `turn/completed`；普通 Desktop 发起的 Turn 仍由 Renderer 自己持有输入，不在通用 projector 中重复注入。原生历史刷新继续作为持久化事实来源，并与实时投影使用相同的稳定 Host Turn 标识，避免完成后重复显示输入。

`thread wait` 是有界观察操作：目标在期限内完成时返回结构化结果；超时时以成功退出并报告 `running`，子任务继续执行。Host 不为了主动回流而向父 Session 注入输入、唤醒父 Agent或创建自主 Turn，也不需要为此声明 Adapter 输入注入能力。Host 仍需维护子 Thread 的普通运行状态和可读结果，以支持 Desktop 展示及显式 `read` / `wait`，但不增加专门的完成通知到父 Session 的链路。

### `thread read` 默认只返回结果，按需读取可见消息

`thread read` 的首要调用方是父 Agent。若默认返回完整 Turn Item，会把子 Agent 的命令、工具输出和文件读取过程重新复制进父上下文，抵消委派的上下文隔离价值。因此首版只提供两个读取视图：

- `result`（默认）：Thread 与最近 Turn 状态、最新 Agent 可见进度、最终 Agent 消息及结果可用性。
- `messages`：在 `result` 的基础上附带有界、可分页的用户与 Agent 可见消息，支持 cursor 增量读取。

首版不提供 `activity`、`raw` 或 `full-transcript`，也不从 Host 已保存的完整 Item 中返回工具调用、工具参数、工具输出、文件变更或 reasoning summary。这里没有新增脱敏层；边界是只选择公共可见对话投影，不读取 Harness 私有 Transcript 或隐藏推理。`result.text` 确定性地取最近已完成 Turn 的最终 Agent 消息，不额外调用模型生成摘要。

`thread read` 立即返回当前快照；`thread wait` 只增加有界等待，结束后复用相同的 `result|messages` 结果形状并增加 `timedOut`。两者均为非消费性只读操作，不启动 Turn、不发送输入、不唤醒 Agent、不改变状态。

### CLI 命令面固定且默认输出 JSON

首版命令面固定为：

```text
codexhost delegate start --harness <harnessId> --task <text> [--parent-thread <thread>] [--request-id <id>]
codexhost thread read <thread> [--view result|messages] [--cursor <cursor>] [--limit <n>]
codexhost thread wait <thread> [--timeout-ms <n>] [--view result|messages] [--cursor <cursor>] [--limit <n>]
codexhost thread list [--cwd <path>] [--parent <thread>] [--limit <n>] [--cursor <cursor>] [--sort created-asc|created-desc|updated-asc|updated-desc|recency-asc|recency-desc]
```

`read` 与 `wait` 默认 `--view result`；cursor 和 limit 只控制 `messages`。`list` 默认当前调用方 cwd、25 条、`created-desc`，并沿用当前聚合列表的 100 条上限。裸 Thread ID 与 `codex://threads/<id>` 在所有接受 Thread 标识的位置等价。


`delegate` 与 `thread` 子命令的调用方是模型而非人。要求模型记得加 `--json` 只会增加一类失败模式。

## Risks / Trade-offs

- [Agent 可能未加载或未遵循 Skill] → 两处安装覆盖共享 Agent Skills 与 Claude Code 原生目录；Skill 保持短小、触发描述明确，并以 `codexhost delegate --help` 作为唯一权威入口。
- [两份副本可能漂移] → 两份均从同一内置模板生成，安装与更新时比较受管版本和内容摘要，并验证最终内容一致。
- [用户修改了受管 Skill] → 不静默覆盖摘要不匹配的现有文件，报告冲突并保留用户内容。
- [CLI 可操控用户提供的任意外部 Thread] → 授权模型是「用户显式给出标识即为授权」；列举能力默认限定在调用方 cwd 与自身委派血缘，避免模型发现并操控未被告知的会话。
- [子 Thread 同时被 CLI 与用户操作] → 外部 Thread 同时只允许一个活跃 Turn；本变更只提供读取与等待，写入类操作留待后续变更并以用户输入优先。
- [无人值守执行策略可能允许修改文件、执行命令与访问更广资源] → 该策略仅用于用户明确发起的委派 Session，并由各 Adapter 使用其明确映射的原生权限机制；普通 Thread 权限不受影响。Claude Code 使用 `auto`，不会绕过其权限判断。
- [发起方结束 Turn 后不会被自动通知] → 这是刻意的首版边界；Agent 可在当前 Turn 内等待或轮询，也可把子 Thread 深度链接交给用户后结束。
- [原生 Codex 的沙箱阻止工具调用连接本地 Runtime] → 已对 Codex CLI 0.149.1 的默认 `read-only` 沙箱实测：loopback TCP 与 Unix-domain socket 均不可连接。因此首版仍向官方进程传递同一 Runtime 的白名单连接参数并保持完全相同的 CLI 语义，但原生 Codex 作为发起方时必须使用允许本地连接的会话沙箱；默认沙箱下 CLI 以 `RUNTIME_UNREACHABLE` 明确失败，不静默回退到 PATH 或另一个 Runtime。原生 Codex 作为委派目标的带外官方请求不受此限制。
- [向官方 App Server 放行环境变量削弱了既有隔离] → 白名单严格限定为 Runtime 连接参数，不含内部路径、更新状态或启动器信息，并为环境构造补充回归测试。
