## Why

Claude Code Thread 为了实时展示 Usage，在 Assistant、Tool 和 Turn 边界反复调用重量级 `getContextUsage()`；该调用会在 Claude Code 内部展开为多次远程 `count_tokens` 请求，并因成功后继续重试而形成请求风暴。需要改为优先消费正常模型响应携带的原生 Usage，在保持长 Turn 内实时反馈的同时，避免后台统计影响性能、限流和第三方网关成本。

## What Changes

- Claude Code Adapter 在每次原生模型响应完成后，使用该响应携带的 input、output、cache read/write 和实际 Model 信息，实时更新当前上下文、最新缓存命中率和 Session 费用估算。
- 工具本地执行完成时不主动刷新 Usage；工具结果进入下一次模型请求后，由新的原生 Usage 自然更新页面。
- Turn 完成时使用 Claude Code 原生 Result 的累计 Token 和费用校准当前 Session 快照。
- 移除 Assistant、Tool 和 Turn 生命周期边界上的自动 `getContextUsage()`；精确 Context 统计仅由用户主动查看或刷新详情触发。
- 按需精确刷新必须合并并发请求、使用短期缓存和失败冷却，并在成功后立即停止重试。
- 多个 Claude Session 的 Context、Token、费用估算和请求去重状态必须按 Session 隔离；仅账号级 5 小时/7 天额度可跨 Session 共享。
- Usage 和实时估算保持内存态，不写入 Mapping Store；恢复后重新从 Claude 原生 Session 获取可靠数据。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `claude-code-text-session`: 改为在 Turn 内消费原生模型响应 Usage，实时合并 Session 费用估算，并在 Turn Result 到达后校准；昂贵 Context 读取改为按需执行。
- `harness-session-usage-telemetry`: 明确可靠原生请求 Usage 可在活动 Turn 内驱动实时快照，并要求临时估算按 Session 隔离、仅驻留内存且不影响生命周期。
- `renderer-thread-usage-surface`: 用户打开 Usage 详情时可触发一次按需精确刷新，同时继续立即展示已有缓存快照并拒绝过期结果。

## Impact

- `packages/adapters/claude-code`：扩展原生 Assistant Usage 事件、Session 内实时估算与去重、Turn 终态校准、按需 Context 刷新和相关测试。
- `packages/harness-adapter` 与 `packages/shared-contracts`：如需表达按需刷新语义，扩展最小且浏览器安全的 Usage 请求契约。
- `packages/host-runtime`：路由缓存读取与显式精确刷新，保持 Thread 归属和 Session 隔离。
- `packages/renderer-extension`：在用户打开或手动刷新 Usage 详情时发起精确刷新，并异步更新当前 Thread 的 Popover。
- Mapping Store、Thread/Native Session 映射和账号凭据存储保持不变；不升级 Claude Agent SDK。