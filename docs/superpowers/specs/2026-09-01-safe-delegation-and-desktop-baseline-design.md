# Safe Delegation, Explicit Skill Lifecycle, and Desktop Baseline Design

Date: 2026-09-01
Status: approved design, pending implementation plan

## Goal

Make cross-Harness delegation safe by default, stop Host startup from modifying global Skill directories, and add a fail-closed compatibility gate for reviewed Codex Desktop builds.

The implementation must preserve an explicit unattended mode for users who deliberately accept it. It must not claim that a Harness supports approvals when codexhost cannot enforce or verify them.

## Scope

This change has three parts:

1. Add a cross-Harness `approval-required` execution policy and make it the delegation default.
2. Replace automatic delegation Skill installation with explicit `install`, `uninstall`, and `status` CLI commands.
3. Pin reviewed Codex Desktop identities and run the existing controlled contract audit only against an exact reviewed identity.

The change does not add a Renderer permission picker, implement a Pi approval bridge, automatically trust new Desktop versions, or redesign the existing contract audit.

## 1. Approval-Required Delegation

### Public contract

`HarnessExecutionPolicy` gains a third value:

```text
default
approval-required
unattended-full-access
```

`default` remains available for ordinary non-delegated adapter opens. Cross-Harness delegation uses `approval-required` unless the caller explicitly supplies `unattended-full-access`.

The delegation CLI accepts:

```text
--execution-policy approval-required|unattended-full-access
```

Omitting the option means `approval-required`. The selected policy is included in request validation, idempotency/deduplication identity, and returned configuration evidence so two otherwise identical requests with different trust levels cannot be conflated.

### Adapter mappings

Adapters map `approval-required` to an explicit native setting rather than an adapter default that might drift:

| Harness | Approval-required mapping |
| --- | --- |
| Claude Code | `default` |
| Grok | `ask` |
| OpenCode | `ask` |
| OMP | `always-ask` |
| DeepSeek Harness | inspected safe default; reject a missing catalog, `danger-full-access`, or an unconfirmed selection |
| Pi | reject as unsupported because the current adapter exposes no approval control |

Pi remains available when the caller explicitly requests `unattended-full-access`. This is intentional fail-closed behavior: the current Pi adapter advertises `selectPermissionMode: false`, rejects an explicit Permission Mode, and does not translate execution policy into native approval behavior.

OMP's ordinary session default also changes from `yolo` to `always-ask`. Users may still choose `write` or `yolo` through the existing Permission Mode control.

### Error behavior

An adapter that cannot establish the requested policy returns a non-retryable `unsupported` or `invalidRequest` result before the initial task is submitted. Delegation publishes no successful child Thread in that case. No adapter may silently replace `approval-required` with its normal default or full access.

DeepSeek Harness may use its dynamically inspected default only when the permission catalog exists, the default is selectable, the value is not `danger-full-access`, and the created session reports the selected value. A missing or contradictory projection fails the open operation.

### Tests

Focused tests cover:

- delegation defaults to `approval-required`;
- explicit unattended policy reaches the adapter;
- policy participates in CLI payloads and deduplication identity;
- each capable adapter maps approval-required to the explicit native mode;
- Pi rejects approval-required and still accepts explicitly unattended delegation;
- OMP ordinary sessions default to `always-ask`;
- DeepSeek fails closed for missing, dangerous, or unconfirmed permission state.

## 2. Explicit Delegation Skill Lifecycle

### Startup behavior

`runHostRuntime` no longer calls `installDelegationSkills()`. Starting codexhost must not create or update files under `~/.agents` or `~/.claude`.

### CLI

The installed launcher routes a new `skill` command group to the existing Node host-runtime CLI entrypoint:

```text
codexhost skill install
codexhost skill uninstall
codexhost skill status
```

These commands do not require a running Host Runtime. They emit JSON with one result for each managed destination.

### File ownership rules

Installation preserves the current safety properties: owner-only directories, owner-only temporary files, atomic replacement, content verification, and conflict preservation.

