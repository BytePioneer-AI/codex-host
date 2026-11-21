# Proposal

## Why

长程委派常跑数小时。被观察 Thread 卡在某个操作上时，停下通知要等它停下或 watch 到期才会到达，发起方中途无从得知它已经很久没有动静。

## What Changes

- `thread watch` 与 `delegate start --watch true` 增加可选的 `--stall-after-ms <n>`（MCP 中为 `stallAfterMs`），默认关闭。
- 被观察 Thread 仍在运行、但 Host 在阈值内没有观察到它或其 Harness 子代理的任何事件时，以 `stalled` 提醒一次；观察继续，新的活动重新计时，下一段静默可再次提醒。
- 提醒沿用已有的待投递、合并与持久化机制；接收方为外部客户端时写入其事件日志。
- 不加参数时 watch 的行为不变。

## Decisions

- **提醒不带进度。** 与其他 watch 通知一样只报告执行状态与 Thread 链接；静默时长写作“至少 <阈值>”，照原值表述、不取整。接收方自己 `thread read` 查看进度。
- **活动只来自已有事件流。** 只用 Host 已收到的原生 app-server 通知与外部 Harness 输出，不新增定时器、进程或 rollout 扫描。代价是 Host 看不到的活动会被当作静默（例如 Desktop 取消订阅仍在运行的原生 Thread、不上报事件的 Adapter），所以提醒只表示“没有观察到事件”。
- **静默不跨重启。** 停机不是 Harness 静默：恢复后从恢复时刻重新计时，只有阈值随 watch 保存。卡住提醒不是终态，不写入持久记录：静默在恢复后重新测量，旧版 Runtime 也无法读取 `stalled` 结果。
- **作为新增需求，不修改既有 watch 需求。** `persist-thread-watches` 与 `add-external-client-access` 都以 MODIFIED 整体替换“调用方可显式注册一次性 Thread 停下通知”。卡住提醒独立成一条 ADDED 需求，无论哪个变更先归档都不会覆盖它。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cross-harness-delegation`：新增“调用方可选择 Thread 静默卡住提醒”。

## Impact

`packages/host-runtime` 的 watch 服务、活动收集、CLI 与 MCP 参数；watch 持久记录增加可选的静默阈值字段。`codexhost delegate --help`、`docs/architecture/thread-watch.md` 与 `external-clients.md` 同步说明。依赖 `persist-thread-watches`（watch 持久化）与 `add-external-client-access`（客户端事件日志与 MCP）。
