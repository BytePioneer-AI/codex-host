# Linux support

codexhost supports x64 and ARM64 Linux through the npm package or a self-contained `.tar.gz` archive. To use Codex Desktop, install the official ChatGPT App matching the current architecture first; Web works without it.

### npm

```bash
npm install -g @codexhost/cli
codexhost
```

### Archive

Each Release publishes `codexhost-<version>-linux-x64.tar.gz` and `codexhost-<version>-linux-arm64.tar.gz`. The archive bundles its own Node.js runtime, so neither Node.js nor npm is required. Extract it into a directory owned by the current user, link the launcher into `~/.local/bin`, and make sure `~/.local/bin` is on `PATH` (for example, `export PATH="$HOME/.local/bin:$PATH"`):

```bash
mkdir -p ~/.local/share
tar -xzf codexhost-<version>-linux-x64.tar.gz -C ~/.local/share
mv ~/.local/share/codexhost-<version>-linux-x64 ~/.local/share/codexhost
mkdir -p ~/.local/bin
ln -sf ~/.local/share/codexhost/bin/codexhost ~/.local/bin/codexhost
codexhost
```

`codexhost update` and the in-app updater download the matching archive from GitHub Releases, verify its SHA-256, extract and verify it beside the installation, and then swap it into place as a whole; if replacement or post-swap verification fails, the previous directory is restored (failures before the swap leave the existing installation untouched, while post-swap restart failures do not roll back the replaced files). Both the installation directory and its parent must therefore be writable by the user running codexhost, so do not install the archive as root into system directories. Use one installation method at a time: before switching between npm and the archive, run `codexhost stop` and remove the other installation. `codexhost autostart on` registers the launcher of the installation that runs it.

## Supported environment

The Linux release supports the official ChatGPT `.deb` and `.rpm` packages on x86-64 and ARM64. The codexhost Linux native binaries use glibc 2.28 as their release baseline, matching the official Node.js 22 and 24 Linux binaries (including the one bundled in the archive), and can load on systems with glibc 2.28 or newer, including RHEL 8-family distributions used as Remote SSH hosts; the official ChatGPT App's distribution support remains defined by OpenAI's documentation. codexhost verifies the production package metadata, native ELF architecture, and these packaged entry points:

- launcher: `/usr/bin/chatgpt`
- installation: `/usr/lib/chatgpt`
- Desktop executable: `/usr/lib/chatgpt/ChatGPT`

The runtime requires a mounted `/proc` and Linux `pidfd` support. Snap, Flatpak, AppImage, local or relocated ChatGPT installations, wrapper or `alternatives` launchers, and cross-architecture execution are not supported. musl-based distributions such as Alpine are not supported. codexhost does not publish `.deb` or `.rpm` packages.

Host and Web service startup requires `HOME` to be set to an absolute path, including when `XDG_RUNTIME_DIR` and a custom data directory are set. The services register their supervisor under `$HOME/.codexhost/independent-processes`, and npm updates use `$HOME/.codexhost/updates`.

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
