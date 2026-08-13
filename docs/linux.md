# Linux support

CodexHost supports x64 Linux through the npm package. Install the official ChatGPT App first, then install CodexHost:

```bash
npm install -g @codexhost/cli
codexhost
```

## Supported environment

The first Linux release intentionally supports the official ChatGPT `.deb` and `.rpm` packages on x86-64. CodexHost verifies the production package metadata and these packaged entry points:

- launcher: `/usr/bin/chatgpt`
- installation: `/usr/lib/chatgpt`
- Desktop executable: `/usr/lib/chatgpt/ChatGPT`

The runtime requires a mounted `/proc` and Linux `pidfd` support. Snap, Flatpak, AppImage, local or relocated installations, wrapper or `alternatives` launchers, ARM64, and Linux installer/self-update packages are not supported yet.

## Process ownership

CodexHost refuses to take over an independently running ChatGPT App. Quit ChatGPT completely before launching CodexHost. A managed launch uses the official launcher but identifies and supervises the real Desktop executable through `/proc`; shutdown signals are sent only after PID, start time, and executable identity are revalidated.

## Diagnosis

```bash
codexhost inspect
codexhost --version
```

`inspect` reports the recognized package identity, version, launcher, executable, and running process IDs. After a ChatGPT App update, upgrade CodexHost before continuing if the compatibility check reports an unsupported Desktop identity.
