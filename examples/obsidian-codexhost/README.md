# Obsidian CodexHost example

English | [简体中文](README.zh-CN.md)

Desktop-only Obsidian client for the existing local CodexHost runtime.
It does not start or install another Agent host.

## Host prerequisite

A local CodexHost started by the patched Launcher enables External UI by
default. Set `CODEXHOST_EXTERNAL_UI=0` to opt out.

For a standalone development Host, enable it explicitly:

```bash
CODEXHOST_EXTERNAL_UI=1 ...
```

The Host publishes a private `~/.codexhost/runtime.json` descriptor and
listens only on `127.0.0.1`.

## Current MVP

Use **Open CodexHost chat** or the bot ribbon icon. The right-side view supports:

- Codex plus installed Harness discovery and selection
- Codex default-model discovery through `model/list`
- External Harness routing through CodexHost plugin transport models
- `thread/start` with the Obsidian Vault as `cwd`
- `turn/start`
- streaming `item/agentMessage/delta`
- reasoning summary rendering
- command/tool output rendering
- external Harness approval dialogs
- external Harness question dialogs
- `turn/interrupt` through the Stop button
- a new Thread when the selected Agent changes

Press Enter to send and Shift+Enter for a newline.

## Next layer

The next UI layer is file diffs, richer tool cards, approval persistence scopes,
multiple-choice question polish, and Thread history/resume UX.

## Build

```bash
npm install
npm run build
```

Copy `manifest.json`, `main.js`, and `styles.css` into an Obsidian plugin
directory.
