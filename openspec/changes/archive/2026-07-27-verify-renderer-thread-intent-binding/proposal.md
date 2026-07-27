## Why

codexhost 需要先证明一个最小且真实的事实：用户在 Codex UI 为当前新会话选择 Harness 后，Renderer 能把该选择写入本次真实创建 Request，Host 能据此决定请求继续进入官方 Codex，还是改由本地 Pi 处理。此前 Gate B 把多 Composer 并发、完整草稿状态机、公共契约提升和发布级证据都作为前置条件，超过了关闭这一技术事实所需的范围。

## What Changes

- 复用 Gate A 已验证的 Desktop 启动、Shim 和官方 CLI 定位能力，为真实 Codex Renderer 增加最小 direct CDP 注入和 Gate-only app-server Observer；已有 Codex Desktop 可以由测试停止、终止或按本次配置重启，不构成自动阻塞。
- 在当前 Renderer 注入 Codex/Pi 测试选择控件；选择只表示当前活动 Composer 下一次新会话创建所用的 Harness。
- 动态确认当前 Desktop 中一个可以在发送前修改真实创建参数的 Renderer seam，并把 Gate-local `harnessId` 写入同一个真实创建 Request。
- Observer 在官方转发前读取并移除 Gate 扩展：Codex 选择继续透明转发，Pi 选择在进入官方 Codex app-server Agent Loop 前被受控拦截。
- 真实 Gate 只验证当前活动 Composer 的串行创建、发送前最终选择和失败后的再次尝试；不要求两个 Composer 同时创建、Response 反序、synthetic cwd 归属或完整 Thread 生命周期。
- Gate B 不提升 Shared Contracts，不实现正式 Agent 选择器、Pi 对话、Thread 映射、Protocol Core、Mapping Store 或发布级恢复。真实 Codex/Pi 对话由紧随其后的最小垂直链路实现。

## Capabilities

### New Capabilities

- `renderer-thread-intent-binding-probe`: 验证当前 Codex Renderer 的 Harness 选择能够随本次真实创建 Request 到达 Gate Observer，并让 Observer 在官方 Codex Agent Loop 前做出 Codex/Pi 路由判定。

### Modified Capabilities

无。

## Impact

- 收敛 `tools/gate-b/`：保留最小 CDP、Renderer 注入、Request 观察和真实验证，删除或简化多草稿注册表、synthetic cwd 归属、复杂 Capture 审批和五场景报告逻辑。
- Gate A Shim 仍只在显式 Gate B 的 app-server 调用中进入 Observer，其他官方 CLI 调用保持透明。
- `packages/shared-contracts` 不由本 change 修改；正式 Host 垂直链路根据真实调用方再定义最小公共契约。
- Paseo 仅提供“发送时读取当前选择”的行为参考；CodexPlusPlus 仅提供 direct CDP、动态模块加载和 Renderer 请求包装的行为参考，不复制其 AGPL 代码。
