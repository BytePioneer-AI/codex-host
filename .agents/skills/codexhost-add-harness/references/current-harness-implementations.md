# 当前 Harness 实现地图

本文记录 codexhost 当前外部 Harness 的实现背景，并帮助新增 Harness 时选择参考实现。它是导航，不是接口定义；实际编码前必须读取当前源码。

## 公共架构

外部 Harness 的数据流是：

```text
原生 SDK / RPC / Host API / ACP
        ↓
Harness 专用 Transport 与协议投影
        ↓
HarnessAdapter / HarnessSession
        ↓
ExternalThreadRuntime
        ↓
CodexTurnProjector
        ↓
Codex Desktop
```

公共 seam 位于 `packages/harness-adapter/src/text-session.ts`。详细语义见 [public-adapter-contract.md](public-adapter-contract.md)：

- `HarnessAdapter` 负责检查、打开 Session、可选 Subagent Transcript 读取和整体关闭。
- `HarnessSession` 负责能力、状态、Usage、输出流、命令执行、历史快照和关闭。
- `OpenSessionInput` 统一表达 create、resume、fork 和 rollbackLastTurn。
- `HarnessOutput` 统一表达 Host Event 与 Approval/Question Interaction。
- `HostThreadSnapshot`、`NativeSessionRef`、`NativeTurnRef` 和 `NativeCheckpointRef` 支撑持久化、恢复和历史操作。

公共接口之外还存在必须检查的接入点：

- 可执行文件发现：`packages/harness-discovery/src/`
- Harness ID 与 Transport Model 路由：`packages/protocol-core/src/model-routing.ts`
- Adapter 实例注册：`packages/host-runtime/src/adapter-composition.ts`
- 外部 Thread 生命周期：`packages/host-runtime/src/external-thread-runtime.ts`
- 事件到 Desktop 的投影：`packages/protocol-core/src/codex-ui-projector.ts`
- Renderer Agent 注册、Transport Model 写入、配置恢复和产品 UI：`packages/renderer-extension/src/`
- 生产 Renderer 启用列表与安装：`packages/desktop-control/src/production-controller.ts`
- Workspace 依赖、导出与 release bundle。

正式产品接入的 Renderer 细节见 [renderer-product-integration.md](renderer-product-integration.md)。当前 Renderer 仍静态维护 Agent union、Picker、图标、安装 URL、Transport Model 编解码、ownership 恢复、配置草稿、Usage/Credits 和侧边栏映射；只实现 Adapter 不会让新 Harness 自动出现在 Desktop 中。

## 现有实现概览

| Harness | 原生连接方式 | History | 配置 | Interaction | 其他能力 |
|---|---|---|---|---|---|
| Pi | CLI 原生 RPC | create、resume、fork、跨 cwd fork、rollback | Model、Thinking | Question | Usage、Commands、Compaction、工具和文件投影 |
| OMP | CLI 原生 RPC | create、resume、fork、跨 cwd fork、rollback | Model、Thinking | 无 Host Interaction | Usage、Commands、Compaction、Subagent、Autonomous Turn |
| Claude Code | Claude Agent SDK | create、resume、fork；fork 不跨 cwd，rollback 不支持 | Model、Thinking、Permission Mode | Approval、Question | Usage、Credits、Commands、Subagent、Autonomous Turn |
| OpenCode | loopback Server + 原生 SDK | create、resume、fork；fork 不跨 cwd、rollback | Model、Thinking、Permission Mode | Approval、Question | Usage、Commands、Compaction、活动 Turn steering、工具和文件投影 |
| Grok | ACP 加私有扩展 | create、resume、fork、跨 cwd fork；rollback 不支持 | Model、Thinking、Permission Mode | Approval | Usage、Credits、Commands、Compaction |
| DeepSeek Harness | 原生 Host API / RPC | create、resume、fork；fork 不跨 cwd | Model、Thinking | Approval、Question | Usage、Commands、Compaction、分页历史、共享 Host 连接 |

