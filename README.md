<div align="center">

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/imgs/readme-lockup-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/imgs/readme-lockup-light.png" />
    <img src="docs/imgs/readme-lockup-light.png" alt="CodexHost" width="420" />
  </picture>
</p>

<p>
  <a href="https://github.com/BytePioneer-AI/codex-host/stargazers"><img src="https://img.shields.io/github/stars/BytePioneer-AI/codex-host?style=flat-square&label=%E2%98%85&labelColor=27272a&color=0d9488" alt="Stars" /></a>
  <a href="https://github.com/BytePioneer-AI/codex-host/releases/latest"><img src="https://img.shields.io/github/v/release/BytePioneer-AI/codex-host?label=release&style=flat-square&labelColor=27272a&color=0f766e" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/@codexhost/cli"><img src="https://img.shields.io/npm/d18m/@codexhost/cli?label=npm&style=flat-square&labelColor=27272a&color=0f766e" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/BytePioneer-AI/codex-host?label=license&style=flat-square&labelColor=27272a&color=52525b" alt="License" /></a>
  <a href="#download--install"><img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Mobile-3f3f46?style=flat-square" alt="Platforms" /></a>
</p>

<p>
  <strong>English</strong> ·
  <a href="docs/project/README.zh-CN.md">简体中文</a> ·
  <a href="docs/project/README.ko.md">한국어</a>
</p>

<h2>Run every coding agent, as one workspace.</h2>

<p>
  Unify <b>Codex</b>, <b>Claude Code</b>, <b>Pi</b>, <b>Grok</b>, and 15+ more coding agents inside <b>CodexHost's own standalone desktop app</b> —<br />
  no official Codex Desktop required (optional enhancement supported), with live Web, Mobile, and multi-machine sync.
</p>

<p>
  <b><a href="https://chost.dev/en/download">Download CodexHost</a></b> &nbsp;·&nbsp;
  <b><a href="https://chost.dev/en">Website →</a></b> &nbsp;·&nbsp;
  <a href="docs">Docs</a> &nbsp;·&nbsp;
  <a href="#community">Community</a>
</p>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/imgs/readme-hero-en-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/imgs/readme-hero-en-light.png" />
  <img src="docs/imgs/readme-hero-en-light.png" alt="CodexHost standalone desktop workbench with parallel multi-agent delegation and remote hosts" width="100%" />
</picture>

</div>

---

<a id="download--install"></a>

## Download & Install

Free and open source. Local and LAN features work **without an account** and **do not require official Codex Desktop**.

