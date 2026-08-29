# Linux support

codexhost supports x64 Linux through the npm package. Install the official ChatGPT App first, then install codexhost:

```bash
npm install -g @codexhost/cli
codexhost
```

## Supported environment

The first Linux release intentionally supports the official ChatGPT `.deb` and `.rpm` packages on x86-64. The codexhost Linux x64 native binaries use glibc 2.35 as their release baseline and can load on systems with glibc 2.35 or newer; the official ChatGPT App's distribution support remains defined by OpenAI's documentation. codexhost verifies the production package metadata and these packaged entry points:

- launcher: `/usr/bin/chatgpt`
- installation: `/usr/lib/chatgpt`
- Desktop executable: `/usr/lib/chatgpt/ChatGPT`

The runtime requires a mounted `/proc` and Linux `pidfd` support. Snap, Flatpak, AppImage, local or relocated installations, wrapper or `alternatives` launchers, ARM64, and Linux installer/self-update packages are not supported yet.

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
