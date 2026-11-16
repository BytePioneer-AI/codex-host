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
- 汇报：试了什么、结果如何、哪些没试到。
