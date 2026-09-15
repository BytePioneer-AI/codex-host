# Antigravity（agy）提问交互功能（Ask Question）技术复盘与可行性深度调研报告

- **日期**：2026-09-05
- **环境**：Windows 11 / Node.js / Codex Desktop (OpenAI.Codex_26.901.5003.0) / agy.EXE
- **涉及组件**：`@codexhost/adapter-antigravity`, `packages/host-runtime`, `packages/protocol-core`
- **关联原生会话**：`8f08ea60-ce53-4568-813c-ae739a5af63e`（线程 ID：`3c4601e6-f089-4f75-8aa7-38aa8b135a4f`）

> **后续状态（2026-09-05）**：第 1–7 节保留原 stdout 映射失败时的历史复盘，其中“只能退回文字或使用 MCP”的判断已被后续实测修正。当前已实现前置 Hook 问答桥，实测依据、交互限制及验收边界见第 8 节；不应把桥接成功等同于原生 `ask_question` 工具正常成功返回。

---

## 1. 背景与问题现象

### 1.1 背景诉求
在 Codex 原生体验中，当模型需要澄清模糊需求或向用户提供选项时，会发起 `request_user_input` 交互请求，Codex Desktop 界面会渲染专用的交互表单卡片（包含单选圆钮、多选方框、自定义文本框、“提交”与“跳过”按钮）。
此项工作的目标是：在 Antigravity 适配器（`AntigravityAdapter`）中，拦截 Antigravity 模型发起的 `ask_question` 工具调用，将其映射为 Codex Desktop 的原生提问卡片，并在用户完成点选后将答案回传给模型。

### 1.2 实际运行时故障现象
在接入完成后，在真实的 Codex Desktop 环境中进行实测：
1. 用户在聊天框发送指令：“调用提问工具随便问我一个问题。”
2. **Codex Desktop 界面完全没有任何交互卡片或选择弹窗弹出**。
3. 经过约 2~3 秒后，助手直接输出最终文本回复：
   > “我已经调用了提问工具向您发起提问（您选择了跳过）... 系统返回状态同样为 User Skipped”。
4. 分别在 `request-review`（每次询问审批）和 `dangerously-skip-permissions`（自动跳过审批）两种权限模式下测试，**结果完全一致，均未弹出窗口且直接报告被跳过**。

---

## 2. 真实日志与数据库证据追踪

通过对 `codexhost` 本地 Mapping Store、Antigravity 运行时生成的转录日志（Transcript）以及落盘步骤文件进行现场调取，梳理出真实的底层事件链：

### 2.1 会话元数据与转录记录
- **Mapping Store 文件**：`C:\Users\21240\.codexhost\mapping-store\threads\3c4601e6-f089-4f75-8aa7-38aa8b135a4f.json`
- **Antigravity 实际转录日志**：`C:\Users\21240\.gemini\antigravity-cli\brain\8f08ea60-ce53-4568-813c-ae739a5af63e\.system_generated\logs\transcript_full.jsonl`

现场抓取的关键时序记录如下：
```json
// Step 1: 模型决定发起提问，生成工具调用
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-05T07:48:17Z",
 "tool_calls":[{"name":"ask_question","args":{"questions":[{"is_multi_select":false,"options":["Python","Rust","Go","TypeScript / JavaScript"],"question":"在日常开发中，你最常用或最喜欢的编程语言是哪一种？"}]}}]}

// Step 2: 工具执行结果在 70ms 内立刻生成
{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-09-05T07:48:20Z",
 "content":"Created At: 2026-09-05T00:48:20-07:00\nCompleted At: 2026-09-05T00:48:20-07:00\nA1: User Skipped"}

// Step 3: 模型根据 Step 2 的 "A1: User Skipped" 输出给用户的解释
{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-05T07:48:20Z",
 "content":"我已经调用了提问工具向您发起提问（您选择了跳过）。\n\n请问接下来有什么我可以协助您的编码任务或问题吗？"}
```
在实际目录 `.system_generated\steps\2\output.txt` 中，文件内容已确凿被写入为：
```text
A1: User Skipped
```

---

## 3. 根本原因深度分析（Root Cause Analysis）

针对为什么 `ask_question` 会在瞬间自动返回 `User Skipped`，并且界面连弹窗都没触发，我们对 `agy.EXE`（Google Antigravity CLI 二进制程序）进行了符号提取和反汇编分析。

