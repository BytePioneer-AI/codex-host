# Proposal

## Why

`thread watch` 是长程委派的唤醒机制：设计侧派出阶段主控后结束本轮，等主控停下再被通知。watch 目前只存在 Host Runtime 内存中，一个阶段常跑数小时，期间 Desktop 更新、崩溃或重启都会让通知静默丢失，设计侧不会再被唤醒，只能由用户发现后手动“继续”。委派关系本身已经持久化，丢的只是通知。

## What Changes

- watch 记录（观察中、待投递、无法投递）持久保存，Host Runtime 重启后自动恢复观察和投递，不需要调用方重新注册。
- 观察期限与投递期限按注册时的绝对时间计算，停机时间计入期限。停机期间已停下的 Thread 在恢复后照常通知。
- 恢复后到会话重新注册前，读取失败不计入 60 秒 `unreadable` 宽限，避免重启时把所有 watch 误报为无法读取。
- 停机前已经开始但没有记下结果的投递，恢复后再投递一次：重启场景从“至多一次”改为“至少一次”。
- `thread watches` 的输出与 CLI 用法不变。

## Decisions

- **重启时宁可重复，不可丢失。** 进程退出时，进行中的投递是否已启动 Turn 无从得知。不重投，通知会静默丢失，这正是要修的问题；重投，最坏是被通知方多收一条状态通知。通知只报告执行状态，接收方本来就要先 `thread read` 再行动，重复无害。
- **运行中“投递结果未知”的规则不变。** 进程存活时，这类失败会标记为 `undeliverable` 并在 `thread watches` 中可见，不属于静默丢失；是否改为重试另行讨论，不混入本次。
- **多个 Runtime 共用数据目录时各管各的。** Desktop 与远程监听可能同时运行。每个 watch 一个记录并标注所属进程，启动时只接管已退出进程的记录，并以原子重命名认领，避免重复接管或互相覆盖。
- **只持久化 watch，不扩大到通知内容。** 记录只含 Thread 标识、期限、状态与原因，与 Delegation 关系一样不保存会话内容。
- 放弃的方案：重启后要求调用方重新注册。调用方本身正处于空闲、等待被唤醒的状态，无从得知需要重新注册。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cross-harness-delegation`：“调用方可显式注册一次性 Thread 停下通知”一条从“只保存在内存、重启丢失”改为“持久保存、重启后恢复并至少投递一次”。

## Impact

主要在 `packages/host-runtime` 的 watch 服务与 Runtime 启动流程；持久文件放在 Host Runtime 的私有状态目录，权限仅限当前用户。CLI、控制接口与输出格式不变。`docs/architecture/thread-watch.md` 与 `codexhost delegate --help` 中关于重启丢失的说明同步更新。
