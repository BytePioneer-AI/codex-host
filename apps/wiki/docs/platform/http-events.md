---
title: HTTP API
description: 通过 4398 端口 HTTP 接口控制 Agent 会话，并通过 SSE 或长轮询接收完成事件。
---

# HTTP API

当桌面端或 `codexhost web` 正在运行时，CodexHost 默认在 `http://127.0.0.1:4398` 开启 HTTP API，适合在飞书 / Telegram / Slack 机器人、Webhook 或自研后端服务中直接调用。

## 1. 注册客户端令牌

```bash
codexhost client add my-bot
```

复制输出的 `chc_...` 令牌（仅显示一次；可用 `codexhost client remove my-bot` 吊销）。所有请求均需携带：

```http
Authorization: Bearer chc_你的令牌
Content-Type: application/json
```

## 2. 接口列表

所有动作端点均为 `POST` 请求，请求体为 JSON：

| 端点 | 作用 | 常用字段 |
| :--- | :--- | :--- |
| `POST /v1/harness/list` | 列出当前就绪的 Agent | `{}` |
| `POST /v1/project/list` | 搜索本机已记录的 Git 仓库 | 可选 `query`、`limit`、`offset` |
| `POST /v1/delegate/start` | 新建会话并派发任务 | `harness`、`task`、`cwd`（绝对路径），可选 `taskName`、`worktree`、`base`、`watch` |
| `POST /v1/thread/send` | 发送后续消息、引导或打断重发 | `threadId`、`message`，可选 `steer`、`interrupt`、`watch` |
| `POST /v1/thread/read` | 读取最新结果或多轮对话记录 | `threadId`，可选 `view`（`"result"` 或 `"messages"`）、`from`、`to` |
| `POST /v1/thread/wait` | 等待当前轮次跑完并返回结果 | `threadId`，可选 `timeoutMs`、`view` |
| `POST /v1/thread/cancel` | 取消当前正在运行的轮次 | `threadId` |
| `POST /v1/thread/watches` | 列出仍在等待完成的监听 | `{}` |

### 请求示例

```bash
curl -X POST http://127.0.0.1:4398/v1/delegate/start \
  -H "Authorization: Bearer chc_你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "harness": "pi",
    "cwd": "/Users/me/projects/my-app",
    "taskName": "排查登录超时",
    "worktree": "fix/login-timeout",
    "watch": true,
    "task": "排查登录接口偶发超时原因，给出根因分析。"
  }'
```

- `/v1/delegate/start` 的 `cwd` **必须传完整的绝对路径**（外部 HTTP 调用没有隐式当前目录）。
- `/v1/thread/send` 的 `steer: true` 与 `interrupt: true` 互斥，不能同时传 `true`。

## 3. 接收完成事件（`/v1/events`）

在 `start` 或 `send` 时传入 `"watch": true` 后，只要目标会话结束当前轮次（完成、报错或被中断），CodexHost 就会往该客户端专属的本地事件日志里写入一条记录（保留 7 天，客户端重启后可按游标补读）。

支持三种读取方式：

### SSE 实时流（推荐常驻 Bot）

```bash
curl -N http://127.0.0.1:4398/v1/events \
  -H "Authorization: Bearer chc_你的令牌" \
  -H "Last-Event-ID: <上次事件ID>"
```

断线重连时带上 `Last-Event-ID` 请求头或 `?after=<事件ID>` 查询参数，会自动补发断线期间漏掉的事件。

### HTTP 长轮询

```bash
curl -X POST http://127.0.0.1:4398/v1/events/poll \
  -H "Authorization: Bearer chc_你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"after": "<上次游标>"}'
```

没有新事件时最多挂起等待 60 秒。

### CLI 直接读取

```bash
CODEXHOST_CLIENT_TOKEN=chc_你的令牌 codexhost events --after <上次游标>
CODEXHOST_CLIENT_TOKEN=chc_你的令牌 codexhost events --follow true
```

::: info 说明
完成事件只包含 `threadId`、结束状态、轮次信息与会话深链，不包含大段回复正文。收到事件后，再调一次 `POST /v1/thread/read` 即可读取最终回复。
:::
