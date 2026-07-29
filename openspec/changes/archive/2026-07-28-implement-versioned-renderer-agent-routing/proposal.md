## Why

当前页面 Agent 选择可以在 Composer 提交时稳定捕获，但真实 `thread/start` 仍携带官方 Model 并进入 Codex。当前 Desktop 没有公开 Model setter，因此需要按当前版本维护的 Renderer Adapter，把锁定的 Agent 选择写入同一次创建请求，关闭 UI 到真实 Pi Agent Loop 的缺失链路。

## What Changes

- 新 Thread 首次输入前锁定 Composer Agent；锁定后只能通过新建 Thread 选择其他 Agent。
- 为当前已验证 Codex Desktop build 实现结构签名校验、版本锁定且 fail-closed 的 Renderer Adapter。
- 通过当前 Composer 的 optimistic Model atom 让 Pi 创建使用内部 `codexhost/pi-native` transport token；Codex 恢复不透明官方状态。
- 通过主进程 metadata service 的直接窗口归属阻止 Pi 自动标题进入 Codex ephemeral Thread，并使用现有本地 fallback。
- 使用匿名 create ordinal 验证全部 conversation `thread/start` carrier及最终 `turn/start` 归属。
- 识别最终承载首个 `turn/start` 的预热 Thread，并有界关闭未消费的 Pi 预热 Session。
- 版本、结构、Composer归属或绑定不明确时阻止 Pi 创建，不静默回落 Codex。

## Capabilities

### New Capabilities

- `versioned-renderer-agent-routing`: 当前 Codex Desktop版本中 Composer Agent锁定、创建请求装饰、Host路由确认和预热资源收敛。

### Modified Capabilities

## Impact

- `packages/renderer-extension`: Composer锁定状态、版本 Adapter和注入入口。
- `packages/desktop-control`: Adapter安装与兼容性诊断。
- `packages/protocol-core`、`packages/host-runtime`: transport route验证及未消费预热 Thread清理。
- `tools/renderer-binding`: transport-only和真实 Pi受控验证。
- 当前实现依赖官方 Renderer私有结构，必须按 Desktop版本维护兼容性签名。
