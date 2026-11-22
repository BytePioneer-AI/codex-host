---
layout: home
title: CodexHost
titleTemplate: 本机编码 Agent 统一工作台
description: "在官方 Codex Desktop 和浏览器 Web 端中直接运行 Claude Code、Pi、Grok、OpenCode 等本机 Agent，并通过手机、SSH 远程主机与 CLI / MCP 随时调用。"

hero:
  name: CodexHost
  text: "在 Codex 中原生运行\n每一个本机 Agent"
  tagline: "预装 Claude Code、Pi、Grok 等 18 个 Agent，共用桌面与 Web 会话，支持手机、SSH 与 CLI / MCP。"
  image:
    src: /images/hero-desktop-phone.png
    alt: "CodexHost 桌面端与手机端同屏预览"
  actions:
    - theme: brand
      text: 阅读文档
      link: /docs/
    - theme: alt
      text: 快速安装
      link: /docs/quick-start/install
    - theme: alt
      text: 能力矩阵
      link: /docs/agents/matrix

features:
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
    title: "安装与运行"
    details: "通过安装包、npm 或 WinGet 安装，统一管理桌面端、Web 端与后台 Host 服务。"
    link: /docs/quick-start/install
    linkText: 安装指南
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>'
    title: "能力矩阵"
    details: "查看预装的 18 个 Agent 在 Edit Diff、工具审批、Fork 与上下文压缩上的原生支持范围。"
    link: /docs/agents/matrix
    linkText: 查看 18 个 Agent
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>'
    title: "多 Agent 委派"
    details: "输入 # 将子任务委派给其他 Agent 并行运行，或用 @ 引用历史会话跨 Agent 接力。"
    link: /docs/agents/delegation
    linkText: "了解 # 与 @"
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
    title: "CLI 与 API"
    details: "从终端 CLI、Claude Desktop / Cursor (MCP) 或外部 HTTP 机器人直接调度本机 Agent。"
    link: /docs/platform/interfaces
    linkText: CLI · MCP · HTTP
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2.5"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
    title: "Web 与手机访问"
    details: "启动内置 Web 界面，用手机扫码远程查看进度、审批工具调用并接收完成推送。"
    link: /docs/web/mobile
    linkText: 扫码与推送
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/></svg>'
    title: "远程开发"
    details: "界面留在本地，通过 SSH 连接远程 Linux / macOS 开发机或遥控远程 Windows 主机。"
    link: /docs/remote/cross-machine
    linkText: SSH 与远程控制
---

<div class="wiki-home-extra">
<div class="wiki-home-panel">

## 快速上手

安装 CLI 后即可启动增强版 Codex Desktop 或独立 Web 端（`127.0.0.1:4400`），也可下载 [macOS / Windows 安装包](https://github.com/BytePioneer-AI/codex-host/releases)。

::: code-group

```bash [npm]
npm install -g @codexhost/cli
codexhost          # 启动桌面端（无 Desktop 时自动打开 Web 端）
codexhost web      # 启动后台 Web 端并打开 127.0.0.1:4400
```

```powershell [WinGet]
winget install --id BytePioneer-AI.CodexHost --exact
codexhost
```

```bash [常用命令]
codexhost status   # 查看后台服务与版本状态
codexhost console  # 打开本地诊断与设置控制台 (:4399)
codexhost stop     # 停止全部后台服务
```

:::

</div>
<div class="wiki-home-panel">

## 预装的 18 个 Agent

直接调用本机已安装并登录的 Agent CLI，保留各工具原生流式、Diff、审批与上下文能力，不代理模型请求：

<div class="wiki-agent-tags">
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Claude Code</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Pi</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Oh My Pi</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Grok</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">OpenCode</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Antigravity</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">DSH (DeepSeek)</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Cursor CLI</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Copilot</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Kimi Code</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Hermes</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Qoder</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">CodeBuddy</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">WorkBuddy</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Qwen Code</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Devin CLI</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">Kiro CLI</a>
  <a class="wiki-agent-tag" href="/docs/agents/matrix">ZCode</a>
</div>

<a class="wiki-matrix-link" href="/docs/agents/matrix">查看完整能力对照表 <span class="vpi-arrow-right"></span></a>

</div>
</div>
