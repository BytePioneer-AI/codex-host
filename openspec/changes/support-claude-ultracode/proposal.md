## Why

Claude Code 从 2.1.154 起提供会话级的 Ultracode：开启后 Claude 会持续用 Workflow 工具编排多个子智能体完成任务。原生入口是终端里的 `/effort`，宿主程序通过 `--settings` 或 `applyFlagSettings({ ultracode })` 打开。codexhost 目前只能选 Off / Auto / Low / Medium / High / Extra High / Max，Claude Code 用户在 Codex Desktop 里无法开启 Ultracode。

即使开启了，Workflow 启动的智能体也不是主线程的 Agent 工具调用，codexhost 只会把整次 Workflow 显示为一张普通工具卡，用户看不到派出了哪些智能体、进展如何，也无法点开查看；智能体在主回合结束后发起的工具审批还会被直接拒绝。Ultracode 下几乎每个回合都会走 Workflow，所以两者需要一起交付。

另外，Claude 思考档位切换已在 `444e3928` 实现，但主规格 `claude-code-text-session` 仍写着 "Claude Thinking selection remains unsupported"，与代码不符，本变更一并修正。

## What Changes

**Ultracode 档位**

- Claude 思考档位新增 `ultracode`（显示为 "Ultracode"），含义固定为"原生 effort `xhigh` + 会话级 `ultracode`"，在 2.1.154–2.1.283（Ultracode 隐含 xhigh）和 2.1.284 及以上（Ultracode 与档位解耦）两种原生语义下行为一致。
- 所有模型、所有 CLI 版本都显示 Ultracode。Claude Code 对写入的 `ultracode` 一律"接受"（旧版本把它当未知键合并，不可用时也不报错），所以是否生效以写入后读回的原生会话设置（`get_settings` 的 `applied.ultracode`）为准，读不到或不为 `true` 一律按未生效处理。
- **不静默降级**：发送消息前 Ultracode 未生效时，中止这条消息（不发给 Claude），向用户显示原因，保留用户选择的 Ultracode：
  - 读回没有 Ultracode 字段（CLI 早于 2.1.154）：`unsupported`，提示升级到 2.1.154 及以上；
  - Workflows 关闭：`configurationRequired`，提示在 Claude Code `/config` 打开 Dynamic workflows；
  - Workflows 已明确打开但仍不可用：`unsupported`，提示当前模型不支持；
  - 无法判断原因或读不到设置：给出同时涵盖前述条件的提示。
- 会话中切换到 Ultracode 未生效：恢复原档位并读回确认，返回原因，原档位保持不变。
- Ultracode 下切换模型后无法保持：撤回模型切换并返回原因，保持原模型与 Ultracode；撤回本身失败时会话进入故障态，不在未知状态下继续。
- 只有进入或离开 Ultracode 时，原生写入才带 `ultracode` 键：进入发 `effortLevel: "xhigh"` 与 `ultracode: true`，离开追加 `ultracode: false`；其他档位间切换的载荷与现在完全相同。

**Workflow 子智能体显示**

- 一次 Workflow 运行投影为一个子智能体委派项（Codex 协作智能体卡片），卡片说明取 Workflow 的描述。
- 根据 Claude Code 发出的 `task_progress.workflow_progress`，把每个 Workflow 智能体投影为卡片中的一个子智能体：标签、阶段（或智能体类型）、模型、状态（排队/运行/完成/失败）、结果或错误摘要；拿到原生 `agentId` 后可点开为只读子线程，首条提示显示去掉 Workflow 外层包装后的任务原文。
- 智能体状态变化或有新的工具活动时刷新已打开的子线程。
- Workflow 运行期间按现有后台子智能体规则占用当前回合，Workflow 结束且 Claude 给出汇总后回合才完成。
- 智能体发起的工具审批在主回合结束后仍可作答，标题带智能体标签；回合结束时未作答的审批被拒绝。
- Workflow 本身的审批显示 Claude Code 提供的 Workflow 描述。
- 取消会真正停止本回合的后台工作：对后台子智能体与 Workflow 发出原生停止并确认，拦截 Claude 停止后自动开始的回复；停止得不到确认时关闭 Claude Code 进程。这也修正了改动前挂起期间取消只在界面上标记中断、后台仍在运行的问题。

**依赖**

- `@anthropic-ai/claude-agent-sdk` 从 0.3.220 升级到 0.3.273。0.3.220 读取子智能体转录时会在附件记录处断链，Workflow 智能体只能读到最后几条消息；0.3.259 起能读到完整转录（含首条任务），0.3.273 是 0.3.274 改变历史回放之前的最后一版。升级后类型检查与现有测试无需改动。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `claude-code-text-session`：Thinking 选择由"未支持"改为"使用原生 effort 与会话级 Ultracode"，规定读回判定、未生效时中止消息、切换与模型变更的处理；新增 Workflow 运行到公共子智能体契约的映射。

## Impact

- `packages/adapters/claude-code`：思考档位定义、Ultracode 读回判定（新文件 `ultracode.ts`）、SDK Transport（启动与切换时的读回、智能体审批作用域）、原生消息解析（Workflow 工具与进度）、Workflow 委派生命周期（新文件 `workflow-lifecycle.ts`）、Adapter（错误映射、回合占用、取消时停止后台工作、审批保留）、子线程首条提示、相关测试。
- 依赖：`@anthropic-ai/claude-agent-sdk` 0.3.220 → 0.3.273（根与 Claude Adapter 的 `package.json`、`package-lock.json`）。
- `docs/harnesses/claude-code/`：新增 Ultracode 与 Workflow 显示说明。
- 不改变共享契约、Host、Renderer、Mapping Store 或其他 Harness。
- 不包含：独立于档位的 Ultracode 开关；替用户打开 Workflows；Workflow 阶段映射到计划面板、运行日志输出、单个智能体的停止/续跑；冷读取历史时把 Workflow 还原为委派卡片（与现有 Agent 子智能体一致，历史中仍为普通工具项）；`workflowKeywordTriggerEnabled` 等 Workflow 设置。
