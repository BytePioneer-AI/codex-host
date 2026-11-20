---
title: MCP Server
description: Connect CodexHost to Claude Desktop, Claude Code, or Cursor over MCP.
---

# MCP Server

CodexHost serves Streamable HTTP MCP at `http://127.0.0.1:4398/mcp`. Once connected, Claude Desktop, Claude Code, or Cursor can delegate test runs, research, or parallel branch edits to Pi, Grok, OpenCode, and any other installed agent.

## 1. Create a client token

External MCP clients require a named client token (lowercase letters, digits, and `-`):

```bash
codexhost client add claude-desktop
```

This prints a `chc_...` token once—copy and save it right away.

Manage existing tokens:

```bash
codexhost client list                  # List registered clients
codexhost client remove claude-desktop # Revoke a client token
```

## 2. Configure your MCP client

Keep Codex Desktop or `codexhost web` running in the background, and replace `<your-token>` below with your `chc_...` token.

### Claude Code

```bash
claude mcp add --transport http codexhost http://127.0.0.1:4398/mcp \
  --header "Authorization: Bearer <your-token>"
```

### Claude Desktop

Do not add `127.0.0.1` under Claude's cloud Custom Connectors (remote servers cannot reach your localhost). Add it to your local `claude_desktop_config.json` via `mcp-remote`:

```json
{
  "mcpServers": {
    "codexhost": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:4398/mcp",
        "--header",
        "Authorization:${CODEXHOST_AUTH}"
      ],
      "env": {
        "CODEXHOST_AUTH": "Bearer <your-token>"
      }
    }
  }
}
```

Save the file and restart Claude Desktop.

### Cursor & other HTTP MCP clients

Point the client at `http://127.0.0.1:4398/mcp` with request header `Authorization: Bearer <your-token>`.

## Exposed MCP tools

| Tool | Purpose |
| :--- | :--- |
| `host_info` | Inspect local Host runtime status and version info. |
| `project_list` | List discovered local Git repositories. |
| `harness_list` / `harness_inspect` | List ready agents, available models, and supported capabilities. |
| `delegate_start` | Spawn a new thread and submit a task (supports `worktree` isolation and `watch`). |
| `thread_send` / `thread_cancel` | Send follow-ups, `steer` mid-turn, `interrupt`, or cancel the active turn. |
| `thread_wait` / `thread_read` | Wait for turn completion or read `result` / paginated `messages`. |
| `thread_file_read` | Read workspace files referenced in agent reports by relative path. |
| `thread_watches` | List active completion watches. |
