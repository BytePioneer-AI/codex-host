## Why

`HarnessAdapter`设计基线已经预留`HostUsage`，Pi官方RPC也已确认提供`get_session_stats`，但当前生产契约、Adapter、Host和Codex UI投影尚未形成统一的当前上下文用量链路。若直接在Pi或Renderer中实现专用逻辑，后续Claude Code及其他Harness会重复状态、时序和协议适配；现在应沿用Paseo已验证的“具体Adapter采集原生事实、Manager/Host持有统一快照、UI只消费规范化投影”架构完成公共能力。

## What Changes

- 为`HarnessSession`增加可选、UI无关的Usage Telemetry快照和有序更新事件，规范化Token、成本及当前上下文窗口字段；只接受原生Harness可靠提供的有限非负数值，不增加原生payload逃逸口或按Harness分支。
- 定义Usage为Session级只读Telemetry：更新是完整最新快照，缺失表示未知而非零；它独立于`session.state.changed`、Turn生命周期和Transcript，不作为Mapping Store或第二份Native Session事实源持久化。
- 让Pi Adapter通过结构化RPC读取`get_session_stats`，在创建/恢复、稳定Turn终态、Compaction和配置改变后的有效边界刷新；仅对已验证的旧命令缺失回退到`get_state.contextUsage`，查询失败保留最近可靠快照且不得把成功Turn升级为Session Fault。
- 让通用External Thread Runtime像Paseo Agent Manager一样持有当前Usage快照，并通过Protocol Core投影为当前Codex app-server的`thread/tokenUsage/updated`通知；Host不得解析Pi字段，Adapter不得生成Codex协议对象。
- 使用当前官方生成Schema约束`total`、`last`和`modelContextWindow`载荷，并通过受控Desktop Gate证明External Thread使用Codex原生上下文窗口UI；结构或语义无法可靠映射时隐藏用量而不是伪造精确值。
- 增加Fake Harness契约测试、Pi RPC兼容/时序测试、双Fake Host隔离测试、Protocol Core投影测试，以及显式真实Pi和真实Desktop脱敏Gate。
- 独立借鉴Paseo的架构与行为，不复制其AGPL源码，不采用其持久化Timeline，也不照搬其首次恢复、手动Compact和异步刷新缺口。

## Capabilities

### New Capabilities

- `harness-session-usage-telemetry`: 定义跨Harness的原生Usage采集、Session有序快照、Pi实现、通用Host状态和Codex上下文窗口投影语义。

### Modified Capabilities

- `harness-adapter-text-session`: 扩展现有单一有序输出契约，使Session级Usage更新可与Turn输出共存且不改变Turn唯一终态。
- `registered-harness-routing`: 要求所有已注册外部Harness复用同一Usage状态和Protocol投影路径，禁止Pi专用Host分支或未注册Harness回落Codex。
- `pi-model-routed-vertical-slice`: 要求Pi从当前Native Session结构化统计读取Usage，并在创建、恢复、Turn、Compaction及Model变化边界保持当前快照。
- `versioned-renderer-agent-routing`: 要求受支持Desktop对External Thread复用原生上下文窗口展示，并对缺失、陈旧或不完整Telemetry fail closed。

## Impact

- 公共接口：`packages/harness-adapter`的Usage类型、`HarnessSession`初始Telemetry和`HarnessOutput`事件联合。
- 具体Adapter：`packages/adapters/pi`的RPC统计解析、兼容回退、刷新调度和历史/恢复边界；未来Adapter只实现相同Usage producer语义。
- Host与协议：`packages/host-runtime`的External Thread最新Usage状态、恢复与事件消费；`packages/protocol-core`的Codex Token Usage投影。
- Renderer与Desktop：优先复用Codex原生`thread/tokenUsage/updated`消费面，仅增加必要的受控验证，不新增第二个上下文表盘或通用Renderer请求通道。
- 持久化：Mapping Store格式不变，不保存Usage、成本或上下文历史；冷恢复从Native Session重新读取。
- 依赖与许可：不新增运行时依赖；`reference/paseo`仅用于架构对照且保持Git忽略。
