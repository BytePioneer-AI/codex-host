## Why

codexhost 已经能在 Codex Desktop 中并行运行多个 Harness，但每个 Thread 是彼此隔离的孤岛。不同 Harness 各有所长，用户经常需要在 Harness A 的对话里把某个具体任务交给更擅长它的 Harness B，再由 A 汇总结果。

今天要做到这件事，用户必须自己新开会话、手工复制上下文、来回切换窗口，A 完全无从参与。缺的不是渲染能力（子会话本来就能显示），而是一条「A 能发起、能拿回结果」的委派通路。

## What Changes

- 新增 `codexhost delegate start`：由 Harness A 发起，为目标 Harness 创建归属它自己的会话与一个**普通可写**子 Thread，并使其出现在 Codex Desktop 会话列表中。
- 新增由共享 Agent Skill 承载的委派触发：codexhost 安装两份内容完全一致的薄 Skill，分别位于 `~/.agents/skills/codexhost-delegation/SKILL.md` 与 `~/.claude/skills/codexhost-delegation/SKILL.md`。前者覆盖读取共享 Agent Skills 根目录的发起方，后者兼容 Claude Code；Skill 只解释委派语法并要求先运行 `codexhost delegate --help`，不复制完整命令文档。Host 不在用户 Turn 中注入提示，也不改写原生 Codex 请求。
- 新增 Delegation 关系持久化：父子 Thread 关系与可选 Request ID 幂等，独立于 Thread 记录保存；省略 Request ID 时在有界时间窗内按父 Thread、目标 Harness 与任务文本去重。Host 不根据任务文本自动触发委派，Host 投递的任务 Turn 也不依赖 Skill。
- 新增 `codexhost thread read|wait|list`：接受用户提供的 Thread 标识（裸 ID 或 `codex://threads/<id>` 深度链接），可观察外部 Harness Thread 与原生 Codex Thread，不限于自己委派出去的。`read` 默认只返回状态、最新可见进度与最终 Agent 消息，按需通过 `--view messages` 分页读取用户/Agent 可见消息；首版不返回工具调用、工具输出或 reasoning summary。
- 新增原生 Codex 作为委派目标：通过对官方 App Server 的带外请求创建原生 Thread、投递任务并跟踪其通知以提取结果。
- 将委派创建与结果观察解耦：`delegate start` 创建子 Thread 后立即返回，发起方 Agent 自主选择通过 `thread read` 读取、通过有界 `thread wait` 等待、稍后再检查，或不再跟踪。Host 不在子任务完成后主动向父 Session 注入结果或唤醒父 Agent。
- CLI 不做 Runtime 发现：Host 向它拉起的 Harness 进程提供 CLI 路径、Runtime 端点与令牌，并通过显式白名单把这些连接参数放行给官方 App Server 进程，使原生 Codex 的工具调用也能连回同一 Runtime。

## Capabilities

### New Capabilities

- `cross-harness-delegation`：一个 Harness 向另一个 Harness 委派任务，双方各自保有独立 Native Session 与单一归属的 Host Thread。

### Modified Capabilities

- `external-thread-mapping-store`：持久化记录新增 Delegation 关系，并允许调用方提供 Create Request ID 以支持幂等创建。

## Impact

- `packages/host-runtime`：委派协调器、子 Thread 物化与主动投影、`delegate`/`thread` CLI，以及两处 Agent Skill 的安装、检查与原子更新。
- `packages/mapping-store`：Delegation 关系记录与调用方提供的 Create Request ID。
- 官方 App Server 环境构造：新增 Runtime 连接参数白名单，其余内部变量保持剥离。
- 内容一致的共享 Agent Skill 产物、`~/.agents/skills` 与 `~/.claude/skills` 两处安装位置，以及版本与内容摘要检查。
- 不改动渲染层；不改动原生 Codex 请求的转发与透传语义。

## Non-Goals

- `@` 补全菜单与 mention chip（纯可发现性，用户手打 `@claude-code` 即可，后续单独提案）。
- 改写任何 Harness 的用户 Turn、注入委派提示，或重写原生 Codex 转发帧：发起方一律通过已安装的 Skill 发现委派能力。
- `delegate send` / `cancel`（用户可直接在 Desktop 的子会话里追加输入或停止）。
- 向 Harness 注入 MCP Tool（CLI 调用在 Codex UI 上同样可观测，不值得为此做逐 Harness 适配）。
- 为不同 Harness 维护分叉的 Skill 内容，或把 Skill 作为被委派方接收任务的前置条件。
- A 在用户未提出委派意图时自主发起委派。
- 任务 DAG、决策门、双向问答协商、Worker 生命周期体系。
