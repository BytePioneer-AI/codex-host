# Proposal

## Why

一个委派出来的子 Thread 可能后续演变为主会话，用户会想把它单独置顶。现在只有顶层 Thread 可以置顶，子 Thread 的置顶被隐藏，用户无法把它提升出来。

## What Changes

- 子 Thread 可以像其他 Thread 一样置顶。被置顶的 Thread 不再有显示父 Thread：它作为独立的顶层 Thread 显示在置顶区，它的子 Thread 跟随它。取消置顶后回到委派父 Thread 下。
- 该规则由 Host 统一计算：`codexhost/thread/tree/read` 返回的 `parents` 不包含已置顶的 Thread，置顶或取消置顶时 Host 发出 `codexhost/thread/tree/changed`。Web 的树显示、父 Thread 的后代汇总与排序、归档级联都基于同一份 `parents`，不单独判断置顶。
- 在 Codex Desktop 中置顶的子 Thread，在 Web 中同样作为顶层显示在置顶区；Web 与 Desktop 的置顶状态一致，不再因层级而不同。
- 子 Thread 的行菜单恢复“置顶”。

## Decisions

- **置顶即层级切换**：被置顶的 Thread 在置顶那一刻就成为独立的顶层会话，因此归档父 Thread 时不再级联到它，也不需要在归档时单独判断置顶状态。
- **在 Host 计算，不在 Web 重复**：避免 Web 与 Host 对“谁是顶层”各有一套判断。