原生 Codex 通过官方 App Server 协议接入，不实现外部 `HarnessAdapter`，不是新增外部 Harness 的参考模板。

## 如何选择参考实现

不要完整复制单个 Adapter。先按 Transport 选择基础参考，再按能力组合参考。

### Transport 和 Session 基础骨架

- **CLI 原生 RPC：优先参考 Pi。**
  - 文件：`packages/adapters/pi/src/pi-rpc-session.ts`、`packages/adapters/pi/src/pi-adapter.ts`
  - 理由：Transport、Session、历史、模型、Thinking、Usage、错误和关闭生命周期较完整，同时没有 OMP 的 Subagent 额外复杂度。
- **原生 SDK：参考 Claude Code。**
  - 文件：`packages/adapters/claude-code/src/sdk-transport.ts`、`packages/adapters/claude-code/src/claude-code-adapter.ts`
  - 理由：SDK 事件转换、交互、配置和复杂生命周期覆盖最完整。
- **常驻 Host API / 共享 RPC 连接：参考 DeepSeek Harness。**
  - 文件：`packages/adapters/deepseek-harness/src/host-client.ts`、`packages/adapters/deepseek-harness/src/deepseek-harness-adapter.ts`
  - 理由：连接复用、订阅、分页历史和多 Session 路由最接近此类系统。
- **ACP：仅在没有可靠原生 SDK、RPC 或其他原生接口时参考 Grok。**
  - 文件：`packages/adapters/grok/src/acp-transport.ts`、`packages/adapters/grok/src/grok-adapter.ts`
  - ACP 不能自然覆盖的历史、配置和观测能力需要私有扩展，通常会增加实现和兼容成本。

### 按能力选择最佳参考

| 要实现的能力 | 首选参考 | 次选或补充参考 |
|---|---|---|
| 最小 Turn 生命周期、并发拒绝和 Session 状态机 | Pi | `packages/harness-adapter/src/testing.ts` |
| SDK Transport 与复杂流式事件 | Claude Code | — |
| RPC Transport、进程管理与历史文件 | Pi | OMP |
| 共享长连接、多 Session 订阅与分页历史 | DeepSeek Harness | — |
| Model Catalog 与 Model/Thinking 联动 | Pi | OMP、Claude Code、DeepSeek Harness |
| Permission Mode 与 unattended execution policy | Claude Code | Grok、OMP |
| Approval + Question | Claude Code | DeepSeek Harness |
| 仅 Question | Pi | DeepSeek Harness |
| Usage 与 Context Window | Pi | OMP、DeepSeek Harness |
| Account Credits | Claude Code | Grok |
| Fork 和跨 cwd Fork | Pi | OMP、Grok |
| 同 cwd Fork、原生 Transcript Fork | Claude Code | DeepSeek Harness |
| Last-Turn Rollback | Pi | OMP、OpenCode |
| Subagent 生命周期和 Transcript | OMP | Claude Code |
| Autonomous Turn | OMP | Claude Code |
| Harness Commands / compaction | Pi | Claude Code、Grok、OMP、DeepSeek Harness |
| 活动 Turn steering | OpenCode（当前精确验证 1.18.25） | 必须按目标 Harness 与原生版本逐项验证 admission、完成、取消、持久化和 idle 语义 |
| Tool、Command 和 File Change 投影 | Claude Code | Pi、OMP、Grok、DeepSeek Harness |
| Approval/Question 响应校验 | `packages/harness-adapter/src/interaction.ts` | Claude Code、DeepSeek Harness |
| 测试公共契约与完整事件顺序 | `packages/harness-adapter/src/testing.ts` 和 `test/text-session.test.ts` | 对应 Adapter 测试 |
| 跨 Harness 委派与完整 Agent 协调 | [cross-harness-delegation.md](cross-harness-delegation.md) | Pi、Claude Code、OMP、Grok 的环境传播、inspection、create、后续 Turn、取消和 resume 测试 |
| Renderer 和 Agent Picker 产品接入 | [renderer-product-integration.md](renderer-product-integration.md) | `renderer-extension`、`desktop-control` 和生产 Renderer 测试 |

