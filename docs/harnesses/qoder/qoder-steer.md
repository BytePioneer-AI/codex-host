# Qoder 同轮插入

Qoder 与 Qoder CN 共用同一套会话实现。插入走 `@qoder-ai/qoder-agent-sdk` / `@qodercn-ai/qodercn-agent-sdk` 1.0.39 的流式输入：`SDKUserMessage`，`priority: "next"`，`origin: { kind: "human" }`。SDK 注释写明 `next` 在安全边界插入，`now` 打断当前 Turn，`later` 等到空闲。Adapter 只用 `next`。

Host 在原生接受后自己发当前 Turn 的 `userMessage` Item。Adapter 不发这条 Item，也不改历史解析。现有解析把带文本的 human user 消息当作新一轮的起点。没有 Qoder transcript，不知道这次插入会被存成 attachment 还是 user 消息；若是后者，刷新后会按现有规则另起一轮。

## 接受

与 Claude Code 相同，依据是 SDK 的 `command_lifecycle`。`queued` 表示 Qoder 已接受这条输入，此时返回 `{ accepted: true }`；`started` 表示插入进入正在运行的 Turn。`queued` 之前 Turn 的 `result` 先到，或会话已关闭、目标不是当前 Turn，返回 `invalidState`。空文本返回 `invalidRequest`。忙时 `turn.start` 仍是 `sessionBusy`。

## 版本与验证

没有查到更早的引入版本，不设版本门槛。本机未安装 Qoder，没有实机验证。声明 `capabilities.steer` 的依据是：SDK 1.0.39 写明 `next` 在安全边界插入，且同构的 Claude Code 2.1.280 实机只有一次 `result`、插入在同一次运行里被处理。因此 Qoder 的实时结果处理也不改。

若将来出现第二个非成功 `result`，现有代码会在没有活跃 Turn 时关闭会话。Claude Code 实测没有出现第二个 `result`，这次不改那条路径。
