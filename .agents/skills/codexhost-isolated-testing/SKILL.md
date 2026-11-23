---
name: codexhost-isolated-testing
description: 用当前工作树的代码快速启动一个独立数据目录的 Web 或 Desktop，实际试用功能，不影响用户正在用的 Host 和数据。用于“实测这个功能”“启动测试环境试一下”；不用于单元测试或 Desktop 更新兼容审计。
---

# 快速实测

目标：用最快的方式把当前代码跑起来，实际试用功能。单测已经能证明的，不再实测。

只用一个独立数据目录（例：`/tmp/codexhost-try`）隔离 Host 状态、会话映射和插件启用；在包含待测改动的工作树根目录执行。

## Web（首选，不影响用户的服务）

```bash
CODEXHOST_DATA_DIR=/tmp/codexhost-try npm start web -- --port 4401 --ch-data /tmp/codexhost-try
```

端口要避开用户正在用的 Web（默认 4400）。启动后打开终端输出的地址试用功能。

## Desktop（会替换正在运行的 Codex Desktop，直接启动，无需事先询问）

```bash
CODEXHOST_DATA_DIR=/tmp/codexhost-try npm start
```

用完后由用户在自己的工作树运行不带 `CODEXHOST_DATA_DIR` 的 `npm start` 恢复。

## 规则

- 不加 `--restart-host`，不运行 `npm stop`，不改 `~/.codexhost`。
- Codex 账号、各 Harness 的原生配置和登录状态与用户共用：只发少量、简短、标明测试的消息。
- 用完停掉自己启动的 Web（Ctrl+C）和测试 Host，再删除数据目录：
  `target/debug/codexhost host stop --node <node> --host-runtime <工作树绝对路径>/packages/host-runtime/dist/main.js --data /tmp/codexhost-try`
- 验证 Bug 修复：先用基线代码（如 `main`）复现原问题，再用改动后的代码验证修复，并试一下相关的既有功能。复现不了就如实说明。
- 并行实测：Web 每路用不同的数据目录和端口（例：`/tmp/codexhost-try-<编号>`，端口从 4401 递增）；Desktop 同一时间只能跑一个。
- 隔离 worktree 依赖：不要直接软链主仓库的 `node_modules`（npm workspaces 的相对软链会指回主仓库的 `packages/*`，导致改了 worktree 代码却加载主仓库产物）；macOS 可用 `cp -cR <主仓库>/node_modules <worktree>/node_modules` 做写时复制以保持相对软链指向当前 worktree。
- 并行建树与清理：多路并行实测或小修 PR 时，由主会话先统一 `git fetch` 并创建各路 worktree，再分派并行任务，避免并发抢占 `.git` 锁；完成后统一删除临时 worktree、测试 ref 并执行 `git worktree prune`。
- 汇报：试了什么、结果如何、哪些没试到。
