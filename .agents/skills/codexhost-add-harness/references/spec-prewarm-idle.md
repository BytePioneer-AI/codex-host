# 预热与空闲释放

没有单独的能力行，所有插件都要满足，是 A4 create、A8 resume、A10 close 的附加要求。这两项决定了 Host 能否安全地提前创建 Session，以及能否在空闲时关闭 Session、之后再恢复。相关文档：`docs/architecture/harness-plugin-runtime.md#外部-thread-预热`、`docs/proposals/external-harness-idle-unload-proposal.md`。

## 预热

Desktop 会为外部 Harness 的草稿做预热：在用户发送第一条消息之前，就调用 `open({kind:"create"})`。预热的 Session 可能被丢弃：配置变更、用户离开或草稿退役时，Host 会 close 它。

插件必须：

- 在第一次 `turn.start` 之前，**不提交任何用户内容**，也不在原生侧产生需要用户手动清理的会话。可以把原生会话的创建推迟到第一个 Turn，再通过 `session.state.changed` 发布 `nativeRef`。
- 支持在任何时刻干净地 close，包括原生身份还没有建立的时候。
- create 要尽量轻量，不要阻塞在不必要的网络请求上。

## 空闲释放与故障恢复

Thread 空闲时，Host 会调用 `session.close()`。空闲指同时满足：没有活动 Turn，没有运行中的 Subagent，没有进行中的 Host 操作，并且已有 `nativeRef`。用户下一次操作时，Host 通过 `open({kind:"resume"})` 恢复。故障后也走同一条恢复路径。

插件必须：

- 让 `close()` 在 60 秒内完成并结束 outputs，否则释放会被判为失败，该 Session 也会被禁止继续使用。
- 让 resume 的行为与 Host 重启后的冷恢复一致。
- 关闭失败后，再次调用 close 应该重新尝试关闭。如果把失败缓存成永久失败，Host 只能提示用户重启。无法回收的资源必须报告。

## 验收

- 预热：create 之后不发消息就 close，原生侧没有残留；create 之后发出第一条消息，身份能正确发布。
- 空闲释放：close 之后再 resume，能继续第二个 Turn，历史不重复。
