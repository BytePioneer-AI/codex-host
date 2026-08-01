## Why

codexhost 可以选择 Pi Model，但无法发现、选择或恢复当前 Model 实际支持的 Thinking 等级。现在补齐这一能力，可以解决原生 Agent 配置的剩余缺口，同时继续由 Pi 作为 Model 特定 Thinking 能力和生效状态的权威。

## What Changes

- 为浏览器安全的 Harness Catalog 增加规范化 Thinking 选项和每个 Model 支持的选项 ID。
- 在 Harness Session 能力及状态契约中增加 Thinking 选择和 Pi 确认的生效 Thinking 选项。
- 增加仅限 Idle 状态的 `thinking.select` 命令和固定 Host 控制方法；命令结果仍只表示完成，生效状态来自有序 Session 输出流。
- 读取 Pi 可用的 Thinking 等级和当前 `thinkingLevel`，只通过 Pi RPC 设置等级，并在 Thinking 或 Model 变更后发布 Pi 的回读状态。
- 将草稿 Pi Model 和 Thinking 选择绑定到精确的 Composer 创建请求，不使用进程全局状态。
- 将仅包含 Pi Model 的列表替换为 Codex 风格的 Model/Thinking 组合菜单，使用原生 token class 及 Adapter 提供的标签和选项。
- 对不支持的 Thinking 控件进行隐藏或禁用；当已安装的 Pi 缺少所需 RPC 命令时明确降级。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `harness-model-catalog`：增加规范化 Thinking 选项、每个 Model 的可用性、生效状态和串行化 Thinking 选择语义。
- `shared-runtime-contracts`：增加浏览器安全的 Thinking Catalog/状态/选择请求 schema，并扩展检查和 Thread 状态响应。
- `registered-harness-routing`：通过所属 Harness Session 及其结构化能力分发 Thread Thinking 选择。
- `versioned-renderer-agent-routing`：将 Composer 作用域的 Thinking 绑定到 Pi 创建，并使用确认状态呈现 Codex 风格的 Model/Thinking 组合控件。
- `pi-model-routed-vertical-slice`：映射 Pi RPC 的 Thinking 发现、选择、Model 相关修正、恢复、Fork 和 Clone 状态，不引入 Provider 特定的 Host 逻辑。

## Impact

受影响的包包括 `shared-contracts`、`harness-adapter`、`adapters/pi`、`protocol-core`、`host-runtime` 和 `renderer-extension`，以及针对性的包测试和开发状态文档。不需要新增运行时依赖或持久化 schema；Native Session 打开时从 Pi 恢复当前生效 Thinking，草稿 Thinking 则在创建前保持请求作用域。
