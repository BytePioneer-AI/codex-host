---
title: 接入概览
description: 从终端脚本、MCP 客户端或外部机器人调用 CodexHost 管理的所有 Agent。
---

# 接入概览

只要本机正在运行 CodexHost（打开了桌面端或运行了 `codexhost web`），后台 Host 就会在 `127.0.0.1:4398` 暴露统一的编排接口。你可以从 Shell 脚本、Claude Desktop、Cursor 或飞书 / Telegram / Slack 机器人直接启动 Agent 会话、创建独立 Git Worktree、半路追加指令并监听完成事件。

## 三种接入方式

| 场景 | 接口 | 认证方式 | 文档 |
| :--- | :--- | :--- | :--- |
| 当前系统用户下的 **Shell / Python 脚本**、Agent 互调 | **CLI** | **免配置**（自动读取 `~/.codexhost/cli-credentials.json`） | [CLI 参考](/docs/platform/cli) |
| 从 **Claude Desktop、Claude Code、Cursor** 调用本机其他 Agent | **MCP 服务** | 客户端令牌（`codexhost client add`） | [MCP 服务](/docs/platform/mcp) |
| **常驻聊天机器人（飞书 / Telegram / Slack）**、Webhook、后端服务 | **HTTP API + 事件流** | 客户端令牌（`codexhost client add`） | [HTTP API](/docs/platform/http-events) |

## 共同行为

无论通过 CLI、MCP 还是 HTTP API 发起任务，底层行为完全一致：

- **界面实时可见**：外部发起的每个会话都会立即出现在桌面端和 Web 端的左侧会话列表中，随时可以点开查看 Diff、批准工具调用或手动接管。
- **Git Worktree 隔离**：启动任务时传入 `worktree`（或 `--worktree`），会自动在 `.worktrees/` 下检出独立分支，多个 Agent 同时改同一个仓库不会冲突。
- **运行中控制**：支持在任务运行中递话微调方向（`steer`），或取消当前轮次并立即替换为新指令（`interrupt`）。
- **7 天完成事件日志**：开启 `watch` 后，任务结束（完成、失败或取消）会写入客户端专属的本地事件日志，调用方重启后依然能按游标补读通知。
