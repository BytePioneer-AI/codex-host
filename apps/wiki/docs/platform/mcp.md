---
title: MCP 服务
description: 将 CodexHost 接入 Claude Desktop、Claude Code 或 Cursor。
---

# MCP 服务

CodexHost 在 `http://127.0.0.1:4398/mcp` 提供标准 Streamable HTTP MCP 服务。将它挂载到 Claude Desktop、Claude Code 或 Cursor 后，当前客户端可以直接调用本机上的 Pi、Grok、OpenCode 等其他 Agent 跑测试、查资料或并行改分支。

## 1. 生成客户端令牌

外部 MCP 客户端连接需要显式注册一个客户端令牌（名称仅限小写字母、数字和 `-`）：

```bash
codexhost client add claude-desktop
```

终端会打印出一串 `chc_...` 开头的令牌（只显示这一次，请立即复制保存）。

管理已有令牌：

```bash
codexhost client list                  # 查看已注册客户端
codexhost client remove claude-desktop # 吊销客户端令牌
```

## 2. 配置客户端

保持桌面端或 `codexhost web` 在后台运行，把下面配置中的 `<你的令牌>` 换成刚才生成的 `chc_...` 令牌。

### Claude Code

```bash
claude mcp add --transport http codexhost http://127.0.0.1:4398/mcp \
  --header "Authorization: Bearer <你的令牌>"
```

### Claude Desktop

不要填在 Claude 设置里的云端「自定义连接器」（Anthropic 云端无法访问你本机的 `127.0.0.1`）。请打开本机的 `claude_desktop_config.json`，通过 `mcp-remote` 桥接：

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
        "CODEXHOST_AUTH": "Bearer <你的令牌>"
      }
    }
  }
}
```

保存后重启 Claude Desktop。

### Cursor 及其他 HTTP MCP 客户端

在客户端 MCP 配置中填入地址 `http://127.0.0.1:4398/mcp`，并加上请求头 `Authorization: Bearer <你的令牌>`。

## 可用 MCP 工具

| 工具名 | 作用 |
| :--- | :--- |
| `host_info` | 查看本机 CodexHost 运行状态与版本信息。 |
| `project_list` | 列出本机已识别的 Git 仓库目录。 |
| `harness_list` / `harness_inspect` | 查询当前就绪的 Agent 列表、可选模型与支持的能力。 |
| `delegate_start` | 新建独立会话并派发任务（支持 `worktree` 分支隔离与 `watch` 完成监听）。 |
| `thread_send` / `thread_cancel` | 发送后续消息、运行中引导（`steer`）、打断重发（`interrupt`）或取消当前轮次。 |
| `thread_wait` / `thread_read` | 等待任务完成，或按 `result` / `messages` 读取对话记录。 |
| `thread_file_read` | 按相对路径安全读取工作区内的文件。 |
| `thread_watches` | 查看当前仍在等待完成的监听列表。 |
