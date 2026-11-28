---
name: codexhost-isolated-testing
description: 用当前工作树的代码启动独立隔离环境的 Web 或 Desktop，进行功能实测、CDP 自动化验证、边界态造数或 UI 渲染截图（桌面/手机、亮暗色、双语），不影响用户正在用的 Host 和数据。用于“实测这个功能”“启动测试环境试一下”“给 UI 改动截图验收”；不用于单元测试或 Desktop 更新兼容审计。
---

# 隔离实测与 UI 截图

目标：用隔离环境验证当前工作树的可观测行为，或在 UI 改动 / 文档更新时产出可自检的渲染截图。单测已经能证明的，不再实测。

所有临时状态收进同一个独立目录（例：`/tmp/codexhost-try-<id>`），包含 Host 数据目录、临时测试仓库、独立浏览器 `user-data-dir` 与输出截图；在包含待测改动的工作树根目录执行。

## 1. Web（首选，零侵入，不影响用户的服务）

```bash
CODEXHOST_DATA_DIR=/tmp/codexhost-try npm start web -- --port 4401 --ch-data /tmp/codexhost-try
```

端口避开用户正在用的 Web（默认 4400）。启动后打开终端输出的地址手动试用，或按第 3 节接入独立 Chrome CDP 做自动化验证与截图。

## 2. Desktop（会替换正在运行的 Codex Desktop）

```bash
CODEXHOST_DATA_DIR=/tmp/codexhost-try npm start
```

仅在必须验证官方 Codex Desktop 宿主壳集成时使用；会替换正在运行的 Codex Desktop，用完后由用户在自己的工作树运行不带 `CODEXHOST_DATA_DIR` 的 `npm start` 恢复。

## 3. 自动化测试、确定性造数与 UI 截图

需要满足以下任一场景时，读取 [references/cdp-testing-and-screenshots.md](references/cdp-testing-and-screenshots.md)：

- 为带可见 UI 改动的 PR 拍摄渲染截图（桌面端 / 手机端、亮暗主题、中英文矩阵）。
- 复现高成本、多机或历史聚合态（如 30 天用量看板、多节点 Remote Peers 拓扑、异常/空态）而不消耗真实模型额度。
- 通过 CDP 驱动固定交互流程并批量验证回归。

核心原则：

- 用带独立 `--user-data-dir` 与 `--remote-debugging-port` 的 Chrome 连接隔离 Web，一套实例同时覆盖桌面视口与手机视口，不碰用户日常浏览器配置。
- 复杂边界态通过 CDP `Fetch.enable` 在网络层返回确定性 Fixture，不修改业务代码、不在页面内覆盖 `window.fetch`。
- 截完图必须用读图工具逐张肉眼检查对比度、排版截断、焦点框残留与隐私脱敏，确认无误后再交付。

## 4. 隔离与清理规则

- 不加 `--restart-host`，不运行 `npm stop`，不改 `~/.codexhost`。
- Codex 账号与各 Harness 的原生登录状态与用户共用：真实模型调用只发少量、简短、标明测试的消息；可 mock 的 UI 状态优先走 CDP Fixture。
- 用完按以下顺序清理，不遗留后台进程与临时目录：
  1. 结束本次启动的独立 Chrome 与 Web 进程；
  2. 停止隔离 Host：
     `target/debug/codexhost host stop --node <node> --host-runtime <工作树绝对路径>/packages/host-runtime/dist/main.js --data /tmp/codexhost-try`
  3. 删除 `/tmp/codexhost-try`。
- 验证 Bug 修复：先用基线代码（如 `main`）复现原问题，再用改动后的代码验证修复，并抽查相邻既有功能；复现不了如实说明。
- 并行实测：Web 每路使用独立数据目录与递增端口（`/tmp/codexhost-try-<编号>`，`4401+`）；Desktop 同一时间只能跑一个。
- 隔离 worktree 依赖：不要直接软链主仓库的 `node_modules`（npm workspaces 的相对软链会指回主仓库的 `packages/*`，导致改了 worktree 代码却加载主仓库产物）；macOS 用 `cp -cR <主仓库>/node_modules <worktree>/node_modules` 做写时复制以保持相对软链指向当前 worktree。
- 并行建树与清理：多路并行实测或小修 PR 时，由主会话统一 `git fetch` 并创建各路 worktree，再分派并行任务，避免并发抢占 `.git` 锁；完成后统一删除临时 worktree、测试 ref 并执行 `git worktree prune`。
- 汇报：说明试了什么、结果如何、哪些场景用了 Fixture Mock、哪些未覆盖。
