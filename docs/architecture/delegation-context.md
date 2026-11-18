# 委派父关系与独立任务

`delegate start` 可以在没有父会话的普通终端中创建独立任务，仍需已有 Runtime 连接和权限。父关系优先使用显式 `--parent-thread`，其次使用 CLI 调用方的 `CODEXHOST_THREAD_ID` 或原生 `CODEX_THREAD_ID`；缺少这些身份时任务没有父会话。Host 不从活跃 Turn 或自身进程环境推断父关系。外部 client 沿用 `client:<name>` 来源身份，创建时仍须提供 `--cwd`。

`--cwd` 优先；有父会话时继承其目录，否则沿用 Runtime 的工作目录。无父任务位于会话树根部。子会话标题仅使用子任务名，见[委派子会话命名](delegation-titles.md)。空白任务在 CLI 发起 Runtime 请求或创建 worktree 前被拒绝。

创建路由在已有 Runtime 内选择：无父时，原生 Codex 和外部 Harness 均优先使用已注册的共享 catalog；没有共享 catalog 时使用唯一注册会话。没有共享 catalog 且注册项不唯一时明确报歧义，不按活跃任务数量选择或自动发现其他 Host。显式父关系继续按已有的 Thread 归属检查路由到拥有者。无父的 `delegate start --watch true` 保留创建结果并报告 `notRegistered`，可用 `thread watch --notify` 明确选择接收方。

去重比较父关系、目标 Harness 和 `taskDigest`；摘要包含任务正文、解析后的 cwd、model ID 与 thinking option ID。有父任务按这些键进行短时间去重。无父任务只使用显式 `--request-id` 去重，避免把不相关终端的相同任务合并。同一请求 ID 改变上述任一键会被拒绝。

委派记录 V1 的 `parentHostThreadId` 和 `sourceHarnessId` 可省略，原有有父记录无需迁移。旧版本仍要求这两个字段：降级时会隔离无父委派记录，丢失这些任务的请求 ID 去重和委派状态记录；隔离会将文件从 `delegations/` 重命名移入 `quarantine/`，升回新版不会自动恢复。任务的 Thread 记录及原生会话不受影响。