Managed digests include the current Skill content and explicitly known previous codexhost versions.

- `install` creates a missing file, updates a known managed version, reports `current`, or reports `conflict` without overwriting user content.
- `status` reports `missing`, `current`, `managed-legacy`, or `conflict` without writing.
- `uninstall` removes only files whose digest is current or known-managed. Missing files are reported as `missing`; modified or unknown files are reported as `conflict` and preserved.

Uninstall does not recursively delete parent directories. This avoids removing unrelated user content and keeps ownership rules simple.

README documentation explains that delegation requires explicit Skill installation, how to inspect status, and how safe uninstall behaves.

### Tests

Tests use temporary home directories and verify:

- Host startup performs no Skill filesystem write;
- install/current/upgrade/conflict results;
- status is read-only;
- uninstall removes current and known legacy copies;
- uninstall preserves unknown or user-modified files;
- CLI output and exit behavior remain machine-readable.

## 3. Fixed Codex Desktop Compatibility Gate

### Reviewed identity manifest

A committed manifest under `tools/codex-desktop-contract-audit/` stores reviewed Desktop identities and their baseline report paths. Its first macOS entry is:

```text
version: 26.825.41651
build: 7345
app.asar SHA-256: c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d
```

The manifest is schema-versioned and may contain multiple reviewed versions. Entries are immutable history: supporting a new build adds an entry instead of silently replacing the old one.

### Integration command

`npm run test:codex-desktop:integration` performs the following sequence:

1. Read the installed Desktop identity using the existing launcher inspection path or explicitly supplied bounded identity values.
2. Require an exact platform, version, build, and `app.asar` digest match in the reviewed manifest.
3. Resolve the committed baseline report named by that manifest entry.
4. Run the existing controlled contract audit against loopback CDP and Inspector endpoints.
5. Exit non-zero for identity mismatch, invalid/missing baseline, `confirmed-impact`, or `possible-impact`.

`unverified` state-conditional surfaces remain warnings because the existing controlled audit intentionally does not submit a Turn or mutate Thread state. The integration result must print those unverified surfaces so a release reviewer can decide whether a live gate is also required.

Ordinary CI runs manifest parsing, duplicate detection, path confinement, exact-match, mismatch, and verdict tests with fixtures. The real Desktop command is a local/release gate because hosted CI does not contain an installed GUI application.

### Updating support

New Desktop builds are never accepted automatically.

The update flow is:

1. Install the candidate Desktop in a controlled environment.
2. Run the existing audit and inspect its generated report.
3. Perform any required live gates.
4. Run an explicit baseline acceptance command with the reviewed report path.
5. Add the new identity and sanitized baseline report as a normal code change.
6. Review and commit the diff.

The acceptance command validates the report schema, exact Desktop identity, absence of confirmed/possible impact, destination path confinement, and duplicate identity before writing. It does not infer approval from merely detecting a new installation.

## Data and Security Boundaries

- Execution policy is typed end-to-end through CLI input, Runtime request, broker validation, coordinator, and adapter open input.
- Skill lifecycle commands operate only on the two fixed paths below an injected or actual home directory and never follow user-selected arbitrary destinations.
- Desktop baselines contain bounded identity and contract evidence only. They must not contain prompts, transcript text, credentials, tokens, full URLs, user paths, DOM dumps, or application bundles.
- All three areas fail closed when ownership, permission semantics, identity, or baseline validity cannot be established.

## Delivery Order

Implementation proceeds test-first in three independent slices:

1. Approval-required contract and adapter mappings.
2. Explicit Skill lifecycle and startup removal.
3. Reviewed Desktop manifest, integration gate, and acceptance workflow.

Each slice gets focused red-green tests before production changes. Final verification runs formatting, lint, typecheck, affected TypeScript tests, the broader TypeScript suite, and Rust checks when the configured Rust toolchain is available. The real Desktop integration gate is run only after confirming that taking control of the local Desktop will not interrupt user work.
