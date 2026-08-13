<div align="center">

# codexhost

**Run Pi, Claude Code, and Grok inside [Codex Desktop](https://openai.com/codex/)**

We believe **Codex Desktop** currently provides one of the best desktop development experiences.

But **Codex** is not the only capable **Agent Harness**. Some developers prefer **Claude Code**, **Pi Agent**, or **Grok CLI**.

**codexhost** lets you choose the **Agent** that actually executes your tasks inside **Codex Desktop**, while preserving the native Codex experience.

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok Build" src="https://img.shields.io/badge/Grok-Build-000000?logo=x&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p><a href="../README.md">中文 README</a></p>

</div>

## Preview

Pi, Claude Code, and Grok run as independent sessions in the same Codex Desktop window. Streaming output, reasoning, tool status, and approvals are rendered when supported by the selected Harness.

![Full demo of Pi and Claude Code running in Codex Desktop](imgs/demo.gif)

### Interface

![Pi and Claude Code running as independent threads in Codex Desktop](imgs/app-overview.png)

## Feature Status

| Capability | Codex | Pi | Claude Code | Grok |
| --- | --- | --- | --- | --- |
| Streaming replies | Native | ✅ | ✅ | ✅ |
| Thinking | Native | ✅ | ✅ | ✅ |
| Tool status | Native | ✅ | ✅ | ✅ |
| Edit diffs | Native | ✅ | ✅ | — |
| Ask / cancel | Native | ✅ | ✅ | 🚧 |
| Model / thinking selection | Native | ✅ | ✅ | ✅ |
| Tool approvals | Native | ✅ | ✅ | ✅ |
| Permission modes | Native | — | ✅ | — |
| Usage | Native | ✅ | ✅ | ✅ |
| Session resume | Native | ✅ | ✅ | ✅ |
| Thread management | Native | ✅ | 🚧 | 🚧 |
| Fork | Native | ✅ | ✅ | — |
| Context compaction | Native | ✅ | ✅ | — |
| Slash commands | Native | 🚧 | 🚧 | — |
| Revise the previous message | Native | ✅ | 🚧 | — |

`✅` supported, `🚧` partial or in progress, `—` not currently supported.

## Quick Start

**Option 1: Install with npm**

```bash
npm install -g @codexhost/cli
codexhost
```

**Option 2: Download an installer**

Download the latest installer from [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases), then choose the file matching your operating system and CPU architecture.

After installing on macOS, if Apple says it cannot verify the app when you first open it, run the following command in Terminal:
```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```
Then open `codexhost` again.

<details>
<summary><h3>How it works</h3></summary>

Harnesses expose different interfaces and capabilities. codexhost does not flatten them to the lowest common denominator. Each Harness keeps an independent Adapter:

- **Desktop layer:** Use CDP / Electron Inspector to enhance the official Codex Desktop with Agent selection and session controls. The chat shell is not recreated, and the official installer is not modified.
- **Protocol layer:** Use a CLI shim to transparently connect to the official app-server and forward Codex requests unchanged.
- **Harness layer:** Pi uses the official RPC, Claude Code uses the Agent SDK / CLI, and Grok CLI uses official [ACP](https://agentclientprotocol.com/) v1 over stdio. Each Adapter projects only reliable capabilities into the Desktop.

The goal is fidelity, not merely making the conversation work. Streaming, tool status, reliable patches, and approvals are shown only when the Harness can express them accurately; the Host does not guess or manufacture them.

</details>

### Interaction Examples

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent and Model selection</strong></p>
      <img src="imgs/agent-selector.png" alt="Choose the Agent and Model that will execute the task before submitting it">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage and cost information</strong></p>
      <img src="imgs/usage-panel.png" alt="The Usage panel shows context, cache hits, and estimated cost">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid diagram rendering</strong></p>
      <img src="imgs/codex-vs-pi-agent-tui.png" alt="Comparison of Mermaid diagram rendering between Pi with Codex Desktop and the Pi Agent TUI">
    </td>
  </tr>
</table>
