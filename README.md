<div align="center">

# CodexHost

**Run Pi and other Harnesses inside Codex Desktop**

We believe **Codex Desktop** offers the best desktop development experience today.

But **Codex** isn't the only great **Agent Harness** — **Claude Code** and **Pi** are great too.

**CodexHost** lets you run other **Harnesses** natively inside **Codex Desktop** and have them work together.

⭐ If CodexHost is useful to you, please give it a star! ⭐

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="docs/imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="docs/imgs/badge-opencode.svg" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="docs/imgs/badge-omp-v5.svg" /></a><br />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH" src="https://img.shields.io/badge/DSH-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="docs/imgs/badge-agy.svg" /></a>
  <a href="https://kiro.dev/docs/cli/"><img alt="Kiro CLI" src="docs/imgs/badge-kiro.svg" /></a>
  <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="docs/imgs/badge-codebuddy.svg" /></a>
  <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="docs/imgs/badge-workbuddy.svg" /></a>
  <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="docs/imgs/badge-cursor.svg" /></a>
  <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="docs/imgs/badge-hermes.svg" /></a>
  <a href="https://qoder.com/cli"><img alt="Qoder" src="docs/imgs/badge-qoder.svg" /></a>
  <a href="https://moonshotai.github.io/kimi-code/"><img alt="Kimi Code" src="docs/imgs/badge-kimi.svg" /></a>
</p>
<br />

<p align="center"><a href="https://github.com/BytePioneer-AI/codex-host/releases"><strong>Download</strong></a> · <a href="#cross-agent-collaboration">Cross-Agent Collaboration</a> · <a href="#remote-harness">Remote</a> · <a href="#join-the-community">Community</a> · <a href="docs/project/README.zh-CN.md">简体中文</a> · <a href="docs/project/README.ko.md">한국어</a></p>

<br />

</div>

## Interface Preview

No more switching apps: **Pi, Claude Code, Grok Build, and ten-plus other Harnesses** all run right inside the same Codex Desktop window.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### Interface

<div align="center">
  <img width="90%" src="docs/imgs/codexhost-native-overview.png" alt="Claude Code, Pi, Grok Build, and Oh My Pi sessions running in Codex Desktop, with Diff review, Fork, Worktree, and Agent switching">
</div>

## Quick Start

**Option 1: npm** (macOS / Windows / Linux)

```bash
npm install -g @codexhost/cli
codexhost
```

**Option 2: Installer** (macOS / Windows)