## 各 Adapter 最值得复用的部分

### Pi

Pi 是新增 CLI/RPC Harness 的默认基础参考：

- 可执行文件发现与 Node Runtime PATH 修复；
- 延迟启动 Native Session；
- 标准 Turn、Item 和 Question 生命周期；
- create/resume/fork/rollback；
- Model 与 Thinking Catalog；
- Usage 刷新；
- 历史快照、Native Turn identity 和 Checkpoint。

避免把 Pi 的原生 Session 文件结构或 RPC method 名复制到其他 Harness。

### OMP

OMP 最适合参考 Agent 自主行为：

- Subagent spawn/update/completion；
- Subagent Transcript 读取；
- `turn.autonomous.started`；
- 父 Turn 结束后后台 Subagent 继续运行；
- unattended full-access 向原生 CLI 参数的映射。

其普通 RPC、History 和 Model 代码与 Pi 相似；没有 Subagent 需求时优先读 Pi，减少干扰。

### Claude Code

Claude Code 是能力面最完整的参考：

- 原生 Agent SDK；
- Approval 和 Question；
- Model、Thinking、Permission Mode；
- Tool、Command、File Change、Reasoning、Compaction；
- Subagent 与 Autonomous Turn；
- Transcript 读取和同 cwd Fork；当前不能为单 Turn 历史派生可恢复的空 rollback Session；
- Context Usage、Plan Limit 和 Credits；
- 后台占用与 continuation quiescence。

它的实现复杂度高。只提取目标能力的模式，不以整个 Adapter 作为新实现模板。

### OpenCode

OpenCode 适合参考常驻 Server 与同一 Turn 多段原生消息的控制：

- loopback Server、Basic Auth、SDK Transport 和 SSE 对账；
- 活动 Turn 中串行追加 prompt，并用明确 capability 对 Host 开放；
- steer、idle reconciliation 与 cancel 的版本化竞态收敛；
- 仅对已持久化却未被消费的 steer 执行单次 stable-idle recovery；
- 将多个原生 User/Assistant 段恢复为一个 Host Turn，并保持 Fork、rollback 和 Diff 边界。

其调用方 Message ID 和历史分组依赖已验证的 OpenCode 原生约束；不能复制到不共享这些约束的 Harness。

### Grok

Grok 展示 ACP 集成在能力扩展时的成本：

- 标准 ACP Session 和 Permission 请求；
- 私有 fork、delete、rewind、compaction 扩展；
- Replay History 与额外 Usage/Model 信号；
- Permission Mode 的双路径同步。

只有必须使用 ACP 时才参考其 Transport。优先寻找目标 Agent 的原生 SDK、RPC 或其他原生接口。

### DeepSeek Harness

DeepSeek Harness 最适合参考服务化 Host 接入：

- 一个连接承载多个 Session；
- Session 订阅和 Mux 路由；
- 原生 Approval/Question RPC；
- 分页读取完整历史；
- 原生 Model/Thinking 目录与选择；
- 显式注册的 Harness Commands 和原生 compaction；
- 基于 `turn/end` Checkpoint 的同 cwd 精确 Fork；
- Usage 基线和增量合并。

当前它不支持跨 cwd Fork、rollback、Permission Mode 或 Subagent。不要从它推断这些能力可以省略；应根据目标 Harness 的原生能力决定。

## 公共契约的核心语义

以下是导航摘要；实现时读取 [public-adapter-contract.md](public-adapter-contract.md)、[thread-lifecycle-and-history.md](thread-lifecycle-and-history.md) 和 [output-and-interactions.md](output-and-interactions.md)。

