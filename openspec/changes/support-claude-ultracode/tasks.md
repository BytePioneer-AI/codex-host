## 1. 实机摸底（用户同意使用其 Claude 账号额度；Linux x64）

- [x] 1.1 设置探针（不发消息、不调用模型），Claude Code 2.1.287：进入/离开 Ultracode、关闭 Thinking、各档位互切、换模型后用 `getSettings()` 读回。结论：`applyFlagSettings` 不可用时也不报错；关闭 Thinking 或保持 xhigh 时 `ultracodeRequested` 残留，需显式 `ultracode: false`；Pro 套餐默认 Workflows 关闭，`ultracodeAvailable: false`。
- [x] 1.2 Claude Code 2.1.153（隔离配置、未登录、禁用自动更新）：读回没有 `ultracode` 字段，确认可据此识别旧版本。
- [x] 1.3 小规模 Workflow（Ultracode 模式，sonnet，规模 small）：记录完整 SDK 消息。确认 Workflow 审批的 `displayName`/`description`、`task_started` 与工具结果字段、`workflow_progress` 的字段与状态、智能体消息不转发、智能体审批带 `agentID` 且在主回合结果之后到达、`task_notification` 后的续写。
- [x] 1.4 关键词触发 + 中断：未开启 Ultracode 时提示含 "ultracode" 会先加载 `workflow-authoring` 技能再调用 Workflow；主回合进行中 `interrupt()` 会连带停止 Workflow（`task_notification` 为 stopped）。
- [x] 1.5 比较 SDK 0.3.220 与 0.3.289 的 `getSubagentMessages()`：前者对 Workflow 智能体只返回最后 3 条（转录在附件记录处断链），后者返回完整转录且首条为带外层包装的任务。
- [ ] 1.6 2.1.154–2.1.283 区间（Ultracode 隐含 xhigh 的旧语义）未实机验证；载荷对两种语义一致，读回判定不依赖版本。

## 2. Ultracode 档位

- [x] 2.1 `thinking-options.ts` 新增 `ultracode`（"Ultracode"），配置为 xhigh + `ultracode`；所有模型都列出。
- [x] 2.2 纯函数 `claudeThinkingFlagSettings`：只在进入或离开 Ultracode 时带 `ultracode` 键。
- [x] 2.3 `ultracode.ts`：读回判定（失败即关闭）、原因分类（版本、Workflows 关闭、模型不支持、无法判断、读不到）与错误映射；Workflows 开关同时参考设置与 `CLAUDE_CODE_WORKFLOWS`/`CLAUDE_CODE_DISABLE_WORKFLOWS`。
- [x] 2.4 Transport：启动时在写入用户消息前写入并读回；会话中切换与 Ultracode 下换模型时读回，未生效则恢复原状并读回确认；恢复失败或读回不符时 `onFault`。
- [x] 2.5 Adapter：启动、切换、换模型三处把读回失败映射为对应错误；启动失败时消息不发送、档位保持 Ultracode。
- [x] 2.6 测试：载荷、读回判定、启动成功/失败/读不到、切换恢复、离开时清除、换模型撤回与故障、非 Ultracode 档位不读回、Adapter 错误映射与档位保持。

## 3. Workflow 子智能体

- [x] 3.1 `native-message.ts`：识别 `Workflow` 工具、`task_started`/`task_progress`（含跨片段识别）与工具结果，解析 `workflow_progress` 的智能体项（有界、未知状态忽略）。
- [x] 3.2 `workflow-lifecycle.ts`：一个运行一个委派项，按序号维护多个智能体，稳定 `subagentId`、后续绑定 `nativeSubagentId`，后台启动后保持打开，按 `task_notification` 或回合结果结束。
- [x] 3.3 Adapter：接入委派生命周期；后台运行占用回合；状态变化与工具活动时刷新子线程；挂起期间取消时 `stopTask`；工具调用未返回却成功结束时按协议错误处理。
- [x] 3.4 Transport：审批改为会话级并区分主线程与智能体来源；智能体审批跨越主回合结果、在挂起期间可作答、挂起结束时拒绝；挂起中续写片段的主线程审批可显示；审批标题带智能体标签。
- [x] 3.5 子线程首条提示去掉 Workflow 外层包装。
- [x] 3.6 升级 `@anthropic-ai/claude-agent-sdk` 到 0.3.289，修复 Workflow 智能体转录读取。
- [x] 3.7 测试：原生解析、委派生命周期、Transport 智能体审批、Adapter 挂起/作答/汇总/取消、子线程首条提示。

## 4. 规格与文档

- [x] 4.1 `claude-code-text-session` 规格增量：删除过时的 Thinking 需求，新增 Ultracode 与 Workflow 映射需求。
- [x] 4.2 新增 `docs/harnesses/claude-code/claude-code-ultracode.md`。

## 5. 验证与提交

- [x] 5.1 Claude Adapter 定向测试、全量 TypeScript 测试、TypeScript 构建与类型检查、lint、边界检查与格式检查。
- [x] 5.2 用构建产物做端到端实测（Claude Code 2.1.287 与 2.1.153）：
  - 默认设置（Workflows 关闭）选择 Ultracode 发消息：返回 `configurationRequired`，消息未发送、未调用模型；
  - 2.1.153：返回 `unsupported` 并提示升级；
  - `CLAUDE_CODE_WORKFLOWS=1`（仅本次进程）：Workflow 审批、委派卡片与两个智能体的状态变化、智能体审批在主回合结束后作答、回合在汇总后完成、子线程读取首条任务；
  - 会话中切换：Low → Ultracode 成功；Ultracode 下换 Haiku 被拒并保持原模型；换 Opus 成功；Ultracode → High 成功。
- [ ] 5.3 用户在 Codex Desktop 上确认档位菜单、失败提示、Workflow 卡片与子线程、审批、取消表现，提供脱敏截图。
- [ ] 5.4 以中文提交信息提交，推送到 fork 并开 Draft PR（推送前与用户确认）。
