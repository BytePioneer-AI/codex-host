<div align="center">

# CodexHost

**Use 15+ Agents like Claude Code, Pi and Grok inside Codex Desktop, without switching apps**

They get the same Diff review, Fork and approvals as Codex, and can hand work to each other.

There is also a **Web app**: the same Codex interface with lower memory use, so you can use every Agent on this computer remotely from your phone or any other computer.

⭐ If CodexHost is useful to you, please give it a star! ⭐

<p align="center">
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="docs/imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="docs/imgs/badge-opencode.svg" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="docs/imgs/badge-omp-v5.svg" /></a><br />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH" src="https://img.shields.io/badge/DSH-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://github.com/QwenLM/qwen-code"><img alt="Qwen Code" src="https://img.shields.io/badge/Qwen_Code-6950EF?logo=qwen&logoColor=white" /></a>
  <a href="https://docs.devin.ai/cli"><img alt="Devin" src="docs/imgs/badge-devin.svg" /></a>
  <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="docs/imgs/badge-agy.svg" /></a>
  <a href="https://kiro.dev/docs/cli/"><img alt="Kiro CLI" src="docs/imgs/badge-kiro.svg" /></a>
  <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="docs/imgs/badge-codebuddy.svg" /></a><br />
  <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="docs/imgs/badge-workbuddy.svg" /></a>
  <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="docs/imgs/badge-cursor.svg" /></a>
  <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="docs/imgs/badge-hermes.svg" /></a>
  <a href="https://qoder.com/cli"><img alt="Qoder" src="docs/imgs/badge-qoder.svg" /></a>
  <a href="https://moonshotai.github.io/kimi-code/"><img alt="Kimi Code" src="docs/imgs/badge-kimi.svg" /></a>
  <a href="https://zcode.z.ai/"><img alt="ZCode" src="docs/imgs/badge-zcode.svg" /></a>
  <a href="docs/harnesses/copilot/copilot-harness-integration.md"><img alt="GitHub Copilot" src="https://img.shields.io/badge/Copilot-181717?logo=githubcopilot&logoColor=white" /></a>
</p>

<p align="center"><a href="https://github.com/BytePioneer-AI/codex-host/releases"><strong>Download</strong></a> · <a href="#quick-start">Quick Start</a> · <a href="#desktop">Desktop</a> · <a href="#collaboration">Cross-Agent Collaboration</a> · <a href="#join-the-community">微信交流群</a> · <a href="docs/project/README.zh-CN.md">简体中文</a> · <a href="docs/project/README.ko.md">한국어</a></p>

<img width="90%" src="docs/imgs/hero-desktop-phone.png" alt="Several Agent sessions and the Diff review panel in Codex Desktop, with the same session open on a phone at the bottom right">

</div>

## Sponsors

<details open>
<summary>Click to collapse</summary>

<table>
<tr>
<td width="180"><a href="https://vibeapi.cc/sign-up?aff=AOYp"><img src="docs/imgs/sponsors/vibeapi.jpg" alt="VibeAPI" width="160"></a></td>
<td>Thanks to <b>VibeAPI</b> for sponsoring this project! Built for power developers and teams, VibeAPI provides unified access to mainstream AI models, focusing on the Codex and Claude series with a self-managed, traceable account pool. It offers ultra-fast time to first token, 99.9% SLA availability, and cache hit rates of 95%+. Human technical support is available 24/7, with corporate invoicing and enterprise partnerships fully supported. <a href="https://vibeapi.cc/sign-up?aff=AOYp">Grab some cyber goodies →</a></td>
</tr>
</table>
</details>

<a id="quick-start"></a>

## Quick Start

**Option 1: npm** (macOS / Windows / Linux)

```bash
npm install -g @codexhost/cli
codexhost          # start Codex Desktop
codexhost web      # start Web and open it in your browser
codexhost stop     # stop all CodexHost background services
```

**Option 2: Installer** (macOS / Windows)