| Platform | Package & Notes | Download |
| :--- | :--- | :--- |
| **macOS** | Apple Silicon & Intel · Standalone `.dmg` _(also enhances official Codex Desktop if installed)_ | [**Download from Website**](https://chost.dev/en/download) · [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases/latest) |
| **Windows** | x64 & ARM64 · `.exe` installer / WinGet _(supports portable Codex Desktop too)_ | [**Download from Website**](https://chost.dev/en/download) · [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases/latest) |
| **Linux** | x64 & ARM64 · Self-contained `.tar.gz` _(Desktop app & headless Web daemon)_ | [**Download from Website**](https://chost.dev/en/download) · [Linux Guide](docs/platforms/linux/linux.md) |
| **Android** | Lightweight native `.apk` · Push alerts, QR pairing & multi-host switching | [**Download from Website**](https://chost.dev/en/download#mobile) · [Android Notes](apps/android-shell/README.md) |
| **iPhone & iPad** | Safari "Add to Home Screen" PWA · Direct LAN, Tailscale, or encrypted Relay | [**Mobile Setup Guide**](https://chost.dev/en/download#mobile) |
| **CLI** | Node.js 22.19+ / 24 or Windows WinGet | `npm install -g @codexhost/cli` · `winget install --id BytePioneer-AI.CodexHost --exact` |

<details>
<summary><b>Common CLI commands (Desktop / Web / Upgrade / Stop)</b></summary>

<br />

```bash
codexhost          # Launch standalone Desktop or enhanced official Codex Desktop
codexhost app      # Open lightweight standalone Desktop directly
codexhost web      # Start local Web UI and open in your browser
codexhost status   # Inspect background Host and service status
codexhost update   # Upgrade to the latest release
codexhost stop     # Stop all background services (run before npm reinstall)
```

> **Keep Web access private:** access tokens, login links, and pairing QR codes grant full control of your machine. Never share them publicly.

</details>

<details>
<summary><b>Installation troubleshooting (macOS Gatekeeper / Windows portable / Console)</b></summary>

<br />

- **Launch failed or official Codex Desktop opened without CodexHost**: run `codexhost console` (Windows: Start Menu → `codexhost console`) to open `http://127.0.0.1:4399/` for logs, version detection, and updates.
- **macOS: "App can't be verified" on first launch**:
  ```bash
  xattr -dr com.apple.quarantine /Applications/codexhost.app
  ```
- **Windows: portable unpacked Codex Desktop**: set `CODEXHOST_INSTALL_ROOT` to your unpacked directory, exit all running processes, reopen your terminal, and run `codexhost`:
  ```powershell
  [Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
  ```

</details>

---

## Highlights

- **Own Standalone Desktop + Live Multi-Surface Sync**: Ships with a lightweight Tauri desktop app on macOS, Windows, and Linux—no official Codex Desktop required. Already using Codex Desktop? Enhance it non-invasively while sharing the same local Host live with Web, Android, and iOS PWA.
- **`#` Multi-Agent Delegation & Lossless Handoff**: Type `#` in the composer to dispatch isolated native child sessions (`Claude Code`, `Pi`, `Grok`, `AGY`, etc.) in separate Git worktrees with automatic flowback, or use [Cross-Harness Handoff](docs/architecture/cross-harness-handoff.md) to transfer full context mid-thread.
- **Native Runtime Fidelity**: Connects via official SDKs, RPC, and [ACP](https://agentclientprotocol.com/) without stripping capabilities—preserving **Plan Mode**, **mid-turn Steering**, **background terminals**, **branch/worktree Fork**, **live cost & cache metrics**, and existing local logins.
- **Unified Extensions, Skills & Automation**: Install [Host Extensions](docs/architecture/desktop-ui-extensions.md) once for both Desktop and Web, share reusable workflows via the [Unified Skill Library](docs/architecture/skill-library.md), schedule recurring runs with [Schedules](docs/product/harness-schedules.md), and drive local agents from scripts/bots via [CLI, MCP & HTTP](docs/architecture/external-clients.md) (`codexhost delegate`).
- **Local-First Privacy**: Code, threads, and credentials stay on your own machines and connect directly to official providers—zero third-party proxy.

---

## Multi-Host & Mobile

Pull Macs, Linux dev servers, and Windows workstations into one sidebar, and approve or reply from your phone anywhere.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/imgs/readme-remote-en-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/imgs/readme-remote-en-light.png" />
    <img src="docs/imgs/readme-remote-en-light.png" alt="CodexHost Multi-Host Peer Hub and Mobile Relay approval view" width="100%" />
  </picture>
</p>

- **[Multi-Host Peer Hub](docs/product/multi-remote-peers.md)**: Aggregate remote machines into one sidebar with cross-host delegation and remote file previews.
- **[Scan-to-Connect Mobile Access](docs/product/web-remote-access.md)**: Connect over LAN, Tailscale, or encrypted Relay with zero port forwarding; deploy a **[Self-Hosted Relay](docs/product/self-hosted-relay.md)** on your own infrastructure whenever needed.

<details>
<summary><b>Advanced: SSH Remote & Windows Remote Control</b></summary>

<br />

You can also reuse official Codex Desktop remote channels to control agents on another machine (both sides must run the same CodexHost version):
- **macOS / Linux (SSH Remote)**: run `codexhost remote install && codexhost remote start` on the remote host — see [SSH Remote Guide →](docs/platforms/remote/remote-ssh-host.md)
- **Windows (Remote Control · Experimental)**: reuses official Remote Control pairing without opening public ports — see [Remote Control Guide →](docs/platforms/remote/remote-control-host.md)

</details>

---

<a id="supported-agents"></a>

## Supported Agents

Native **Codex** plus **19+ preinstalled coding agents** reusing your local CLIs and credentials. See **[Capability Boundaries →](docs/harnesses/capability-boundaries.md)**.

<details>
<summary><b>View all preinstalled coding agents</b></summary>

<br />

| | | | |
| :--- | :--- | :--- | :--- |
| [Codex](https://openai.com/codex/) | [Claude Code](https://code.claude.com/docs/en/quickstart) | [Pi](https://pi.dev/) | [Oh My Pi](https://github.com/can1357/oh-my-pi) |
| [OpenCode](https://opencode.ai/docs/) | [Grok](https://grok.com/) | [Cursor CLI](https://cursor.com/docs/cli/overview) | [GitHub Copilot](docs/harnesses/copilot/copilot-harness-integration.md) |
| [Antigravity (AGY)](https://antigravity.google/product/antigravity-cli) | [Devin](https://docs.devin.ai/cli) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | [Qwen Code](https://github.com/QwenLM/qwen-code) |
| [Kimi Code](https://moonshotai.github.io/kimi-code/) | [Kiro CLI](https://kiro.dev/docs/cli/) | [CodeBuddy](https://www.codebuddy.cn/home/) | [WorkBuddy](https://www.workbuddy.ai/docs/workbuddy/Quickstart) |
| [Qoder / Qoder CN](https://qoder.com/cli) | [Hermes](https://hermes-agent.nousresearch.com/docs) | [ZCode](https://zcode.z.ai/) | [Build a custom Harness →](.agents/skills/codexhost-add-harness/SKILL.md) |

</details>

---

## Sponsors

<table>
<tr>
<td width="160" align="center"><a href="https://vibeapi.cc/sign-up?aff=AOYp"><img src="docs/imgs/sponsors/vibeapi.jpg" alt="VibeAPI" width="145" /></a></td>
<td>Thanks to <b>VibeAPI</b> for sponsoring CodexHost! Built for developers and teams, VibeAPI provides unified access to Codex, Claude, and leading AI models with a traceable self-managed account pool, 99.9% SLA, 95%+ cache hit rate, 24/7 human support, and enterprise invoicing. <a href="https://vibeapi.cc/sign-up?aff=AOYp">Learn more about VibeAPI →</a></td>
</tr>
</table>

---

<a id="community"></a>

## Community

- **GitHub**: Report bugs or request agent adapters in [Issues](https://github.com/BytePioneer-AI/codex-host/issues), and share workflows in [Discussions](https://github.com/BytePioneer-AI/codex-host/discussions).
- **WeChat Group**: Scan the QR code below with note **"CodexHost"** to join the developer group.

<details>
<summary><b>Show WeChat Group QR Code</b></summary>

<br />

<p align="center">
  <img width="210" alt="WeChat Group QR Code" src="docs/imgs/wechat-contact-qrcode.jpg" />
</p>

</details>

<details>
<summary><b>Build from Source & Development</b></summary>

<br />

Requirements: Node.js 22.19+ or 24, Rust (plus official Codex Desktop if developing the enhanced desktop mode). See [CONTRIBUTING.md](CONTRIBUTING.md) and [Repository Maintenance](docs/operations/repository-maintenance.md).

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm run start:app   # Launch standalone Desktop
```

| Command | Purpose |
| :--- | :--- |
| `npm run start:app` | Build and launch standalone Desktop |
| `npm run start:web` | Build and launch standalone Web UI (hot reload enabled) |
| `npm start` | Build and launch official Codex Desktop enhanced mode |
| `npm stop` | Stop local codexhost background services for the current user |

</details>

---

## Acknowledgements & Contributors

Thanks to the [LINUX DO](https://linux.do/) community, [Paseo](https://github.com/getpaseo/paseo) (multi-harness architecture inspiration), [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) (Web UI foundation), and everyone contributing to CodexHost.

<a href="https://github.com/BytePioneer-AI/codex-host/graphs/contributors">
  <img alt="CodexHost Contributors" src="https://contrib.rocks/image?repo=BytePioneer-AI/codex-host" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=bytepioneer-ai%2Fcodex-host&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
  </picture>
</a>

## License

Released under the [LGPL-3.0](LICENSE) License.
