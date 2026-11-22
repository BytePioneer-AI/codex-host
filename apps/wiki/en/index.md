---
layout: home
title: CodexHost
titleTemplate: Unified Workspace for Local Coding Agents
description: "Run Claude Code, Pi, Grok, OpenCode, and your local coding agents inside Codex Desktop and the Web UI—accessible from your phone, over SSH, or via CLI and MCP."

hero:
  name: CodexHost
  text: "Run Local Agents\nNatively in Codex"
  tagline: "18 preinstalled agents in one shared thread list across Desktop, Web, mobile, SSH, CLI, and MCP."
  image:
    src: /images/hero-desktop-phone.png
    alt: "CodexHost desktop and mobile preview"
  actions:
    - theme: brand
      text: Documentation
      link: /en/docs/
    - theme: alt
      text: Quick Install
      link: /en/docs/quick-start/install
    - theme: alt
      text: Capability Matrix
      link: /en/docs/agents/matrix

features:
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
    title: "Installation"
    details: "Install via native installer, npm, or WinGet, and manage the desktop app, Web UI, and background Host."
    link: /en/docs/quick-start/install
    linkText: Install guide
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>'
    title: "Capability Matrix"
    details: "Compare native support across all 18 preinstalled agents for Edit Diff, approvals, Fork, and compaction."
    link: /en/docs/agents/matrix
    linkText: Compare 18 agents
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>'
    title: "Delegation"
    details: "Spawn parallel subtasks across agents with #, or @-mention existing threads to hand off context."
    link: /en/docs/agents/delegation
    linkText: "Explore # & @"
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
    title: "CLI & API"
    details: "Drive local agents from your terminal CLI, Claude Desktop / Cursor over MCP, or HTTP webhooks."
    link: /en/docs/platform/interfaces
    linkText: CLI · MCP · HTTP
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2.5"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
    title: "Web & Mobile"
    details: "Serve the bundled Web UI locally, pair your phone via QR code, approve tools, and get push alerts."
    link: /en/docs/web/mobile
    linkText: QR & notifications
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/></svg>'
    title: "Remote Hosts"
    details: "Keep your UI local while running agents over SSH on Linux / macOS or via Windows Remote Control."
    link: /en/docs/remote/cross-machine
    linkText: SSH & Windows RC
---

<div class="wiki-home-extra">
<div class="wiki-home-panel">

## Quick Start

Install the CLI to launch Codex Desktop or the standalone Web UI (`127.0.0.1:4400`), or grab a [macOS / Windows installer](https://github.com/BytePioneer-AI/codex-host/releases).

::: code-group

```bash [npm]
npm install -g @codexhost/cli
codexhost          # Launch Desktop (or Web UI if absent)
codexhost web      # Start Web UI at 127.0.0.1:4400
```

```powershell [WinGet]
winget install --id BytePioneer-AI.CodexHost --exact
codexhost
```

```bash [Common Commands]
codexhost status   # Inspect background daemon and version status
codexhost console  # Open local diagnostics & settings console (:4399)
codexhost stop     # Stop all background services
```

:::

</div>
<div class="wiki-home-panel">

## 18 Preinstalled Agents

Invokes the agent CLIs already installed and signed in on your machine—preserving native streaming, diffs, approvals, and context without proxying model traffic:

<div class="wiki-agent-tags">
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Claude Code</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Pi</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Oh My Pi</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Grok</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">OpenCode</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Antigravity</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">DSH (DeepSeek)</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Cursor CLI</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Copilot</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Kimi Code</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Hermes</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Qoder</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">CodeBuddy</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">WorkBuddy</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Qwen Code</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Devin CLI</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">Kiro CLI</a>
  <a class="wiki-agent-tag" href="/en/docs/agents/matrix">ZCode</a>
</div>

<a class="wiki-matrix-link" href="/en/docs/agents/matrix">View full capability matrix <span class="vpi-arrow-right"></span></a>

</div>
</div>
