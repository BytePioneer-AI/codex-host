---
title: Troubleshooting
description: Diagnose startup failures, install agent CLIs, and export logs from the Local Console on port 4399.
---

# Troubleshooting

If Codex Desktop fails to open, or opens without the agent selector, run:

```bash
codexhost console
```

This opens `http://127.0.0.1:4399/` in your browser (loopback-only, no login required). On Windows, you can also launch **codexhost console** from the Start Menu.

**The Local Console works even when Codex Desktop cannot start**:

- **Overview**: Shows your CodexHost version, Codex Desktop version, and the exact failure step and error message if startup or UI injection failed.
- **Export diagnostic bundle**: Packages Host logs into a zip with your home directory path automatically redacted to `~` for GitHub issues.
- **Connections**: Lists which agent CLIs are detected and signed in on your machine, with one-click install and upgrade actions.
- **Updates & remote hosts**: Update CodexHost while Desktop is closed, configure mobile Web access, or manage SSH hosts.

::: info Info
Port `4399` is the diagnostics and settings console. To chat with agents in a browser, run `codexhost web` (port `4400`).
:::

## Common issues

### macOS: `"codexhost.app" can't be opened / verified`

Clear the Gatekeeper quarantine attribute in Terminal, then open the app again:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

### An agent is missing from the composer selector

Open **codexhost Settings → Connections** (or check Connections in `codexhost console`). CodexHost does not bundle third-party agent binaries—install and sign in to the corresponding CLI (`claude`, `pi`, `agy`, etc.), or install it directly from the Connections page.

### Windows: Using a portable / extracted Codex Desktop

If Codex Desktop lives in a custom directory rather than the default install path, point `CODEXHOST_INSTALL_ROOT` to that folder in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

Then **quit Codex Desktop completely**, open a new terminal window, and run `codexhost`.

### Check running services

```bash
codexhost status
```

Read-only check; prints the live state of the Host, Web service, versions, and login autostart without starting or restarting anything.

### Clean uninstall

- **Windows installer**: Run the standard Windows uninstaller, which stops background services and disables login autostart automatically.
- **macOS app or npm package**: Stop services and disable autostart before removing the app or running `npm uninstall -g @codexhost/cli`:
  ```bash
  codexhost stop
  codexhost autostart off
  ```

## Local files and privacy

Session mappings, logs, and settings live under `~/.codexhost` by default; CodexHost never uploads source code or transcripts. See [PRIVACY.md](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/PRIVACY.md) for details.
