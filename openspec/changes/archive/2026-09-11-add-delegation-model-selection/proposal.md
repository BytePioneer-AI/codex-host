## Why

当前跨 Harness 委派只能选择目标 Harness，不能发现或显式选择目标 Model 与 Thinking/Effort。底层公共 Harness Adapter 已具备 Catalog 检查和创建时配置能力，因此需要把这些能力统一暴露到 Delegation 控制面和 CLI，同时保持未指定配置时继续使用目标 Harness 当前默认行为。

## What Changes

- 新增 `codexhost harness inspect <harness>`，通过统一控制面返回目标 Harness 的可用 Model、默认 Model、Thinking 选项及配置能力。
- 扩展 `codexhost delegate start`，支持可选 `--model <opaque-ref>` 与 `--thinking <option-id>`。
- 外部 Harness 统一通过 `HarnessAdapter.inspect()` 发现配置，并通过 `HarnessAdapter.open({model, thinkingOptionId})` 创建 Session。
- 原生 Codex 通过官方 `model/list` 发现 Model，并在 `thread/start` 中传递显式 Model 与 Thinking/Effort。
- 未指定 Model 或 Thinking 时不人为填充选择值，继续由目标 Harness 或原生 Codex 使用其当前默认配置。
- 返回请求配置与实际生效配置，并将外部 Thread 的 Model/Thinking transport selection 持久化。
- 将显式 Model/Thinking 与 cwd 纳入委派去重和 Request ID 一致性摘要，避免不同配置被错误复用。

## Capabilities

### New Capabilities

- `delegation-target-inspection`: 通过 CLI 和 Runtime 控制面发现原生 Codex及已注册外部 Harness 的 Model、Thinking 与配置能力。

### Modified Capabilities

- `harness-model-catalog`: 将公共 Harness Catalog 用于 Delegation 的配置发现、合法性验证和默认配置语义。
- `registered-harness-routing`: 委派创建时可将显式 Model 与 Thinking 传递给统一 Harness Adapter，同时保持省略配置时的默认行为。

## Impact

- `packages/host-runtime`：Delegation 类型、CLI、loopback server、Registry、Coordinator、原生 Codex gateway、快照和测试。
- `packages/protocol-core` / `packages/shared-contracts`：复用现有 Model Ref、Thinking Option 和 transport selection 合同；如需仅增加最小公共投影类型。
- `packages/mapping-store`：复用现有 `taskDigest` 字段保存任务与配置的稳定请求摘要；外部 Thread 继续通过既有 transport selection 持久化 Model/Thinking。
- `crates/launcher`、npm release 包装和内置 Delegation Skill：新增帮助与命令转发说明。
- 各外部 Adapter 不新增委派专用实现，继续复用公共 `inspect/open` seam。