Grab the installer for your platform from [Releases](https://github.com/BytePioneer-AI/codex-host/releases).

> Linux is supported on x64 and ARM64. See the [Linux guide](docs/platforms/linux/linux.md).

<details>
<summary>Installation troubleshooting</summary>

**macOS: "App can't be verified" on first launch**

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

**Windows: using a portable Codex Desktop**

1. Point `CODEXHOST_INSTALL_ROOT` at the folder where you extracted Codex Desktop:

   ```powershell
   [Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
   ```

2. Quit Codex Desktop completely, open a new terminal, and run `codexhost`.

</details>

### Highlights

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Full workspace</strong><br /><sub>Sessions from different Harnesses share one sidebar; switch Agents from the bottom-right of the composer</sub></p>
      <div align="center">
        <img width="90%" src="docs/imgs/codexhost-full-workspace.png" alt="The complete CodexHost workspace in Codex Desktop, showing the project tree, conversation area, and multiple Agent selectors">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Diff review panel</strong><br /><sub>Every turn summarizes its changes; click Review to open the full Diff on the right</sub></p>
      <img src="docs/imgs/highlight-diff-review.png" alt="Change summary card in the conversation and the full Diff in the review panel">
    </td>
    <td width="50%" valign="top">
      <p><strong>Fork from any message</strong><br /><sub>Branch in the current workspace, or in a new Worktree for parallel work</sub></p>
      <img src="docs/imgs/highlight-fork-worktree.png" alt="Menu for creating a branch from a message, in this workspace or a new worktree">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Delegate to other Agents with #</strong><br /><sub>Each Agent runs in its own session, in parallel · <a href="#cross-agent-collaboration">Learn more</a></sub></p>
      <img src="docs/imgs/highlight-delegation.png" alt="Typing # to pick Codex, Claude Code, Grok and other Agents, each task running in its own session">
    </td>
    <td width="50%" valign="top">
      <p><strong>Tool calls and thinking</strong><br /><sub>Expand any edit, command, or thinking step to see the details</sub></p>
      <img src="docs/imgs/highlight-tool-details.png" alt="An expanded edit entry showing the Diff of a newly created file">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Visible Subagents</strong><br /><sub>Each Subagent has its own icon; open its full conversation on the right</sub></p>
      <img src="docs/imgs/highlight-subagent.png" alt="Status of 4 Subagents in the main conversation, with one opened on the right">
    </td>
    <td width="50%" valign="top">
      <p><strong>Remote development</strong><br /><sub>Add a VPS as a project and run Agents directly on the remote machine · <a href="#remote-harness">Learn more</a></sub></p>
      <img src="docs/imgs/highlight-remote.png" alt="A remote VPS project in the sidebar, with the conversation returning the remote working directory">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Usage at a glance</strong><br /><sub>Cache hit rate, cost estimate, and context usage, live</sub></p>
      <img src="docs/imgs/highlight-usage.png" alt="Usage popover: context, cache hit rate, cache reads and writes, total tokens, cost estimate">
    </td>
    <td width="50%" valign="top">
      <p><strong>One-click account import</strong><br /><sub>Copy your locally signed-in Codex and Grok credentials to Pi, with live quota</sub></p>
      <img src="docs/imgs/highlight-account-import.png" alt="Account settings: 5-hour and 7-day remaining quota, and accounts imported into Pi">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid diagram rendering</strong><br /><sub>Left: Codex Desktop + Pi renders the diagram; right: the Pi TUI only shows the source</sub></p>
      <img src="docs/imgs/codex-vs-pi-agent-tui.png" alt="Comparison of Mermaid diagram rendering between Pi with Codex Desktop and the Pi Agent TUI">
    </td>
  </tr>
</table>

## Feature Status

Every Harness gets Codex Desktop's native Edit Diff, Fork, message editing, and slash commands.

<details>
<summary>Show full feature matrix</summary>

| Capability | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="docs/imgs/harness-icon-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="docs/imgs/harness-icon-opencode.svg" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH" src="https://img.shields.io/badge/-4D6BFE?logo=deepseek&logoColor=white" /></a> | <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="docs/imgs/harness-icon-agy.svg" /></a> | <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="docs/imgs/harness-icon-codebuddy.svg" width="24" height="24" /></a> | <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="packages/adapters/workbuddy/assets/icon.svg" width="24" height="24" /></a> | <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="docs/imgs/harness-icon-cursor.svg" /></a> | <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="docs/imgs/harness-icon-hermes.svg" /></a> | <a href="https://qoder.com/cli"><img alt="Qoder" src="packages/adapters/qoder/assets/icon.svg" width="28" height="28" /></a> | <a href="https://moonshotai.github.io/kimi-code/"><img alt="Kimi Code" src="packages/renderer-extension/src/assets/kimi-agent.svg" width="28" height="28" /></a> |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Streaming responses | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Questions / cancellation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model / Thinking selection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool approvals | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Permission modes | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cross-Agent task collaboration | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| Usage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Fork | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Context compaction | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Slash commands | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit previous message | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

</details>

## Cross-Agent Collaboration

Type `#` in the chat input to choose an Agent to delegate a task to, or to find commands and skills available for the selected Harness.

Ask the current Agent to hand off a self-contained task to another Harness. For example:

> Have `#claude-code` review this change on its own and flag any compatibility risks.
>
> Have `#pi` figure out why this test is flaky.
>
> Have `#omp` implement this feature while I keep working on the docs.
>
> Have `#opencode` verify this fix in a separate Thread and run the related tests.

CodexHost spins up a separate Native Session in the target Harness. It shows up in the Codex Desktop conversation list, so you can open it anytime to check progress or pick up the conversation.

<details>
<summary><h3 id="remote-harness">Remote Harness</h3></summary>

Drive Harnesses on another machine from your local Codex Desktop: tasks run remotely, the UI stays local. Both machines need the same codexhost version.

| Remote machine | How to connect |
| --- | --- |
| macOS / Linux | [SSH](#ssh) |
| Windows | [Remote Control](#remote-control-experimental) (experimental) |

#### SSH

Before you start, add the remote machine in Codex Desktop under **Settings → Connections → SSH**. Your local machine can run macOS, Linux, or Windows.

<div align="center">
  <img width="70%" src="docs/imgs/remote-ssh-connections.png" alt="SSH connections added under Settings → Connections → SSH in Codex Desktop">
</div>

1. Install and start codexhost on the remote machine:

   ```bash
   npm install -g @codexhost/cli
   codexhost remote install
   codexhost remote start
   codexhost remote status
   ```

2. On your local machine, launch Codex Desktop through codexhost and open the SSH workspace.
3. Pick a Harness from the composer's Agent / Model selector.

[SSH setup, diagnostics, and uninstall →](docs/platforms/remote/remote-ssh-host.md)

#### Remote Control (Experimental)

Use Harnesses on a Windows machine from another computer, built on the pairing and sign-in of Codex Desktop's official Remote Control.

Before you start, make sure official Remote Control can already run Codex tasks. No public services or ports are opened, and Harness credentials never leave the Windows machine.

[Remote Control setup, transport boundary, and diagnostics →](docs/platforms/remote/remote-control-host.md)

</details>

<details>
<summary><h3>How it works</h3></summary>

Most multi-agent clients build their own chat UI and plug Harnesses in through a common protocol.

CodexHost does it differently:

- **Desktop:** extends the official Codex Desktop via CDP / Electron Inspector — no rebuilt chat UI, no patched installer.
- **Protocol:** a CLI Shim sits in front of the official app-server and passes native Codex requests through untouched.
- **Harnesses:** each Harness is integrated through its own native interface where one exists (Pi over RPC, Claude Code via the Agent SDK), falling back to [ACP](https://agentclientprotocol.com/) otherwise. Streaming, tool status, diffs, approvals, and questions all render in Codex Desktop's native UI.
- **Orchestration:** delegated tasks run as independent native sessions in the target Harness; the caller can wait for the result or let it run in the background.

</details>

## Join the Community

<table align="center">
  <tr>
    <td>
      <strong>Join the Community</strong><br />
      <sub>Scan the QR code to join our WeChat group and chat about CodexHost.</sub>
      <ul>
        <li><sub>Get help with installation</sub></li>
        <li><sub>Share feature ideas and feedback</sub></li>
        <li><sub>Talk about development</sub></li>
        <li><sub>For bugs, please open an <strong>issue</strong></sub></li>
      </ul>
      <sub><strong>Contributions are welcome.</strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="WeChat group QR code" src="docs/imgs/wechat-qrcode.jpg" />
    </td>
  </tr>
</table>

## Development

Please read the [contributing guide](CONTRIBUTING.md) before opening an issue or PR. See [repository maintenance automation](docs/operations/repository-maintenance.md) for PR title labels, CI summaries, and pre-release checks.

Requirements: the official Codex Desktop, Node.js 22.19+ or 24, and Rust.

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm start
```

### Runtime Architecture

Using Pi as an example, here is how a single request flows from left to right: Desktop → shared layer → Pi plugin → native process.

<div align="center">
  <img width="100%" src="docs/imgs/pi-runtime-architecture.png" alt="Runtime architecture using Pi: Desktop to the shared layer, then the Pi plugin and native process">
</div>

### Adding a Harness

Most of the work is implementing the plugin's Manifest, factory, Adapter, and Session, plus the native communication and translation logic. The Renderer still has some hard-coded wiring, so full Desktop integration takes extra work.

Tip: point your coding Agent at the in-repo [codexhost-add-harness Skill](.agents/skills/codexhost-add-harness/SKILL.md). It covers plugin structure, the shared Adapter interface, capability implementation, and testing requirements.

## Acknowledgements

- Thanks to the [LINUX DO](https://linux.do/) community for their ongoing support.
- Thanks to [Paseo](https://github.com/getpaseo/paseo), whose approach to multi-Harness integration and architecture inspired ours.

## Star History

<a href="https://www.star-history.com/?repos=bytepioneer-ai%2Fcodex-host&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
  </picture>
</a>