Grab the installer for your platform from [Releases](https://github.com/BytePioneer-AI/codex-host/releases). For Web: open codexhost after installing, then visit http://127.0.0.1:4400 locally.

> Linux is supported on x64 and ARM64. See the [Linux guide](docs/platforms/linux/linux.md).

**Upgrade and stop:** run `codexhost update` to upgrade, and `codexhost stop` to stop all background services. Before installing over an existing npm installation, run `codexhost stop` first.

<details>
<summary>Installation troubleshooting</summary>

**codexhost does not start, or Codex opens without codexhost features**

Run `codexhost console` (Windows: Start Menu → "codexhost console") to open the local console at `http://127.0.0.1:4399/`. It shows why the last start failed, the Codex Desktop version and Host Runtime logs, and can update codexhost while Codex is not running.

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

<a id="desktop"></a>

## Use every Agent in Codex Desktop

No more switching apps: **Pi, Claude Code, Grok Build and 15+ other Agents** all run in the same Codex Desktop window. Every session is in the sidebar, and you can switch Agents from the bottom-right of the composer.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

<table>
  <tr>
    <td width="33%" valign="top">
      <p><strong>Diff review panel</strong><br /><sub>Every turn summarizes its changes; click Review to open the full Diff</sub></p>
      <img src="docs/imgs/highlight-diff-review.png" alt="Change summary card in the conversation and the full Diff in the review panel">
    </td>
    <td width="33%" valign="top">
      <p><strong>Fork from any message</strong><br /><sub>Branch in the current workspace, or in a new Worktree for parallel work</sub></p>
      <img src="docs/imgs/highlight-fork-worktree.png" alt="Menu for creating a branch from a message, in this workspace or a new worktree">
    </td>
    <td width="33%" valign="top">
      <p><strong>Visible Subagents</strong><br /><sub>Each Subagent has its own icon; open its full conversation on the right</sub></p>
      <img src="docs/imgs/highlight-subagent.png" alt="Status of 4 Subagents in the main conversation, with one opened on the right">
    </td>
  </tr>
</table>

<details>
<summary>More: tool details, usage, account import, diagram rendering</summary>

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Tool calls and thinking</strong><br /><sub>Expand any edit, command or thinking step to see the details</sub></p>
      <img src="docs/imgs/highlight-tool-details.png" alt="An expanded edit entry showing the Diff of a newly created file">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage at a glance</strong><br /><sub>Cache hit rate, cost estimate and context usage, live</sub></p>
      <img src="docs/imgs/highlight-usage.png" alt="Usage popover: context, cache hit rate, cache reads and writes, total tokens, cost estimate">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>One-click account import</strong><br /><sub>Copy your locally signed-in Codex and Grok credentials to Pi, with live quota</sub></p>
      <img src="docs/imgs/highlight-account-import.png" alt="Account settings: 5-hour and 7-day remaining quota, and accounts imported into Pi">
    </td>
    <td width="50%" valign="top">
      <p><strong>Better than a terminal</strong><br /><sub>Left: Codex Desktop + Pi renders the Mermaid diagram; right: the Pi TUI only shows the source</sub></p>
      <img src="docs/imgs/codex-vs-pi-agent-tui.png" alt="Comparison of Mermaid diagram rendering between Pi with Codex Desktop and the Pi Agent TUI">
    </td>
  </tr>
</table>

</details>

<details>
<summary>Feature support by Agent</summary>

| Capability | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="docs/imgs/harness-icon-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="docs/imgs/harness-icon-opencode.svg" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DSH" src="https://img.shields.io/badge/-4D6BFE?logo=deepseek&logoColor=white" /></a> | <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="docs/imgs/harness-icon-agy.svg" /></a> | <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="docs/imgs/harness-icon-codebuddy.svg" width="24" height="24" /></a> | <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="packages/adapters/workbuddy/assets/icon.svg" width="24" height="24" /></a> | <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="docs/imgs/harness-icon-cursor.svg" /></a> | <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="docs/imgs/harness-icon-hermes.svg" /></a> | <a href="https://qoder.com/cli"><img alt="Qoder" src="packages/adapters/qoder/assets/icon.svg" width="28" height="28" /></a> | <a href="https://moonshotai.github.io/kimi-code/"><img alt="Kimi Code" src="packages/adapters/kimi-code/assets/icon.svg" width="28" height="28" /></a> | <a href="docs/harnesses/copilot/copilot-harness-integration.md"><img alt="Copilot" src="packages/adapters/copilot/assets/icon.png" width="28" height="28" /></a> | <a href="https://github.com/QwenLM/qwen-code"><img alt="Qwen Code" src="packages/adapters/qwen-code/assets/icon.svg" width="28" height="28" /></a> | <a href="docs/harnesses/devin/devin-cli-acp-integration.md"><img alt="Devin" src="packages/adapters/devin/assets/icon.svg" width="28" height="28" /></a> |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Streaming responses | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Questions / cancellation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — / ✅ |
| Model / Thinking selection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ / — | ✅ / ◐ |
| Tool approvals | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Permission modes | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cross-Agent task collaboration | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Usage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Fork | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | — | ◐ |
| Context compaction | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | — |
| Slash commands | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Edit previous message | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ◐ |

</details>

<a id="collaboration"></a>

## Agents hand work to each other

Type `#` in the chat input, pick an Agent, and hand it a self-contained task:

> Have `#claude-code` review this change on its own and flag any compatibility risks.
>
> Have `#pi` figure out why this test is flaky.
>
> Have `#omp` implement this feature while I keep working on the docs.

Every delegated task runs as a separate native session in the target Agent. It shows up in the conversation list, so you can open it anytime to check progress or continue the conversation. When it finishes, the result returns to the session that started it.

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agents work in parallel</strong><br /><sub>Each in its own session, without interfering</sub></p>
      <img src="docs/product/images/multi-agent-parallel-sessions.png" alt="Delegated sessions of several Agents running in parallel in the sidebar">
    </td>
    <td width="50%" valign="top">
      <p><strong>Reports back when done</strong><br /><sub>The originating session is notified when a delegated task ends</sub></p>
      <img src="docs/product/images/multi-agent-completion-notice.png" alt="Notice shown in the originating session after a delegated task completes">
    </td>
  </tr>
</table>

**For developers:** local programs such as terminal scripts, Claude Desktop and always-on bots can also hand tasks to these Agents and wait for results through the `codexhost delegate` / `codexhost thread` commands or MCP. See [external clients](docs/architecture/external-clients.md).

<details>
<summary><h3 id="remote-harness">Advanced: use Agents on another machine from your local UI</h3></summary>

Tasks run on the other machine while the UI stays in your local Codex Desktop. Both machines need the same CodexHost version.

| Remote machine | How to connect |
| --- | --- |
| macOS / Linux | [SSH](#ssh) |
| Windows | [Remote Control](#remote-control-experimental) (experimental) |

#### SSH

Before you start, add the remote machine in Codex Desktop under **Settings → Connections → SSH**. Your local machine can run macOS, Linux or Windows.

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
3. Pick an Agent from the composer's Agent / Model selector.

[SSH setup, diagnostics and uninstall →](docs/platforms/remote/remote-ssh-host.md)

#### Remote Control (Experimental)

Use Agents on a Windows machine from another computer, built on the pairing and sign-in of Codex Desktop's official Remote Control.

Before you start, make sure official Remote Control can already run Codex tasks. No public services or ports are opened, and Agent credentials never leave the Windows machine.

[Remote Control setup, transport boundary and diagnostics →](docs/platforms/remote/remote-control-host.md)

</details>

<a id="join-the-community"></a>

## 微信交流群

<table align="center">
  <tr>
    <td>
      <strong>微信交流群</strong><br />
      <sub>Scan the QR code to add me on WeChat (note “CodexHost”) and I will invite you to our WeChat group.</sub>
      <ul>
        <li><sub>Get help with installation</sub></li>
        <li><sub>Share feature ideas and feedback</sub></li>
        <li><sub>Talk about development</sub></li>
        <li><sub>For bugs, please open an <strong>issue</strong></sub></li>
      </ul>
      <sub><strong>Contributions are welcome.</strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="WeChat contact QR code" src="docs/imgs/wechat-contact-qrcode.jpg" />
    </td>
  </tr>
</table>

<details>
<summary><h3>Architecture and development</h3></summary>

#### How it works

Most multi-agent clients build their own chat UI and plug Agents in through a common protocol. CodexHost does it differently:

- **Desktop:** extends the official Codex Desktop via CDP / Electron Inspector, with no rebuilt chat UI and no patched installer
- **Protocol:** a CLI Shim sits in front of the official app-server and passes native Codex requests through untouched
- **Agents:** each Agent is integrated through its own native interface where one exists (Pi over RPC, Claude Code via the Agent SDK), falling back to [ACP](https://agentclientprotocol.com/) otherwise. Streaming, tool status, diffs, approvals and questions all render in Codex Desktop's native UI
- **Orchestration:** delegated tasks run as independent native sessions in the target Agent; the caller can wait for the result or let it run in the background
- **Web:** Desktop and Web connect to the same background Host, so there is one copy of each session, approval and question, and both sides see the same state

#### Development

Please read the [contributing guide](CONTRIBUTING.md) before opening an issue or PR. See [repository maintenance automation](docs/operations/repository-maintenance.md) for PR title labels, CI summaries and pre-release checks.

Requirements: the official Codex Desktop, Node.js 22.19+ or 24, and Rust.

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm start
```

| Command | Purpose |
| --- | --- |
| `npm start` | Build and start Desktop. |
| `npm start web` | Build and start Web with Web UI hot reload (default). |
| `npm start web -- --no-watch` | Build and start Web without hot reload. |
| `npm stop` | Stop the current user's local codexhost services across worktrees. |

#### Runtime architecture

Using Pi as an example, here is how a single request flows from left to right: Desktop → shared layer → Pi plugin → native process.

<div align="center">
  <img width="100%" src="docs/imgs/pi-runtime-architecture.png" alt="Runtime architecture using Pi: Desktop to the shared layer, then the Pi plugin and native process">
</div>

#### Adding a Harness

Most of the work is implementing the plugin's Manifest, factory, Adapter and Session, plus the native communication and translation logic. The Renderer still has some hard-coded wiring, so full Desktop integration takes extra work.
Tip: point your coding Agent at the in-repo [codexhost-add-harness Skill](.agents/skills/codexhost-add-harness/SKILL.md). It covers plugin structure, the shared Adapter interface, capability implementation and testing requirements.

</details>

## Acknowledgements

- Thanks to the [LINUX DO](https://linux.do/) community for their ongoing support.
- Thanks to [Paseo](https://github.com/getpaseo/paseo), whose approach to multi-Harness integration and architecture inspired ours.
- Thanks to [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness); CodexHost's Web client is built on DSH Web.

## Contributors

Thanks to everyone who has contributed to CodexHost.

<a href="https://github.com/BytePioneer-AI/codex-host/graphs/contributors">
  <img alt="CodexHost contributors" src="https://contrib.rocks/image?repo=BytePioneer-AI/codex-host" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=bytepioneer-ai%2Fcodex-host&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
  </picture>
</a>

