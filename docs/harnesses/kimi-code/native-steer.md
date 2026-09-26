# Kimi Code 同轮插入

Kimi Code Adapter 走 `kimi acp`。这次不声明 `capabilities.steer`，`turn.steer` 返回 `unsupported`。Host 因此停止当前 Turn 后再发送。忙碌时的 `turn.start` 仍是 `sessionBusy`。

依据（2026-09-24，源码与上游问题，未实机验证）：

- 官方 ACP 适配器没有同轮插入方法。[MoonshotAI/kimi-code#2370](https://github.com/MoonshotAI/kimi-code/issues/2370) 仍开放：`kimi acp` 不能把消息插入正在运行的 Turn；TUI 的 Ctrl-S 和 SDK `Session.steer()` 不在这条 ACP 通道上。2026-08-28 的补充说明写明 0.38.0 与 0.39.0 的 `initialize` 都不广告 `_meta.steering.supported`。
- 把该能力接到 `_session/steering` 的 [PR #2514](https://github.com/MoonshotAI/kimi-code/pull/2514) 已于 2026-08-23 关闭且未合并。关闭原因是现有 `Session.steer()` 在空闲时会另起一轮，ACP 层无法原子地保证“只插入当前轮”。这不是可以声明的同轮插入。
- Python `kimi-cli` 的 ACP `ext_method` 仍是空实现，会话循环对 `SteerInput` 直接忽略。Shell 里的 steer 只存在于交互界面，ACP 会话用不到。

因此本次只拒绝 `turn.steer`，不调用原生 steer，也不改历史解析。
