# Linux support

codexhost supports x64 Linux through the npm package. Install the official ChatGPT App first, then install codexhost:

```bash
npm install -g @codexhost/cli
codexhost
```

## Supported environment

The first Linux release intentionally supports the official ChatGPT `.deb` and `.rpm` packages on x86-64. codexhost verifies the production package metadata and these packaged entry points:

- launcher: `/usr/bin/chatgpt`
- installation: `/usr/lib/chatgpt`
- Desktop executable: `/usr/lib/chatgpt/ChatGPT`

The runtime requires a mounted `/proc` and Linux `pidfd` support. Snap, Flatpak, AppImage, local or relocated installations, wrapper or `alternatives` launchers, ARM64, and Linux installer/self-update packages are not supported yet.

## Compatibility warnings

When the Desktop Controller reports a warning or degraded capability, codexhost shows the Desktop and codexhost versions, capability, reason, and observed identity before it launches the managed session. On an interactive terminal you can continue once, continue and remember that exact warning, open the latest release, launch stock ChatGPT, or cancel. Non-interactive launches cancel by default; only **Continue and remember** writes an acknowledgement.

## Process ownership

codexhost refuses to take over an independently running ChatGPT App. Quit ChatGPT completely before launching codexhost. A managed launch uses the official launcher but identifies and supervises the real Desktop executable through `/proc`; shutdown signals are sent only after PID, start time, and executable identity are revalidated.

## Diagnosis

```bash
codexhost inspect
codexhost --version
```

`inspect` reports the recognized package identity, version, launcher, executable, and running process IDs. After a ChatGPT App update, upgrade codexhost before continuing if the compatibility check reports an unsupported Desktop identity.