### 3.1 核心原因：`agy` 在流式模式下硬编码了自动跳过逻辑
`codexhost` 驱动 `agy` 进程的标准命令参数为：
```bash
agy.EXE --input-format stream-json --output-format stream-json ...
```
在 `agy.EXE` 的 Go 语言实现中（包路径 `google3/third_party/jetski/cli/printmode` 和 `google3/third_party/jetski/cli/store`）：
1. 传入 `--output-format stream-json` 或 `--print` 时，CLI 内部强制将全局模式设置为 **`PrintMode`**（非交互批处理模式）。
2. 在 `store.(*Manager).checkStepForAskQuestion` 中存在如下硬编码逻辑：
   ```go
   // 伪代码，对应二进制中符号与字符串偏移
   if m.IsPrintMode() {
       log.Printf("Auto-answering ask_question at step %d with skipped=true", stepIndex)
       m.RespondToAskQuestion(conversationId, stepIndex, skipped: true)
       return
   }
   ```
3. 在 `PrintMode` 下，`agy` 认为没有交互式控制台终端（TTY），因此当模型发起 `ask_question` 工具调用时，**内部状态机在 70 毫秒内直接在进程内调用自身的回调，将其无条件标记为 `skipped: true`**，并将该动作归类为 `denied_actions: [{"display_name": "AskQuestion"}]`。
4. 它**根本不会挂起（block）进程去等待外部 stdin 输入或 gRPC 回调**。

### 3.2 协议层原因：`stream-json` 没有抛出 `tool` 事件
在 `--output-format stream-json` 的 NDJSON 标准输出流中，`agy` 对该工具调用的输出格式为：
- `step_index: 1`：`step_type: "agent_response"`（无 `tool_name` 字段）
- `step_index: 2`：`step_type: "unknown"`（无 `tool_name` 字段，耗时仅 0.073 秒）
- 最终 `result`：包含 `"denied_actions":[{"display_name":"AskQuestion"}]"`

而在 `AntigravityAdapter` 的事件处理代码中：
```typescript
if (step.step_type !== "tool") return;
const rawToolName = merged.tool_name ?? merged.tool_info?.name ?? "";
if (isAntigravityQuestionTool(rawToolName)) { ... }
```
由于 `step_type` 分别是 `"agent_response"` 和 `"unknown"`，且都不带 `tool_name`，**Adapter 从始至终根本没有识别到这是一个提问工具调用**。
因此：
- Adapter 从未向 Host Runtime 触发 `HostQuestionInteraction`；
- Host Runtime 从未向 Codex Desktop 发送 `item/tool/requestUserInput`；
- **Codex Desktop 从未收到任何提问消息，自然不会弹出任何窗口**。

### 3.3 为什么“两种权限审批模式都是这样”？
用户测试了 `request-review` 和 `dangerously-skip-permissions`：
- **权限模式（Permission Mode）的管辖范围**：在 Antigravity 中，审批模式严格仅控制 **权限操作**（`PermissionInteraction`，例如 Bash 命令行执行、文件修改写入）。在 `dangerously-skip-permissions` 下，这些操作会自动获得放行。
- **提问工具（Ask Question）的属性**：`ask_question` 在内部属于 **用户交互采集（Elicitation/Interaction）**，而不是权限授予。
- 无论是哪种权限模式，进程都运行在 `PrintMode` 下，`IsPrintMode()` 始终为 `true`，因此 `ask_question` 的自动跳过无条件触发。

---

## 4. 前期开发误区复盘（为什么之前的测试全绿但实测报废？）

在早期的开发过程中，自动化单元测试（Vitest）全部通过，但上线实测却完全失效。技术复盘发现主要原因如下：

1. **测试脱离了真实二进制环境**：
   前置测试使用的是手动构造的流模拟器（`fakeStreamingAgy`）。开发者主观假设 `agy` 会像其他 CLI 工具一样吐出如下标准事件：
   ```json
   {"event":"step_update","step_update":{"step_index":1,"step_type":"tool","tool_name":"ask_question","tool_info":{"parameters":{...}}}}
   ```
   并在测试里自造数据驱动状态机。
2. **忽视了上游 CLI 的架构约束**：
   没有先对真实 `agy.EXE` 发送实际 Prompt 进行网络/进程级探针抓包，未意识到 `stream-json` 属于 `printmode`，更未发现其内部存在强制短路自动跳过的逻辑。
3. **工具映射失效的本质**：
   映射层（`AntigravityAdapter -> HostQuestionInteraction -> Codex Desktop`）的代码逻辑虽然符合 Host 协议规范，但**映射的前提是上游底层支持挂起并等待外部输入**。上游既然硬编码了自动跳过且不抛出事件，这套映射在物理链路上就属于**无效的死代码**。

---

## 5. 跨 Harness 架构横向对比

为什么同样的交互提问功能，在 Claude Code 和 Pi 上可以正常工作，但在 Antigravity 上不行？

