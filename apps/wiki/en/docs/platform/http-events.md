---
title: HTTP API
description: Control agent threads over localhost port 4398 and stream completion events via SSE or long-polling.
---

# HTTP API

Whenever Codex Desktop or `codexhost web` is running, CodexHost serves its HTTP API on `http://127.0.0.1:4398`—ideal for Slack / Telegram / Discord / Feishu bots, webhooks, or custom backend services.

## 1. Issue a client token

```bash
codexhost client add my-bot
```

Copy the `chc_...` token printed to your terminal (shown once; revoke anytime with `codexhost client remove my-bot`). Send these headers on every request:

```http
Authorization: Bearer chc_your_token_here
Content-Type: application/json
```

## 2. Action endpoints

All action endpoints accept `POST` requests with a JSON body:

| Endpoint | Purpose | Common fields |
| :--- | :--- | :--- |
| `POST /v1/harness/list` | List ready agents | `{}` |
| `POST /v1/project/list` | Search local Git repositories | Optional `query`, `limit`, `offset` |
| `POST /v1/delegate/start` | Spawn a new thread and submit a task | `harness`, `task`, `cwd` (absolute path), optional `taskName`, `worktree`, `base`, `watch` |
| `POST /v1/thread/send` | Follow up, steer mid-turn, or interrupt | `threadId`, `message`, optional `steer`, `interrupt`, `watch` |
| `POST /v1/thread/read` | Read the latest result or turn history | `threadId`, optional `view` (`"result"` or `"messages"`), `from`, `to` |
| `POST /v1/thread/wait` | Wait up to `timeoutMs` for completion | `threadId`, optional `timeoutMs`, `view` |
| `POST /v1/thread/cancel` | Cancel the active turn | `threadId` |
| `POST /v1/thread/watches` | List pending completion watches | `{}` |

### Example request

```bash
curl -X POST http://127.0.0.1:4398/v1/delegate/start \
  -H "Authorization: Bearer chc_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "harness": "pi",
    "cwd": "/Users/me/projects/my-app",
    "taskName": "Investigate login timeout",
    "worktree": "fix/login-timeout",
    "watch": true,
    "task": "Track down why the login endpoint occasionally times out and summarize the root cause."
  }'
```

- `cwd` on `/v1/delegate/start` **must be an explicit absolute path** (HTTP callers have no implicit working directory).
- On `/v1/thread/send`, `steer: true` and `interrupt: true` are mutually exclusive.

## 3. Completion events (`/v1/events`)

When you pass `"watch": true` on `start` or `send`, CodexHost appends a record to your client's 7-day persistent event log as soon as the thread stops (completed, failed, or interrupted)—so bots can resume cleanly after a restart.

### Server-Sent Events (Recommended for bots)

```bash
curl -N http://127.0.0.1:4398/v1/events \
  -H "Authorization: Bearer chc_your_token_here" \
  -H "Last-Event-ID: <cursor>"
```

On reconnect, pass `Last-Event-ID` or `?after=<cursor>` to replay events missed while offline.

### HTTP long-polling

```bash
curl -X POST http://127.0.0.1:4398/v1/events/poll \
  -H "Authorization: Bearer chc_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"after": "<cursor>"}'
```

Waits up to 60 seconds when no new events are available.

### CLI event reader

```bash
CODEXHOST_CLIENT_TOKEN=chc_your_token_here codexhost events --after <cursor>
CODEXHOST_CLIENT_TOKEN=chc_your_token_here codexhost events --follow true
```

::: info Info
Completion events carry lightweight metadata (`threadId`, outcome, turn info, deep link) rather than full message text. Once an event arrives, call `POST /v1/thread/read` to fetch the agent's final reply.
:::
