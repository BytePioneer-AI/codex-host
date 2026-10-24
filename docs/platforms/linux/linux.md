# Linux support

codexhost supports x64 and ARM64 Linux through the npm package. Install the official ChatGPT App matching the current architecture first, then install codexhost:

```bash
npm install -g @karlorz/codexhost-cli
codexhost
```

## Supported environment

The Linux release supports the official ChatGPT `.deb` and `.rpm` packages on x86-64 and ARM64. The codexhost Linux native binaries use glibc 2.28 as their release baseline, matching the official Node.js 22 Linux binaries, and can load on systems with glibc 2.28 or newer, including RHEL 8-family distributions used as Remote SSH hosts; the official ChatGPT App's distribution support remains defined by OpenAI's documentation. codexhost verifies the production package metadata, native ELF architecture, and these packaged entry points:

- launcher: `/usr/bin/chatgpt`
- installation: `/usr/lib/chatgpt`
- Desktop executable: `/usr/lib/chatgpt/ChatGPT`

The runtime requires a mounted `/proc` and Linux `pidfd` support. Snap, Flatpak, AppImage, local or relocated installations, wrapper or `alternatives` launchers, cross-architecture execution, and codexhost Linux installer packages are not supported. codexhost is installed and updated through npm on Linux.

## Renderer compatibility

Renderer integration failures are recovered in the background and do not display compatibility dialogs or write local warning acknowledgements. While an external Agent integration is unavailable, the managed Desktop remains usable with official Codex routing. The initial Controller handshake still fails closed on malformed or unsupported readiness output.

## Process ownership

codexhost refuses to take over an independently running ChatGPT App. Quit ChatGPT completely before launching codexhost. A managed launch starts the verified Desktop executable directly and supervises it through `/proc`; stock ChatGPT launches still use the official launcher. Shutdown signals are sent only after PID, start time, and executable identity are revalidated.

When an active Wayland session is detected (such as when `WAYLAND_DISPLAY` is present), managed launches automatically append `--ozone-platform=wayland`, `--enable-wayland-ime`, and `--wayland-text-input-version=3` so IME candidate windows (such as Fcitx5) render with native Wayland transparency instead of opaque black borders under XWayland. To opt out, set `CODEXHOST_DISABLE_WAYLAND=1` (for example, `CODEXHOST_DISABLE_WAYLAND=1 codexhost`).

## Diagnosis

```bash
codexhost inspect
codexhost --version
```

`inspect` reports the recognized package identity, version, launcher, executable, and running process IDs. After a ChatGPT App update, use it to confirm that codexhost still recognizes the installed Desktop. Renderer integration retries automatically when a supported surface is temporarily unavailable.