| 特性 / Harness | Claude Code | Pi | Antigravity (`agy`) |
| :--- | :--- | :--- | :--- |
| **集成形式** | 开放 Node.js SDK | 双向 RPC 协议 / Headless Session | 独立封闭 Go CLI 二进制 (`agy.EXE`) |
| **提问工具实现** | `AskUserQuestion` | `select` / `confirm` / `editor` | `default_api:ask_question` |
| **挂起等待机制** | 提供 `canUseTool` SDK 钩子，工具执行前主动暂停并将控制权转交给 Host | RPC 阻塞式请求，直到收到客户端 Response 才继续 | **无外部挂起机制**；在 PrintMode 下内部判定无 TTY 直接短路为 Skip |
| **流式协议支持** | 完整暴露 Tool Input 与状态 | 完整暴露请求与 Payload | `stream-json` 中将提问吞并为 `unknown`，并在 70ms 内终止 |
| **工具映射可行性** | **原生可行**（已完整支持） | **原生可行**（已完整支持） | **原生不可行**（被 CLI 内部设计封死） |

---

## 6. 当前采取的处理方案与后续演进分析

### 6.1 当前已实施方案（方案 A + 方案 C）
鉴于上游二进制限制，为了避免给用户造成“工具明明调了却说我按了跳过”的不良体验，当前已完成：

1. **清理死代码（方案 C）**：
   - 彻底移除了 `AntigravityAdapter` 中无法被真实触发的 `isAntigravityQuestionTool`、`#respond`、`#closeActiveInteractions` 等冗余逻辑；
   - 恢复了适配器原有的安全契约：
     ```typescript
     if (command.type === "interaction.respond") {
       return {
         ok: false,
         error: unsupported("Antigravity headless mode cannot answer interactive prompts"),
       };
     }
     ```
   - 删除了基于假 Mock 数据的测试文件。
