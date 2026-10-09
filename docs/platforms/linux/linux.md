# Linux support

codexhost supports x64 and ARM64 Linux through the npm package. Install the official ChatGPT App matching the current architecture first, then install codexhost:

```bash
npm install -g @codexhost/cli
codexhost
```

## Supported environment

The Linux release supports the official ChatGPT `.deb` and `.rpm` packages on x86-64 and ARM64. The codexhost Linux native binaries use glibc 2.28 as their release baseline, matching the official Node.js 22 Linux binaries, and can load on systems with glibc 2.28 or newer, including RHEL 8-family distributions used as Remote SSH hosts; the official ChatGPT App's distribution support remains defined by OpenAI's documentation. codexhost verifies the production package metadata, native ELF architecture, and these packaged entry points:

- launcher: `/usr/bin/chatgpt`
- installation: `/usr/lib/chatgpt`
- Desktop executable: `/usr/lib/chatgpt/ChatGPT`

The runtime requires a mounted `/proc` and Linux `pidfd` support. Snap, Flatpak, AppImage, local or relocated installations, wrapper or `alternatives` launchers, cross-architecture execution, and codexhost Linux installer packages are not supported. codexhost is installed and updated through npm on Linux.

## Native Codex CLI

Use `codexhost launch --codex-cli /absolute/path/to/codex` or set `CODEX_CLI_PATH` in the Launcher's environment to select the native Codex CLI independently. Without an override, the packaged CLI remains the default; an invalid override produces an error. This setting does not expand supported Desktop installation formats. See [Native Codex CLI selection](../../architecture/native-codex-cli-selection.md) for precedence, validation, and diagnostics.

## Renderer compatibility

Renderer integration failures are recovered in the background and do not display compatibility dialogs or write local warning acknowledgements. While an external Agent integration is unavailable, the managed Desktop remains usable with official Codex routing. The initial Controller handshake still fails closed on malformed or unsupported readiness output.

## Process ownership

codexhost refuses to take over an independently running ChatGPT App. Quit ChatGPT completely before launching codexhost. A managed launch starts the verified Desktop executable directly and supervises it through `/proc`; stock ChatGPT launches still use the official launcher. Shutdown signals are sent only after PID, start time, and executable identity are revalidated.

## Diagnosis

```bash
codexhost inspect
codexhost --version
```

`inspect` reports the recognized package identity, version, launcher, executable, and running process IDs. After a ChatGPT App update, use it to confirm that codexhost still recognizes the installed Desktop. Renderer integration retries automatically when a supported surface is temporarily unavailable.
