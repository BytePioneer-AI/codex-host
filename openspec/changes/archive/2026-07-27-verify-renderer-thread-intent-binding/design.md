## Context

Gate A 已证明 Codex Desktop 可以通过 Shim 透明使用当前安装对应的官方 app-server，Gate C 已证明本地 Pi RPC 能执行 Agent Loop。当前尚缺的事实是：Codex Renderer 中的 Harness 选择能否在用户首次发送时到达 codexhost，使 Host 有机会在 Codex 和 Pi 之间路由。

Paseo 拥有自己的 Composer 源码，因此可以在 submit callback 中直接读取当前 Provider、Model 和 cwd。codexhost 不拥有 Codex Renderer 源码，但可以借鉴这一语义：发送动作发生时读取当前选择，不提前创建 Session，也不在发送后猜测归属。

CodexPlusPlus 证明了当前 Codex Desktop 可以通过 direct CDP 注入脚本、动态加载 Renderer chunk，并包装 dispatcher、app-server client `sendRequest`或 `electronBridge.sendMessageFromView`。codexhost 只参考这些行为事实并独立实现，不复制 AGPL 代码。

本 change 只关闭下面这条链路：

```text
当前 Renderer 的 Codex/Pi 选择
→ 当前活动 Composer 首次发送
→ 真实创建 Request 携带 Gate-local harnessId
→ Gate Observer 读取并移除扩展
→ Codex 继续官方路径，Pi 在官方 Agent Loop 前停止
```

Pi 的实际执行和事件投影属于紧随 Gate B 的最小垂直链路，不在本 change 实现。

## Goals / Non-Goals

**Goals:**

- 允许测试管理当前正在运行的 Codex Desktop，并在需要时停止、终止或按 Gate 配置重启。
- 在真实 Codex Desktop 中注入一个最小 Codex/Pi 选择控件。
- 发送时读取当前 Renderer 的最终 Harness 选择。
- 动态确认一个可在发送前修改真实创建参数的 Renderer seam。
- 让同一个真实创建 Request 携带 Gate-local `harnessId`并到达 Observer。
- 证明 Codex 选择保持官方行为，Pi 选择不会进入官方 Codex Agent Loop。
- 基于真实调用形状给后续最小 Host/Pi 垂直链路提供实现事实。

**Non-Goals:**

- 不验证两个 Composer 或两个窗口同时创建。
- 不实现 per-Composer draft registry、synthetic cwd 归属、歧义匹配或 Response 反序场景。
- 不实现正式 Agent UI、Pi Agent Loop、事件投影、Thread 映射或持久化。
- 不提升 Shared Contracts，不建设完整 Protocol Core、Host Runtime 或 Mapping Store。
- 不建立通用 CDP 框架、Playwright 控制路径或多层运行时 fallback。

## Decisions

### 1. 已运行 Desktop 不阻塞真实 Gate

Gate 启动前可以检测并记录当前 Codex Desktop PID，然后停止或强制终止该实例，再用本次 Shim/CDP 参数启动测试实例。若当前实例已经具备本次测试所需的 CDP endpoint、Shim/Observer配置且身份可确认，也可以直接复用。实例存在本身不得产生 `BLOCKED`。

Gate 结束时清理本次启动或接管的测试进程。测试不修改官方安装、`app.asar`或用户级/系统级全局环境。

### 2. 当前 Harness 选择是 Renderer UI 状态

Gate 控件在当前 document 内保存：

```text
selectedHarness = codex | pi
```

这不是长期 Thread 路由事实，只表示当前活动 Composer 下一次新会话创建的选择。用户切换选择不创建 Thread、不启动 Pi，也不发送独立业务消息。发送发生时 wrapper 读取最终值；document 重载后恢复明确默认值。

正式产品在创建完成后必须使用 `Thread → Harness`映射路由后续消息，不能继续依赖页面当前选择。该映射不由 Gate B 实现。

选择窗口级状态是对当前 MVP 交互事实的直接表达。若未来真实 UI 支持同一 Renderer 内多个可独立同时提交的 Composer，再根据实际 DOM/module identity 增加隔离，而不是在当前 Gate 预先建设注册表。

### 3. 选择随本次真实创建 Request 传递

注入代码在已确认的创建 seam 调用原函数前，为参数增加 namespaced Gate 字段，例如：

```json
{
  "method": "thread/start",
  "params": {
    "cwd": "/project",
    "codexhost": {
      "harnessId": "pi"
    }
  }
}
```

确切 Method 和字段位置由真实 Capture 决定。字段是 Gate-local carrier，不是最终公共契约。

