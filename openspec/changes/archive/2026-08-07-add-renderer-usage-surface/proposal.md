## Why

Pi 的 Host Usage 已经能够获得最近一次缓存命中率和累计成本，但这些数据目前停留在 Host 链路，用户无法在 Codex Desktop 的当前线程中观察。需要一个低侵入的实时状态入口，让用户在不改变原生上下文圆圈语义的前提下看到 Usage。

## What Changes

- 在 Composer 底部工具栏的原生上下文圆圈左侧增加 codexhost 自有 Usage 控件。
- 在控件折叠状态显示最近一次缓存命中率和累计估算成本，例如 `CH 99.9% · $0.168`。
- 点击控件显示当前上下文、缓存 Token、输入输出 Token 和 Session 成本等可用字段。
- 为已有 External Thread 增加受限的 Usage 快照读取，使 Renderer 能初始化和刷新当前线程显示。
- Usage 缺少可靠字段时隐藏对应展示，不用零值或估算值填充。
- 保持 Codex 原生上下文圆圈、原生 Token Usage 通知和 Mapping Store 不变。

## Capabilities

### New Capabilities

- `renderer-thread-usage-surface`: 定义 Renderer 中线程级 Usage 控件的布局、快照读取、刷新和数据范围语义。

### Modified Capabilities

- `harness-session-usage-telemetry`: 增加 Host 对 Renderer Usage 快照查询的受限投影要求，同时保留 Usage 事实来源和生命周期边界。

## Impact

- 影响 `packages/shared-contracts` 的浏览器安全 Usage 快照与 Thread inspection contract。
- 影响 `packages/host-runtime` 的 External Thread inspection 响应和受限 Usage 查询/投影。
- 影响 `packages/renderer-extension` 的 Composer 控件、Thread ownership 恢复和 Usage 刷新状态。
- 不增加第三方依赖，不修改原生上下文圆圈，不持久化成本或 Usage 历史。
