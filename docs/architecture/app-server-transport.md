# 原生 app-server 大消息传输

Codex 的历史分页响应可能包含图片和较长的工具输出。分页限制约束 Turn 数量，并不保证单个响应小于 128 MiB。Host 必须完整转发这些原生响应，保留内容和分页语义。

`packages/host-runtime/src/remote-official-connection.ts` 把私有官方 WebSocket 连接转换为 LF 分隔的字节流。该客户端仅连接本机 loopback、Unix socket 或 Windows 命名管道；受管理的 loopback 后台使用 capability header。接收原生响应时不另设 WebSocket 消息大小上限，与 stdio 保持一致，避免大历史页关闭连接并连带中断其他请求。Host 对外监听端的请求大小限制独立维护。

`packages/protocol-core/src/jsonl.ts` 只在新收到的数据块中查找换行。跨块帧保留字节片段，收到终止换行时合并一次，复制和扫描成本随输入字节数线性增长。单块内的完整帧直接使用子视图；多个帧、空帧和跨块 UTF-8 内容均保留原始字节。显式传入的 `maxFrameBytes` 仍按单帧检查，不按传输块检查；没有终止换行的尾段仍报错。

这不是流式 JSON 解析：完整帧及其解析结果仍需要与响应大小相应的内存。Host 不截断图片、不改写历史，也不通过自动重试掩盖传输失败。

回归验证位于 `packages/protocol-core/test/jsonl.test.ts` 和 `packages/host-runtime/test/remote-official-connection.test.ts`，覆盖分块复制量、帧边界与限额，以及超过 128 MiB 的真实 WebSocket 响应和同连接后续请求。
