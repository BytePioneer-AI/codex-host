<div align="right">
  <a href="docs/README.zh-CN.md">简体中文</a> | English
</div>

<div align="center">

# CodexHost

**Run Pi and other Agent Harnesses inside Codex Desktop**

We believe **Codex Desktop** provides one of the best desktop development experiences.

But **Codex** is not the only capable **Agent Harness**. Some developers prefer **Claude Code** or **Pi Agent**.

**CodexHost** lets you choose the **Agent** that actually executes your tasks inside **Codex Desktop**, while preserving the native Codex experience.

⭐ If this project helps you, please give it a Star! ⭐

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="docs/imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
</p>

</div>

## Interface Preview

Pi, Claude Code, DeepSeek Harness, and Grok run as independent sessions in the same Codex Desktop window. Streaming output, thinking, tool status, diffs, approvals, and questions are rendered in real time when supported by each Harness.

![Full demo of Pi and Claude Code running in Codex Desktop](docs/imgs/demo.gif)

### Interface

![Pi, Claude Code, and DeepSeek Harness running as independent threads in Codex Desktop](docs/imgs/app-overview.png)

## Feature Status

| Capability | Codex | Pi | Claude Code | Grok Build | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- |
| Streaming replies | Native | ✅ | ✅ | ✅ | ✅ |
| Thinking | Native | ✅ | ✅ | ✅ | — |
| Tool status | Native | ✅ | ✅ | ✅ | ✅ |
| Edit diffs | Native | ✅ | ✅ | ✅ | ✅ |
| Ask / cancel | Native | ✅ | ✅ | 🚧 | ✅ |
| Model / thinking selection | Native | ✅ | ✅ | ✅ | 🚧 |
| Tool approvals | Native | ✅ | ✅ | ✅ | ✅ |
| Permission modes | Native | — | ✅ | — | — |
| Usage | Native | ✅ | ✅ | ✅ | ✅ |
| Session resume | Native | ✅ | ✅ | ✅ | ✅ |
| Thread management | Native | ✅ | 🚧 | 🚧 | 🚧 |
| Fork | Native | ✅ | ✅ | — | — |
| Context compaction | Native | ✅ | ✅ | — | ✅ |
| Slash commands | Native | 🚧 | 🚧 | — | — |
| Revise the previous message | Native | ✅ | 🚧 | — | — |

`✅` supported, `🚧` partial or in progress, `—` not currently supported.

## Quick Start

**Option 1: Install with npm**

```bash
npm install -g @codexhost/cli
codexhost
```

npm supports macOS, Windows, and [x64 Linux](docs/linux.md).

**Option 2: Download an installer**

Download the latest installer from [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases), then choose the file matching your operating system and CPU architecture. Installers currently support macOS and Windows.

After installing on macOS, if Apple says it cannot verify the app when you first open it, run the following command in Terminal:
```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```
Then open `codexhost` again.

On Windows, if you use a portable/extracted Codex Desktop, set `CODEXHOST_INSTALL_ROOT` to the directory containing `app\ChatGPT.exe` before launching codexhost:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

Then open a new terminal and start codexhost. This applies to both the npm command and the Windows installer.
<details>
<summary><h3>How it works</h3></summary>

Most multi-agent clients connect different Harnesses through the [ACP](https://agentclientprotocol.com/) protocol. This is quick to integrate, but native capabilities such as tools, approvals, permissions, diffs, and questions are first reduced to a common denominator and then approximated again in the UI.

codexhost takes a different approach:

- **Desktop layer:** Use CDP / Electron Inspector to enhance the official Codex Desktop with Agent selection and session controls. The chat shell is not recreated, and the official installer is not modified.
- **Protocol layer:** Use a CLI shim to transparently connect to the official app-server and forward Codex requests unchanged.
- **Harness layer:** Integrate each Harness through its native interface: Pi uses the official RPC, while Claude Code uses the Agent SDK / CLI. Each Harness is then projected into the Desktop's existing streaming output, tools, diffs, approvals, and questions.

The goal is fidelity, not merely making the conversation work. Streaming, tool status, reliable patches, native approvals, and questions should come from the Harness itself whenever possible, rather than being guessed or fabricated by the Host.

</details>

### Interaction Examples

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent and Model selection</strong></p>
      <img src="docs/imgs/grok-agent-selector.png" alt="Choose the Agent and Model that will execute the task before submitting it; Grok is now in the list">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage and cost information</strong></p>
      <img src="docs/imgs/usage-panel.png" alt="The Usage panel shows context, cache hits, and estimated cost">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid diagram rendering</strong></p>
      <img src="docs/imgs/codex-vs-pi-agent-tui.png" alt="Comparison of Mermaid diagram rendering between Pi with Codex Desktop and the Pi Agent TUI">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Grok showcase</strong></p>
      <img src="docs/imgs/grok-account-credits.png" alt="Grok showcase: account credits with weekly limits, usage, and reset time at a glance">
    </td>
  </tr>
</table>

## Acknowledgements

- Thanks to the [LINUX DO](https://linux.do/) community for its continued support.
- Thanks to the [Paseo](https://github.com/getpaseo/paseo) project for inspiring and informing the multi-Harness integration approach and architecture.
