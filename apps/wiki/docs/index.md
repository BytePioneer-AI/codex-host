---
title: 概览
description: CodexHost 的定位、工作原理与本地端口目录速查。
---

# 概览

CodexHost 在官方 Codex Desktop 和浏览器 Web 端中直接运行你本机已有的编码 Agent（Claude Code、Pi、Grok、OpenCode、DSH、Antigravity 等）。

它本身不打包第三方 Agent，也不转发模型请求，而是直接调用本机安装并登录好的各个 Agent CLI。所有 Agent 共享同一个会话列表、Diff 审查面板、消息分叉（Fork）和工具审批，并可通过 CLI、MCP 与 HTTP API 从外部调用。

## 快速开始

```bash
npm install -g @codexhost/cli
codexhost          # 启动 Codex Desktop（未安装 Desktop 时自动打开 Web 端）
codexhost web      # 启动后台 Web 服务并在浏览器打开 (127.0.0.1:4400)
codexhost stop     # 停止全部后台服务
```

macOS 与 Windows 用户也可直接从 [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases) 下载安装包，或参考 [安装与运行](/docs/quick-start/install)。

## 工作原理

桌面端、Web 端与命令行共用同一个本机后台 Host 进程。每个会话固定对应一个 Agent Harness，通过其原生协议（RPC / SDK / ACP）通信：

```text
  Codex Desktop ──┐                                    ┌──▶ Official Codex
  Web UI (:4400) ─┼──▶ CodexHost Runtime (:4398) ──────┼──▶ Claude Code / Pi / OMP
  CLI / MCP / API ┘    (会话映射 · Worktree · 事件流)   └──▶ Grok / OpenCode / AGY ...
```

- **不是另一个聊天壳**：界面直接复用官方 Codex Desktop（或同构的轻量 Web 端），不修改官方安装包。
- **不代理模型流量**：模型请求与认证完全走各 Agent 自己的本地凭据或 API Key。
- **界面与后台分离**：关闭 Codex Desktop 窗口或浏览器标签页不会中断正在运行的任务；只有执行 `codexhost stop` 才会停止后台 Host。

## 端口与状态文件

CodexHost 所有本地服务默认仅绑定回环地址（`127.0.0.1`），状态文件存放在 `~/.codexhost`：

| 端口 / 路径 | 用途 |
| :--- | :--- |
| `127.0.0.1:4400` | Web 聊天界面（`codexhost web` 启动，与桌面端实时同步）。 |
| `127.0.0.1:4399` | 本地诊断与设置控制台（`codexhost console` 启动，Desktop 无法打开时仍可用）。 |
| `127.0.0.1:4398` | 本机编排 API 与 MCP 服务端点（`/mcp`、`/v1/*`）。 |
| `~/.codexhost/` | 会话映射元数据、运行日志与插件配置目录。 |
| `~/.codexhost/cli-credentials.json` | 供当前系统用户免配置调用 CLI 的私有临时凭据（权限 `0600`）。 |

## 下一步

- [安装与运行](/docs/quick-start/install) —— 安装包、npm、WinGet 安装及日常启停、自启配置。
- [能力矩阵](/docs/agents/matrix) —— 查看支持的 18 个 Agent 及各自的能力范围。
- [多 Agent 委派](/docs/agents/delegation) —— 用 `#` 委派并行子任务，或用 `@` 引用旧会话跨 Agent 接力。
- [Web 与手机访问](/docs/web/mobile) —— 从手机扫码连接本机 Web 端并接收完成通知。
- [模式对比](/docs/remote/cross-machine) —— 连接远程 Linux / macOS 开发机（SSH）或远程 Windows 主机。
- [CLI 参考](/docs/platform/cli) —— 从终端脚本、MCP 或 HTTP 接口调度 Agent。
