<div align="center">

# CodexHost

**Run Pi and other Agent Harnesses inside Codex Desktop**

We believe **Codex Desktop** provides one of the best desktop development experiences.

But **Codex** is not the only capable **Agent Harness**. Some developers prefer **Claude Code** or **Pi Agent**.

**codexhost** lets you choose the **Agent** that actually executes your tasks inside **Codex Desktop**, while preserving the native Codex experience and letting those Agents work together.

⭐ If this project helps you, please give it a Star! ⭐

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="imgs/badge-omp-v5.svg" /></a>
  <a href="https://github.com/QwenLM/qwen-code"><img alt="Qwen Code" src="https://img.shields.io/badge/Qwen_Code-6950EF?logo=qwen&logoColor=white" /></a>
</p>

<p align="center">
  <sub><a href="../README.md">简体中文</a> · English · <a href="README.ko.md">한국어</a></sub>
</p>

</div>

<p align="center">
  <strong>Quick navigation:</strong>
  <a href="#interface-preview">Interface preview</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#feature-status">Feature status</a> •
  <a href="#cross-agent-collaboration">Cross-Agent collaboration</a> •
  <a href="#remote-harness">Remote Harness</a>
</p>

## Interface Preview

No app switching required: use Pi, Claude Code, OMP, Grok Build, and DeepSeek Harness directly in the same Codex Desktop window.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### Interface

![Pi, Oh My Pi, Grok Build, and DeepSeek Harness running as independent threads in Codex Desktop](imgs/codexhost-interface-overview.png)

## Quick Start

**Use npm**

> Supports macOS, Windows, and [x64/ARM64 Linux](linux.md).

```bash
npm install -g @codexhost/cli
codexhost
```

