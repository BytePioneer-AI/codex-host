## Why

委派首版约定 Host 不在子任务完成后唤醒父 Agent，发起方只能用有界 `thread wait` 占住自己的 Turn，或反复轮询（#311）。两种方式都让发起方无法在等待期间结束 Turn，轮询还会白白消耗 Turn。

## What Changes

- 新增 `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>]` 与 `codexhost thread watches`：调用方显式注册一次性通知，被观察 Thread 停下或 watch 到期时，Host 通过普通 `send` 在被通知 Thread 中启动一个新 Turn，报告执行状态与链接。
- `delegate start` 新增 `--watch true|false` 与 `--watch-timeout-ms <n>`，以委派已解析的父 Thread 作为被通知方；watch 注册失败不影响委派本身。
- 修改“委派创建与结果观察解耦且不主动注入父 Session”：Host 仍不得因子任务终态自行唤醒父 Agent，唯一例外是调用方显式注册的 watch。
- 明确首版限制：watch 只存在于 Host Runtime 内存，重启丢失；不能取消；用户 Stop 被通知 Thread 不会撤销已注册的 watch。
- 统一外部 Thread 忙碌判断为“运行中或存在待处理的调整方向”，避免停止后重发的空档被 `read`/`wait`/`send` 与委派状态读成 `interrupted`。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cross-harness-delegation`：允许调用方显式注册的一次性 Thread 停下通知作为“不主动唤醒父 Agent”的唯一例外，并规定其结果、送达、身份与限制。

## Impact

- `packages/host-runtime`：新增 `delegation-watch.ts`，由 `DelegationControlRegistry` 持有；控制服务新增 `/v1/thread/watch`、`/v1/thread/watches`；CLI、帮助与委派 Skill（版本 8）加入 watch 说明；协调器的忙碌判断调整。
- 不修改插件 API、持久化格式、Mapping Store 或原生 Harness。
- 未使用 watch 时，Host 不会因终态向任何 Thread 提交输入；忙碌判断调整对普通 `thread read`/`wait`/`send` 同样生效。
- 不解决 #311 中任意报告内容的可靠投递与跨重启持久化。
