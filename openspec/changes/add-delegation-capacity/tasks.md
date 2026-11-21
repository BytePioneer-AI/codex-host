# Tasks

依赖 `add-external-client-access`（MCP `delegate_start`）与 `add-thread-watch-stall-alerts`（卡住提醒）。行为验收见 [spec](specs/cross-harness-delegation/spec.md)。

## 1. 设置

- [x] 1.1 共享设置契约（开关与 1～32 的上限，默认关闭、4）；Renderer 本地偏好，连接本机 Host 后与修改时下发，Host 不支持时提示；设置页“委派”分组。验证：`renderer-delegation-capacity-preference.test.ts`、`renderer-host-routing.test.ts`、`versioned-renderer-adapter.test.ts`，以及 `tests/e2e/renderer-delegation-capacity.spec.ts`。
- [x] 1.2 Host 接收设置：没有委派控制时返回“方法不支持”，非法值被拒绝。验证：`app-server-host.delegation-capacity.test.ts`。

## 2. 计数与排队

- [x] 2.1 计数：正在运行的顶层 Thread（含手动打开的，不含外部与原生子代理），加上已放行、尚未报告运行的启动。验证：`app-server-host.delegation-capacity.test.ts`、`thread-activity.test.ts`、`delegation-capacity-queue.test.ts`。
- [x] 2.2 `delegate start` 在校验与去重后排队，立即返回标识与位置；按先后自动开始，新启动不越过等待者。验证：`delegation-capacity-queue.test.ts`、`harness-delegation-coordinator.test.ts`、`delegation-capacity-registry.test.ts`。
- [x] 2.3 排队中 Thread 的 read、list、wait、watch、cancel、send 行为与 CLI 输出；远程 `thread read --host` 读取排队中的 Thread。验证：`delegation-capacity-registry.test.ts`、`delegation-cli-output.test.ts`、`remote-delegation-read.test.ts`。
- [x] 2.4 原生 Codex：排队时先建 Thread，只排队第一条 Turn，排队相关代码不删除 Thread；取消先读 Turn，已有 Turn 时按已开始取消；用户直接发消息时分两步认领，后端开始 Turn 后才移出队列，拒绝时留在原位；取消与用户消息交错时不丢内容；重启后“可能已开始”的记录先读 Turn 再决定收编或排队；关闭时写入启动结果。验证：`app-server-host.native-delegation-capacity.test.ts`、`delegation-capacity-queue.test.ts`。

## 3. 持久化与恢复

- [x] 3.1 每个 Runtime 一个私有队列文件，接管已退出 Runtime 的队列；设置到达前保持排队，5 分钟后按关闭处理；重启时正在开始的外部 Harness 委派以 `interrupted` 结束。验证：`delegation-capacity-store.test.ts`、`delegation-capacity-queue.test.ts`、`delegation-capacity-registry.test.ts`。

## 4. 文档与验收

- [x] 4.1 CLI 帮助、MCP 说明、`docs/architecture/delegation-capacity.md` 及相关架构文档。验证：帮助、文档与规格描述一致。
- [ ] 4.2 真实 Desktop 验收：上限设为 1，手动会话运行时分别委派一个外部 Harness 与一个 `--harness codex` 任务，确认排队并在会话结束后自动开始；排队中重启 codexhost 后恢复；取消排队中的任务；在 Desktop 中直接给排队中的原生 Thread 发消息，确认任务只执行一次，并记录它在线程列表中的样子。记录平台与版本。
