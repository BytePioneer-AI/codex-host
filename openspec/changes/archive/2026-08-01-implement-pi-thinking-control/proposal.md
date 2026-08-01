## Why

codexhost 可以选择 Pi Model，但无法选择或恢复 Thinking 等级。逐目标 Model 启动临时 Pi 虽然能得到精确列表，却让 Draft Model 切换承担一次新的 RPC 进程冷启动；Pi 本身已经提供统一 Thinking 档位、Provider 映射和不支持档位的内部回退，因此该成本不符合本次仅面向 Pi 的产品范围。

## What Changes

- 为浏览器安全的 Harness Catalog 增加规范化 Thinking 选项和每个 Model 支持的选项 ID。
- Pi inspection 只启动一次临时 RPC，读取 `get_available_models` 及当前状态；reasoning Model 在 Draft Catalog 中获得 Pi 统一的 `off/minimal/low/medium/high/xhigh/max` 请求档位，非 reasoning Model 只获得 `off`。
- Draft Model 切换只使用内存 Catalog 同步解析请求并更新 carrier，不再为目标 Model 启动临时 Pi，也不在 codexhost 中计算实际档位；Composer控件在official prewarm clear完成后确认新状态。
- 在 Harness Session 能力及状态契约中增加 Thinking 选择和 Pi 报告的实际 Thinking；已有 Thread、首次 Turn、恢复和 Fork 继续读取 Native Session 状态。
- 增加仅限 Idle 状态的 `thinking.select` 命令和固定 Host 控制方法；Pi 独立完成档位回退和 Provider 参数映射，codexhost 只发送请求并投影状态。
- 将草稿 Pi Model 和 Thinking 请求绑定到精确的 Composer 创建请求，不使用进程全局状态。
- 将仅包含 Pi Model 的列表替换为 Codex 风格的 Model/Thinking 组合菜单，使用原生 token class 及 Adapter 提供的标签和选项。
- 当已安装的 Pi 缺少所需 Thinking RPC 命令时明确降级。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `harness-model-catalog`：增加规范化 Thinking 选项、每个 Model 的 Draft 请求选项、Session 实际状态和串行化 Thinking 选择语义。
- `shared-runtime-contracts`：增加浏览器安全的 Thinking Catalog/状态/选择请求 schema，并扩展检查和 Thread 状态响应。
- `registered-harness-routing`：通过所属 Harness Session 及其结构化能力分发 Thread Thinking 选择。
- `versioned-renderer-agent-routing`：将 Composer 作用域的 Thinking 请求绑定到 Pi 创建，并使用内存 Catalog 呈现 Codex 风格的 Model/Thinking 组合控件。
- `pi-model-routed-vertical-slice`：映射 Pi Model reasoning 元数据、Thinking 请求、Pi 内部回退、恢复、Fork 和 Clone 状态，不引入 Provider 特定的 Host 逻辑。

## Impact

受影响的包包括 `shared-contracts`、`harness-adapter`、`adapters/pi`、`protocol-core`、`host-runtime` 和 `renderer-extension`，以及针对性的包测试和开发状态文档。不需要新增运行时依赖或持久化 schema。Draft Catalog 只在当前进程内保存；Native Session 打开后，实际 Model/Thinking 仍由 Pi Session 状态拥有。