**Or download** [installers](https://github.com/BytePioneer-AI/codex-host/releases) (macOS, Windows)

<details>
<summary>Installation Troubleshooting</summary>

**macOS** - Apple verification issue

If Apple says the app cannot be verified when you first open it, run:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

Then open `codexhost` again.

**Windows** - Portable Codex Desktop

For a portable/extracted Codex Desktop, set `CODEXHOST_INSTALL_ROOT` to the extracted Codex Desktop directory:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

Fully quit Codex Desktop, open a new terminal, and start codexhost.

</details>

### Interaction Examples

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Full workspace</strong></p>
      <div align="center">
        <img width="90%" src="imgs/codexhost-full-workspace.png" alt="The complete CodexHost workspace in Codex Desktop, showing the project tree, conversation area, and multiple Agent selectors">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent and Model selection</strong></p>
      <img src="imgs/agent-harness-selector.png" alt="Choose the Agent and Model that will execute the task before submitting it; Codex, Pi, Claude Code, DeepSeek Harness, Grok, and Oh My Pi are available">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage and cost information</strong></p>
      <img src="imgs/usage-panel.png" alt="The Usage panel shows context, cache hits, and estimated cost">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="imgs/grok-usage-limits.png" alt="Remaining allowance and reset times for the five-hour and seven-day windows">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid diagram rendering</strong></p>
      <div align="center">
        <img width="90%" src="imgs/codex-vs-pi-agent-tui.png" alt="Comparison of Mermaid diagram rendering between Pi with Codex Desktop and the Pi Agent TUI">
      </div>
    </td>
  </tr>
</table>

## Feature Status

| Capability | <a href="https://openai.com/codex/"><img alt="Codex" src="imgs/badge-codex.svg" /></a> | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="imgs/badge-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a> | <a href="https://github.com/QwenLM/qwen-code"><img alt="Qwen Code" src="https://img.shields.io/badge/Qwen_Code-6950EF?logo=qwen&logoColor=white" /></a> |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Streaming responses | Native | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool status | Native | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | Native | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Questions / cancellation | Native | ✅ | — / ✅ | ✅ | ✅ | ✅ | — / ✅ |
| Model / Thinking selection | Native | ✅ | ✅ | ✅ | ✅ | 🚧 | ✅ / — |
| Tool approvals | Native | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| Permission modes | Native | — | ✅ | ✅ | ✅ | — | ✅ |
| Cross-Agent task collaboration | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Usage | Native | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fork | Native | ✅ | ✅ | ✅ | ✅ | — | — |
| Context compaction | Native | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Slash commands | Native | ✅ | ✅ | ✅ | ✅ | — | — |
| Edit previous message | Native | ✅ | ✅ | ✅ | ✅ | — | — |

## Cross-Agent collaboration

You can ask the current Agent to delegate an independent task to another Harness. For example:

> Ask `@claude-code` to review this change independently and identify compatibility risks.
>
> Ask `@pi` to investigate why this test fails intermittently.
>
> Ask `@omp` to implement this feature while I continue working on the documentation.

codexhost creates a separate Native Session for the target Harness. The delegated session appears in the Codex Desktop conversation list, where you can open it, inspect progress, or continue the conversation.

<details>
<summary><h3 id="remote-harness">Remote Harness</h3></summary>

Use Harnesses on remote nodes within Codex Desktop on your local machine, executing tasks on remote machines while continuing to use Codex Desktop’s unified interface. Both ends need to install the same codexhost version.

**Two connection methods are supported:**

#### 1️⃣ SSH Remote (recommended for Mac/Linux servers)

Connect to and control Harnesses on other development nodes over SSH through Codex Desktop’s native SSH workspace.

| Client ↓ / Remote Host → | macOS | Linux | Windows |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ❌ |
| Linux | ✅ | ✅ | ❌ |
| Windows | ✅ | ✅ | ❌ |

Run this on the SSH remote host:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

Then start Codex Desktop through local codexhost, open the SSH workspace, and choose the target Harness in the remote composer’s Agent/Model selector.

[Remote SSH setup, diagnostics, and uninstall →](remote-ssh-host.md)

#### 2️⃣ Remote Control Remote (experimental · recommended for Windows)

When Windows is the controlled Host, codexhost can preserve Codex Desktop’s official pairing, account authentication, and relay while making Harnesses installed and authenticated on Windows available in the paired controller Desktop. You can use Harnesses on Windows in the Codex Desktop of another paired computer. Both computers need the same codexhost build, and stock Codex must already work through official Remote Control.

This path does not add a public service or TCP listener. Harness credentials remain on the controlled Windows machine.

[Remote Control requirements, transport boundary, and diagnostics →](remote-control-host.md)

</details>

<details>
<summary><h3>How it works</h3></summary>

Most multi-agent clients connect different Harnesses through the [ACP](https://agentclientprotocol.com/) protocol. This is quick to integrate, but native capabilities such as tools, approvals, permissions, diffs, and questions are first reduced to a common denominator and then approximated again in the UI.

codexhost takes a different approach:

- **Desktop layer:** Use CDP / Electron Inspector to enhance the official Codex Desktop with Agent selection and session controls. The chat shell is not recreated, and the official installer is not modified.
- **Protocol layer:** Use a CLI shim to transparently connect to the official app-server and forward Codex requests unchanged.
- **Harness layer:** Integrate each Harness through its native interface. Pi uses the official RPC, while Claude Code uses the Agent SDK / CLI. Each Harness is then projected into the Desktop's existing streaming output, tools, diffs, approvals, and questions.
- **Orchestration layer:** Create a separate Native Session and regular writable Thread for the delegated Harness, and store the delegation relation separately. Creation and result observation remain separate, so the initiating Agent explicitly chooses whether to read, wait, or leave the task running in the background.

The goal is fidelity, not merely making the conversation work. Streaming, tool status, reliable patches, native approvals, and questions should come from the Harness itself whenever possible, rather than being guessed or fabricated by the Host.

</details>

## Acknowledgements

- Thanks to the [LINUX DO](https://linux.do/) community for its continued support.
- Thanks to the [Paseo](https://github.com/getpaseo/paseo) project for inspiring and informing the multi-Harness integration approach and architecture.
