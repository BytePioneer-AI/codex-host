# Codex Desktop contract audit

This local maintainer tool checks the semantic Codex Desktop GUI contracts consumed by codexhost. It is not part of Launcher startup, Controller readiness, the Host runtime, the Renderer production entry, or Settings updates.

## Build and run

Start or attach to a controlled Codex Desktop with loopback CDP and Electron Inspector endpoints, then run:

```bash
npm run audit:codex-desktop -- \
  --endpoint http://127.0.0.1:9222 \
  --inspector-endpoint http://127.0.0.1:9223
```

The default `read-only` mode evaluates a standalone audit bundle in the selected Renderer. It does not reload the page, install codexhost production policies, switch Agent state, submit a Composer, create or delete a Thread, open Settings, Fork, or alter the installed application.

To compare against a report that has already been reviewed:

```bash
npm run audit:codex-desktop -- --baseline .codexhost/update-impact/26.1/audit-report.json
```

The tool never chooses a baseline automatically. A first run without a baseline still records current evidence, while baseline-dependent conclusions remain explicit.

## Controlled installation check

Use controlled mode only with an isolated Desktop lifecycle:

```bash
npm run audit:codex-desktop -- --mode controlled
```

Controlled mode reuses the existing production `RendererControlSession`. It can reload the Renderer and install Title, Draft/Prewarm, and Renderer binding policies. It still does not automatically submit, create a Thread, open Settings, execute Fork, or exercise title creation, so those behavior checks remain `unverified`.

## Evidence

Reports are written under ignored `.codexhost/update-impact/<desktop-version>/` as:

```text
audit-report.json
audit-report.md
```

The report contains bounded version/build, app.asar integrity, Chromium/protocol identity, checks that ran, normalized counts and ownership results, and per-surface verdicts:

- `no-impact`
- `confirmed-impact`
- `possible-impact`
- `unverified`

The tool does not retain prompts, transcripts, input or rendered text, Model values, Thread/Request IDs, credentials, tokens, RPC payloads, complete URLs, user paths, function source, full DOM snapshots, screenshots, complete bundles, or complete `app.asar` files.

## Supplying Desktop identity

By default the command uses a built `target/debug/codexhost inspect`. A different Launcher may be provided with `--launcher`. For fixture or remote endpoint audits, all three bounded values may be supplied directly:

```bash
npm run audit:codex-desktop -- \
  --desktop-version 26.1 \
  --desktop-build 100 \
  --asar-integrity sha256:<64-lowercase-hex>
```
