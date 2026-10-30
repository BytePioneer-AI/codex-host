# Qwen Code 原生 Harness

`qwen-code` 插件通过官方 `@qwen-code/sdk` 的 `query()` 接口连接目标 Host 安装的 Qwen Code CLI。实现、原生事件投影和 SDK 依赖位于 `packages/adapters/qwen-code`；Host/Renderer 只使用公共插件目录与 Thread 契约，没有 Qwen 专用注册分支。当前验收基线为 SDK `0.1.26`、CLI `0.26.3`。

## 安装与发现

插件 Manifest 提供 `npm install -g @qwen-code/qwen-code@latest` 安装指引。运行时使用公共 `@codexhost/harness-discovery` 查找 `qwen`；显式路径通过 `CODEXHOST_QWEN_COMMAND` 指定，缺失或不可执行返回 `notInstalled`。

SDK 需要 JavaScript 入口或原生可执行文件，不能直接使用 Windows npm 的 `.cmd` 包装器。Windows 上 `qwen.cmd` 会解析为同目录 `node_modules/@qwen-code/qwen-code/cli-entry.js`，由 SDK 使用 codexhost 的 Node Runtime 启动。工厂环境与每次 open 的 environment 合并，Session 覆盖优先；委派环境的 `CODEXHOST_DELEGATION_THREAD_ID` 随 create/resume 传给原生 CLI。

## 检查、会话与配置

每次 Session 使用一个 SDK Query。`inspect` 创建临时 Query 读取模型目录后立即关闭；结果按规范化 cwd 缓存，`refresh` 跳过缓存。create 使用 SDK 生成的 `sessionId`，resume 使用持久 Native Session ID 的 `resume`；最终身份以 Query 初始化后的 `getSessionId()` 为准。

模型目录来自 `getAvailableModels()` 与 `getContextUsage()`：`currentModelId` 优先采用已选择且仍可用的模型，其次采用原生上下文报告，最后取目录第一项。打开 Session 后、首个 Host Turn 前会通过 `setModel()` 固定该选择。Qwen Code 不提供 Thinking 档位，Adapter 不声明 `selectThinkingOption`。

权限模式保留原生 `plan`、`default`、`auto-edit`、`auto`、`yolo`。实时切换通过 `setPermissionMode()`。无人值守执行必须使用 `yolo`：隐式 `unattended-full-access` 请求选择 `yolo`，显式较低权限模式被拒绝，而不是打开降级 Session。

## Turn、交互与输出

一次用户输入对应一个 SDK Prompt；流式 `content_block_delta` 投影为 Agent 文本与 Reasoning，`assistant` 的 `tool_use` 和 `user` 的 `tool_result` 投影为公共 Tool Item。Result 消息的 Usage 合并到会话累计用量。`canUseTool` 映射为公共 Approval；`ask_user_question` 映射为公共 Question，答案以 `answers` 写回原生输入。取消调用 `interrupt()`，并拒绝所有待处理交互；关闭有超时上限，不能无限等待原生进程。

Qwen Code 当前不支持同 Turn steering、Fork、最后一轮回滚、上下文压缩和原生命令目录；Adapter 对这些请求返回公共 `unsupported` 或省略对应 capability。`turn.steer` 明确拒绝，由 Host 按停止当前 Turn 后新开一轮处理。

本集成不声明 Edit Diff / 文件变更投影：原生工具输出保留在 Tool Item 中，不根据路径或文本猜测 Diff。

## 历史与身份

resume 时只读解析 Qwen 运行目录中的 JSONL Transcript：默认 `~/.qwen`，可用 `QWEN_RUNTIME_DIR` / `QWEN_HOME` 覆盖，布局为 `projects/<sanitized cwd>/chats/<sessionId>.jsonl`，并回退到 `archive/`。解析结果重建完整 Host Snapshot；用户消息合并边界、工具调用与结果、Reasoning 和 Agent 文本按原生记录还原。

Native Turn key 使用持久 Turn ordinal（`qwen-turn-<n>`），恢复时保留已知 Native Turn Ref 并延续序号，不清除已持久化映射。Snapshot 来自原生 Transcript，而不是 Adapter 内存中的第二份历史。

## 边界与验证

未声明或明确不支持：History Fork、跨 cwd Fork、最后 Turn 回滚、Turn Steering、Thinking 选择、原生 Slash 命令、上下文压缩、Edit Diff、全局用量统计读取器。

聚焦测试覆盖 SDK 消息投影、模型与权限模式映射、Transcript 恢复、工具输出截断、Usage 合并、会话关闭与故障语义。真实 CLI `0.26.3` 冒烟验证了 inspect 模型目录、create、回传 `QWEN_SDK_OK`、Transcript 重建 `qwen-turn-0`、resume 续轮和回传 `QWEN_RESUME_OK`；完整 Desktop UI、远程 Host 与 Windows 实机安装仍需单独验收。
