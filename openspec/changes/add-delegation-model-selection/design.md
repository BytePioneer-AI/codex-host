## Context

Delegation 当前只传递目标 Harness、任务、cwd 和父 Thread。外部 Harness 的公共 `HarnessAdapter` 已提供 `inspect()` 返回统一 `HarnessInspection`，`open({kind: "create"})` 已接受 `model` 与 `thinkingOptionId`；各 Adapter 负责把 opaque Model Ref 和统一 Thinking ID 转成原生协议。原生 Codex 不经过该 Adapter seam，而是由 `OfficialRequestBroker` 代理官方 `model/list` 和 `thread/start`。

当前省略配置时，各目标使用自身当前或默认 Model/Thinking。新增能力必须保持这一语义，不得由 Host 猜测或硬编码默认型号。

## Goals / Non-Goals

**Goals:**

- 统一发现原生 Codex 和外部 Harness 可用 Model、默认 Model、Thinking 选项与选择能力。
- 允许 `delegate start` 显式选择 Model 和 Thinking/Effort。
- 未指定某项配置时继续省略该项，让目标使用自身默认值。
- 返回请求配置和 Session 实际生效配置。
- 使外部 Thread 持久化的 transport selection 与实际创建配置一致。
- 保持公共 Adapter seam，新 Harness 不增加 Delegation 专用分支。

**Non-Goals:**

- 不开放 Permission Mode 选择；委派仍固定使用无人值守执行策略。
- 不实现已有 Thread 的运行时 Model 切换或 `thread configure`。
- 不实现 Interaction 回复、图片/文件输入或预算控制。
- 不维护静态跨 Harness Model 清单，也不把不同 Harness 的 Model 名称标准化成同一产品概念。

## Decisions

### 使用 `codexhost harness inspect <harness>` 暴露公共发现能力

控制面增加 Harness inspection 操作，外部 Harness 直接调用注册 Adapter 的 `inspect({cwd, refresh})`。响应保留公共 Catalog 的 opaque Model Ref、展示标签、默认 Model、Thinking Options、每个 Model 支持的 Thinking 以及 configuration capabilities。

该命令属于 Harness 能力发现，而不是 Thread 操作，因此不命名为 `delegate models` 或 `thread inspect`。

### `delegate start` 使用可选 Model 与 Thinking 参数

CLI 增加：

```text
--model <opaque-model-ref>
--thinking <option-id>
```

控制类型使用已有 `HarnessModelRef` 和 `HarnessThinkingOptionId`，外部 Coordinator 将其直接传给：

```ts
adapter.open({ kind: "create", model, thinkingOptionId })
```

调用方未指定 Model 或 Thinking 时，对应字段 MUST 保持 `undefined`，不得从 inspection Catalog 主动填入默认值。这样维持当前由目标 Harness 选择默认配置的行为，也避免 Catalog 默认与 Session 实际默认之间产生第二真相源。

### 仅在显式配置时执行强校验

显式 Model/Thinking 请求先通过 Adapter inspection 验证：Harness ready、能力支持、Model 存在、Thinking 存在且被所选或默认 Model 支持。未指定配置时不为验证而强制 inspection，避免增加默认委派启动时延；实际默认值由创建后的 `session.initialState` 或后续状态事件回读。

Adapter `open` 仍是最终权威校验，防止 Catalog 与创建之间发生变化。

### 原生 Codex 使用独立官方投影

原生 Codex inspection 通过 `OfficialRequestBroker.request("model/list", {})` 获取官方 Catalog，并投影成与 CLI 稳定响应兼容的 Model/Thinking 结构。显式 Model 传给官方 `thread/start.model`，首个 Turn 同时通过 `turn/start.model` 与 `turn/start.effort` 应用 Model 和 Thinking；未指定时省略对应字段。

官方协议形状由现有 fixture/gate 证据和聚焦测试约束，不把原生 Codex 强行包装成外部 `HarnessAdapter`。

### 返回 requested 与 effective 配置

Start 结果增加可选 configuration：requested 字段只反映调用方显式输入；effective 字段来自外部 Session state 或官方创建响应。目标没有立即回报实际配置时允许 effective 字段缺省，但不得用 requested 值冒充已确认状态。

### 外部 Thread 使用 transport selection 持久化

显式选择通过 `encodeExternalTransportSelection()` 写入 Thread record 的 `transportModelId`。Session 初始状态确认后，沿用现有状态投影和记录更新逻辑保存实际选择。未指定时继续使用 Harness 基础 transport Model ID。

### 配置参与委派幂等身份

隐式去重摘要加入规范化 cwd、Model Ref 和 Thinking ID。显式 Request ID 若已关联相同 Harness 但配置或任务不同，返回 `INVALID_ARGUMENT`，而不是复用配置不一致的既有 Thread。现有 `taskDigest` 字段升级为任务与创建配置的稳定请求摘要，不增加新的持久化字段，也不保存展示标签。

## Risks / Trade-offs

- [inspection 结果在 Session 创建前变化] → inspection 提供可执行错误，Adapter `open` 保留最终校验。
- [部分 Harness 没有 Thinking 能力] → 通过 capabilities 和结构化合法值返回明确错误；省略 Thinking 时正常使用默认。
- [原生 Codex `model/list` 或 Reasoning 字段变化] → 隔离在官方投影函数并使用 fixture/gate 聚焦验证。
- [显式选择增加启动延迟] → 仅显式指定 Model/Thinking 时强制 inspection；默认路径不变。
- [effective 配置异步才可得] → 响应只返回已确认字段，后续通过 `thread read` 或状态投影补充，不伪造值。
- [旧记录的摘要只覆盖任务文本] → 旧记录仍可读取；新请求使用任务与配置摘要，显式 Request ID 仅按各记录实际保存的摘要执行冲突检查。