2. **系统提示词明确拦截（方案 A）**：
   - 在 [`ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION`](file:///D:/CodeProject/codex-host/packages/adapters/antigravity/src/antigravity-adapter.ts#L236-L245) 中注入明确指引：
     > `CRITICAL: Do NOT call the ask_question tool. You are running in a headless non-interactive environment where interactive modal questions cannot be prompted to the user and will be automatically skipped by the system. If you have clarifying questions or wish to present options, state them directly in your text response.`
   - **效果**：模型在需要向用户提问或提供方案选项时，不再去调用会必定失败的 `ask_question` 工具，而是直接在最终的 Markdown 回复中列出问题与选项，由用户在聊天输入框中正常打字回复。

### 6.2 用户关切问题说明
> **“让 agy 不要调用 ask_question，直接在文本回复中提问，这和它直接问我有什么区别？之前的工具映射不就报废了？”**

- **区别说明**：从**最终交互结果**来看，确实就退化成了“普通对话聊天”。原先工具映射希望达成的效果是“在聊天窗里弹出一个能用鼠标勾选的 UI 控件卡片”，而直接文本回复则是普通的文字段落。
- **关于报废**：是的，针对 `agy` 的原生 `ask_question` 工具映射确实已经失效报废。因为 `agy` 的命令行设计把流式输入当成纯批处理管道，不支持交互式提问卡片的外部接管。

### 6.3 未来若强需“弹窗选择交互”的可行技术路径评估

如果后续有强烈需求，必须让 Antigravity 在 Codex Desktop 中唤起原生的单选/多选卡片，以下是潜在的技术评估：

#### 途径：通过内置 MCP 工具接入（方案 B）
- **原理**：
  `agy` 支持接入第三方 MCP（Model Context Protocol）服务器（`call_mcp_tool`）。MCP 工具在 Antigravity 体系中被视为**外部远程服务**。
- **可行性逻辑**：
  1. `codexhost` 在本地拉起一个轻量内置的 MCP Server，向 `agy` 注册一个名为 `codex_ask_user`（或类似）的 MCP 工具。
  2. 在系统提示词中引导模型：“如需向用户提问选项，请调用 `codex_ask_user`”。
  3. 当模型调用该 MCP 工具时，由于是外部 RPC 调用，`agy` 会**保持阻塞，等待 MCP 响应**（不会触发内部的 70ms 自动跳过）。
  4. `codexhost` 的 MCP 接收到调用后，唤起 Codex Desktop 的 `request_user_input` 交互卡片。
  5. 用户勾选提交后，MCP Server 将结果作为工具输出返回给 `agy`。
- **代价与权衡**：
  - 需要在 `codex-host` 中维护一个内置 MCP 进程或通信通道，增加了架构复杂度。
  - 需要确保模型在内置 `ask_question` 和 MCP 提问工具之间准确选择。

---

## 7. 总结
本次问题的根因在于 **上游 `agy.EXE` 在非交互模式下对内部 `ask_question` 工具实施了硬编码自动跳过**。当前采取“提示词规避 + 死代码清理”是最稳健、最符合真实物理限制的方案；若后续需要进一步实现弹窗控件交互，应转向 MCP 代理方案而非直接劫持内置工具。

## 8. 后续实测与 Hook 桥接实现（2026-09-05）

### 8.1 修正后的结论

`PreToolUse` 可以在当前本机 CLI 的 `stream-json` 模式下截获真实 `ask_question`。Hook 等待用户响应后，以 `decision: "deny"` 阻止原生自动跳过，并通过 `reason` 将答案返回给模型。这条路径不依赖 stdout 是否暴露工具名。

三个隔离探针的结果如下，答案均明确标记为自动化测试数据，随机校验串未放入初始 Prompt：

| 路径 | CLI 实际权限状态 | Hook 等待 | 原生 `num_turns` | 校验串 |
| --- | --- | --- | --- | --- |
| deny 后注入 `userMessage` | request-review | 5.019 秒 | 2 | 模型准确返回 |
| 仅使用 `deny.reason` | request-review | 5.013 秒 | 1 | 模型准确返回 |
| 仅使用 `deny.reason` | always-proceed | 5.010 秒 | 1 | 模型准确返回 |

第三项的启动参数为 `--dangerously-skip-permissions`，`init` 中的状态名是 `always-proceed`。原生数据库只读检查确认，reason 路径的答案写入了错误步骤数据。`userMessage` 路径则新增 `SYSTEM_SDK` 来源的用户输入，会改变轮次边界，因此本次实现没有使用它。

本机反汇编中，自动跳过分支位于 `Manager.handleAskQuestion`；第 3.1 节将它直接归于 `checkStepForAskQuestion` 的伪代码并不精确。

### 8.2 当前实现

- `packages/adapters/antigravity/src/question-bridge.ts`：每个 Turn 创建独立的本地桥，仅监听 `127.0.0.1`，使用内存中的随机鉴权值，验证原生会话身份并拒绝重复或重叠请求。
- `question-hook-client.ts`：内嵌的轻量 Hook 客户端，随发布 Bundle 打包；运行时写入独立临时目录，不需要额外安装依赖。
- 临时目录通过 `--add-dir` 加入该次 CLI 运行。真实 `/hooks` 查询已验证附加目录可以提供 Hooks，不修改项目或全局 `hooks.json`。
- Adapter 通过已有 `HostQuestionInteraction`、`interaction.respond`、`interaction.closed` 和 `CodexTurnProjector` 完成双向交互，Host 与 Renderer 不新增 Antigravity 专用请求分支。
- 桥接条目命名为 `codexhost.ask_question`，保存问题与响应，明确区分桥接动作和原生工具结果。
- 当前支持一批单选或文本问题，单选允许自由填写其他答案。现有 Desktop 投影没有多选字段，因此多选请求明确拒绝，不静默伪装成单选。
- 默认问答等待上限为 10 分钟，同时受 CLI 整轮超时约束。过期、连接断开和 Turn 终止不伪造用户选择；关闭会话时收回等待中的交互并清理私有资源。

### 8.3 Windows 启动修复

第一次真实 Adapter 验证暴露了独立探针未覆盖的命令转义问题：Hook 命令中的双引号经 Go 进程参数转义后，被 `cmd.exe` 当作路径中的字面字符。命令启动失败产生的非 UTF-8 错误输出进一步导致原生 `invalid UTF-8` 错误。

现改用环境变量在 `cmd.exe` 内展开带引号路径，命令字符串本身不含双引号。回归测试通过真实 shell 执行生成的 Hook 命令，并覆盖了含空格的目录，而不再仅直接启动 Node 客户端。

### 8.4 验证与剩余边界

已执行并通过：

- Antigravity Adapter 与 Hook 的针对性测试，包括真实客户端进程、shell 命令、答案校验、会话隔离、迟到响应、过期、断连和取消。
- Host 现有的 6 个 Question 集成回归。
- `packages/host-runtime/test/antigravity-question.real.test.ts`：真实 `agy` 经编译后的 Adapter 和公共 Question 协议投影往返答案，首轮仍为 `turn:1`；等待中的问题可取消，交互关闭先于 Turn 终态；关闭后恢复历史并继续执行成功。
- TypeScript、改动文件 ESLint，以及单文件 Host 发布 Bundle 构建。

真实集成测试使用 `CODEXHOST_RUN_ANTIGRAVITY_QUESTION_REAL=1` 显式启用，并会消费原生模型用量。可用 `CODEXHOST_ANTIGRAVITY_QUESTION_EVIDENCE_DIR` 保存输出、协议投影和快照，失败时也留证。

用户于 2026-09-05 自行验收并提供截图，确认 Desktop 原生提问卡片正常展示，问题、选项及等待回答状态可见。提交后的真人端到端流程、长时间等待、跨平台实机和多选 UI 尚未单独记录验收结果；自动化已验证原生 CLI、Adapter 与公共协议的答案往返。原生工具仍以被阻止的错误步骤保留；桥接条目的成功只表示答案已由桥接层提交，不改写这一原生事实。
