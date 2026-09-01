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

Both endpoint options must be loopback HTTP URLs. The defaults are `http://127.0.0.1:9222` for CDP and `http://127.0.0.1:9223` for Electron Inspector; override either with `--endpoint` or `--inspector-endpoint`.

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

## Reviewed integration gate

Run the fixed-build local/release gate against an isolated Desktop lifecycle:

```bash
npm run test:codex-desktop:integration -- \
  --endpoint http://127.0.0.1:9222 \
  --inspector-endpoint http://127.0.0.1:9223
```

The command reads the installed identity, requires an exact platform, version, build, and `app.asar` digest match in `reviewed-desktops.json`, loads only that entry's confined baseline, and runs the controlled audit. A mismatched identity, missing or invalid baseline, `possible-impact`, or `confirmed-impact` exits non-zero. State-conditional `unverified` surfaces exit zero but are printed to stderr as warnings for the reviewer.

Hosted CI can run the fixture tests, but this command is a local/release gate because it needs a controlled installed GUI application.

## Accepting a reviewed baseline

Baseline updates are always explicit. In a controlled environment:

1. Audit the candidate with all four identity fields and inspect the sanitized JSON report.
2. Perform any required live gates for warned `unverified` surfaces.
3. Accept the reviewed report explicitly:

```bash
npm run accept:codex-desktop-baseline -- \
  --report .codexhost/update-impact/26.825.41651/audit-report.json
```

The acceptance command requires a repository-confined report, validates its exact schema, rejects `possible-impact` and `confirmed-impact`, refuses an existing baseline or duplicate identity, and writes JSON by atomic rename. A predeclared identity may populate its missing baseline once; a new identity appends one manifest entry. Review the resulting manifest and baseline diff before committing it.

For a new identity, acceptance records a local transaction journal before the baseline rename. If the process stops before the manifest rename, rerun the same `--report` command to resume; a different report or conflicting baseline remains untouched and fails closed for manual review.

## Transcript surface

The `transcript` surface covers the contract that external Harness Reasoning depends on.
Codex retains transcript text for the Command Execution lane only, so codexhost projects
Reasoning through that lane; if a Desktop update drops it, projected Reasoning disappears
without any error.

It records bounded counts from the currently open Thread:

- `turnCount`, `itemNodeCount` — rendered Turns and transcript nodes;
- `identifiedItemCount` — Host Item ids published through
  `data-local-conversation-item-target-ids`, the hook that maps a projected Item to its node;
- `textBodyCount`, `textBodyOwnerCount` — Command Execution text bodies
  (`data-testid="exec-shell-body"`), the retained-text surface itself.

Verdicts:

- an open Thread with no rendered Items is `unverified`, never `no-impact`;
- Item nodes that stop publishing Host Item ids are `confirmed-impact`;
- the text-body counts are baseline-compared, so losing the retained-text lane surfaces as
  `possible-impact` rather than passing silently.

The surface reads the live transcript only. Whether streamed text survives Item completion,
whether a derived Item id renders at all, and whether the Reasoning summary lane still
produces its ephemeral preview are behavioral properties that need a submitted Turn, so
they stay outside this read-only tool.

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

By default the command uses a built `target/debug/codexhost inspect`. A different Launcher may be provided with `--launcher`. For fixture or remote endpoint audits, all four bounded values must be supplied together:

```bash
npm run audit:codex-desktop -- \
  --desktop-platform macos \
  --desktop-version 26.1 \
  --desktop-build 100 \
  --asar-integrity sha256:<64-lowercase-hex>
```
