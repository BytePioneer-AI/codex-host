## Why

Claude Code的官方Agent SDK已经提供稳定的当前上下文用量读取，但开发开关下的Claude Adapter仍不发布Usage，导致它无法复用现有Codex原生上下文表盘。当前projector还把Session累计Token作为投影前置条件，尽管表盘carrier只需要当前上下文用量和窗口大小。

## What Changes

- Claude Code Adapter在活动SDK Query的Turn终态后读取结构化当前上下文用量，并发布所有可可靠映射的`HostUsage`字段。
- Claude Usage读取保持可选且失败隔离，不改变lazy open、Turn outcome、Session health或close。
- Protocol Core允许可靠context pair在缺少Session累计Token时驱动Codex原生Usage通知；Codex协议必填aggregate breakdown使用明确的零值carrier占位，且不回写`HostUsage`。
- 增加Hermetic Adapter、SDK transport和Protocol projector测试；普通检查不启动Claude Code。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `claude-code-text-session`: 增加稳定SDK上下文用量采集、Turn后发布和失败隔离语义。
- `harness-session-usage-telemetry`: 允许只有可靠context pair的快照构造Codex上下文表盘carrier，而不要求Harness提供Session累计总量。

## Impact

影响`packages/adapters/claude-code`的私有transport与Session实现、`packages/protocol-core`的Codex Usage projector、对应Vitest测试和两份主spec的delta。Host、Renderer、Mapping Store、公开Claude启用范围和依赖版本不变。