新增 Adapter 至少要明确以下语义，而不仅是满足 TypeScript 类型：

- `inspect()` 不创建用户 Session，并准确返回 ready、notInstalled、unavailable 或 error。
- 能力声明与实际 `open()` / `execute()` 行为一致。
- Session 一次只接受一个互斥操作；冲突返回 `sessionBusy`。
- Turn 被接受前不发任何生命周期事件。
- 被接受的 Turn先发 `turn.started`，所有 Item 和 Interaction 必须在唯一的 `turn.completed` 前结束。
- Session fault 前先终结活动 Turn 和 Interaction。
- `readSnapshot()` 是只读操作，不发送输入、不创建 Turn、不重放历史事件。
- 成功 Turn 提供稳定 `NativeTurnRef`；支持 Fork 时提供匹配的 Checkpoint。
- Native Session identity 必须稳定；建立后不可在同一 Session 中切换。
- 配置写入只有在原生系统确认成功后才发布 `session.state.changed`。
- Usage 事件是完整替换值，不是未声明的字段增量。
- `outputs` 只有一个消费者；`close()` 应幂等并关闭原生资源。
- 原生错误被转换为 `HarnessError`，诊断内容在暴露前清理敏感值。

## 当前特殊接线

注册、发布和验证细节见 [registration-and-validation.md](registration-and-validation.md)。以下行为目前不完全属于 `HarnessAdapter` 类型，但新增 Harness 时仍需检查：

- Claude Code 和 Grok 暴露 `credits()`，Host 通过结构检查读取 Credits。
- Harness Commands 通过可选的 `session.commands` 暴露。
- `HarnessExecutionPolicy` 只在 create 时使用；当前 delegation 请求 `unattended-full-access`。Adapter 可以映射为原生非交互执行配置，也可以在已验证的原生执行基线天然满足时明确接受而不传额外参数；无法保证时返回类型化错误。Pi 属于无需权限参数的 deliberate no-op，OMP、Claude Code、Grok 和 DeepSeek 使用各自原生权限机制。
- 所有 Session-open 路径都应传播 `OpenSessionInput.environment`；它不仅是进程基础环境，也承载跨 Harness 委派的私有 Runtime 信息。
- Harness ID、Transport Model、Adapter Map、Renderer Agent、Desktop Control 启用列表、Host Runtime 依赖和 release bundle 当前都是显式注册，不是动态插件发现。
- 显式 command、endpoint 或远程安装配置还可能分布在 `run-host-runtime.ts`、`officialEnvironment()`、SSH Remote Host、Launcher 和 npm launcher；只在目标 Harness 需要这些配置时接入，但必须覆盖所有实际运行模式。
- Account Credits 目前通过 Adapter 的可选 `credits()` / `refreshCredits()` 结构检查和 Renderer Agent 白名单接入，不属于 `HarnessAdapter` 正式能力声明；新 Harness 支持 Credits 时必须同时检查 Host 和 Renderer。
- `packages/host-runtime/src/app-server-host.ts` 的 `approvalServerName()` 维护 Approval 对话框中的 Harness 展示名；支持 Approval 的新 Harness 必须加入映射。

## 实施前的参考选择输出

开始编码前，Agent 应先给出一个简短参考计划，例如：

```text
Transport 基础：Pi RPC
History/Fork：Pi
Approval/Question：Claude Code
Subagent：不支持，明确声明
Delegation：cross-harness-delegation.md
Renderer：agent-selection-state.ts + versioned-renderer-adapter.ts + Picker/ownership/Settings
注册与发布：model-routing.ts + adapter-composition.ts + host-runtime package/release
```

如果目标 Harness 的原生能力与所有现有实现都不同，先记录语义差异，再设计 Adapter 内部 Transport seam；不要把差异泄漏为 Host Runtime 中的新 Harness 专用分支。