CDP 只安装代码和执行健康检查，不单独发送 Harness 业务 Intent。这里不需要 `CreateRequestId`、Composer ID 或跨通道 join，因为选择在创建调用执行时同步写入该调用的参数。

### 4. 优先选择能修改真实参数的最浅可靠 seam

正确 seam 不要求“最内层”。选择标准是：

1. 当前 Desktop 可以通过注入稳定取得；
2. 能识别新会话创建调用；
3. 能在调用原函数前同步修改将继续传播的参数；
4. 非创建调用保持不变。

候选优先级由动态 Capture 决定，可能是 `AppServerRequestService.sendRequest("start-conversation", params)`、app-server client `sendRequest`、dispatcher 或低层 bridge。正式 Gate 只启用一个已确认 seam；Capture 可以观察候选，但不能把多个 hook 作为产品 fallback。

如果字段在后续 bridge 中被丢弃，Gate 报告 `FAIL`并根据实际调用形状调整 seam。不得改用 cwd、焦点、时间窗口、FIFO或调用顺序推测来源。

### 5. Observer 只验证路由判定

Shim 仅在显式 Gate B 配置且首个子命令为 `app-server`时启动 Node Observer。Observer：

- 读取目标创建 Request 的 `harnessId`；
- 在任何官方转发前移除 Gate 扩展；
- Codex 选择继续官方 app-server；
- Pi 选择不作为普通 Codex 创建/Turn 进入官方 Agent Loop；
- 记录不含 Prompt、Transcript、真实 ID 或凭据的最小结果。

Gate B 不需要为了取得一个官方 Thread ID 而让 Pi 选择先创建影子 Codex Thread。真实 Pi Thread 身份和 Codex UI 所需 Host Thread ID 由后续垂直链路设计。

### 6. Gate 结论保持窄

真实 Gate 执行两次串行尝试：

1. 选择 Codex 并创建，确认官方行为仍可用；
2. 选择 Pi 并创建，确认真实 Request 携带 Pi 且在官方 Agent Loop 前停止。

结论：

- `PASS`：两条路径都满足上述事实；
- `FAIL`：真实创建发生，但发送时选择没有随 Request 到达 Observer，或 Pi 进入了官方 Codex Agent Loop；
- `BLOCKED`：停止/重启 Desktop 后仍无法启用 CDP、Renderer 注入、可修改 seam 或受控人工操作。

`PASS`不表示 Pi 已执行，也不表示 Thread 映射、恢复、并发和发布稳定性已经完成。

## Risks / Trade-offs

- [页面级选择未来无法覆盖同一 Renderer 多 Composer] → 当前 MVP 只支持当前活动 Composer 串行创建；出现真实产品需求后再以实测 identity 扩展。
- [Codex 私有 module/seam 随版本变化] → Capture 当前版本的实际 seam，安装时健康检查；失败时报告兼容错误，不预建多层 fallback。
- [未知字段被中间 bridge 删除] → 在更接近有效创建参数的已观察 seam 装饰；仍无法到达则记录 `FAIL`。
- [Gate Observer 与正式 Host 路由不同] → Gate 只提供字段可达和错误 Agent Loop 阻止证据；后续垂直链路必须用真实 Pi 执行和 UI 输出重新验收。
- [使用当前 Renderer profile 接触用户状态] → 只操作 Gate 控件和受控创建，不采集账号、项目列表、Local Storage、完整 DOM、网络流量或截图。

## Migration Plan

1. 审计现有 Gate B 实现，保留 CDP、Shim/Observer和透明 JSONL 基础，删除多草稿与 synthetic cwd 归属逻辑。
2. 动态 Capture 当前 Desktop 创建调用，确认一个可修改参数的 seam。
3. 注入当前 Harness 控件并在该 seam 装饰真实创建 Request。
4. 运行 Codex/Pi 两条串行真实尝试，记录窄范围结论。
5. Gate `PASS`后立即进入最小 Host/Pi 垂直链路，不先扩建公共契约、持久化或并发测试矩阵。

## Open Questions

- 当前 Desktop 版本中最浅且可靠的可修改创建 seam 是哪一个？
- Gate-local `harnessId`应位于 `start-conversation`参数、最终 `thread/start.params`还是 bridge message 的哪个 namespaced 位置，才能完整到达 Observer？
- Pi 选择的创建调用在不创建官方影子 Thread 的情况下，正式 Host 最少需要返回哪些 Codex UI 协议消息？该问题由后续最小垂直链路回答。
