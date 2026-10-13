# CodexHost 0.11.0 + ChatGPT Desktop 26.928 Session Summary

Date: 2026-10-02
Platform: macOS Apple Silicon
Status: Production-qualified for the tested target

## Scope completed today

This session upgraded and qualified the CodexHost/Desktop integration against the current official ChatGPT Desktop, diagnosed the exhausted-Codex-quota regression for external Harnesses and CLIProxy native-model routes, implemented the compatibility patch, added regression coverage, validated model-switch restoration, and synchronized the stock CodexHost 0.11.0 baseline on Linux.

## Versions and targets

- Official ChatGPT Desktop: 26.928.40906, build 12694
- CodexHost base: 0.11.0
- macOS candidate worktree: `/Users/yazan/projects/.codexhost-worktrees/codexhost-0110-upgrade`
- Linux effective CodexHost: 0.11.0
- Linux Node: v22.22.3

## Upstream review

Relevant CodexHost upstream fixes reviewed during the upgrade included:

- `0cc7d3f1` - external Harness submission when Codex usage is exhausted
- `f7be7749` - bind Codex usage gate through the Desktop Composer wrapper
- `b401bcbf` - adapt Codex usage gates to Desktop 26.928

A later upstream review did not identify a post-0.11.0 fix that resolved the remaining live build-12694 outer Composer gate, so a local compatibility patch was required and qualified.

## Official Desktop qualification

The current official Desktop installer was obtained from OpenAI's official distribution endpoint and verified as:

- version 26.928.40906
- build 12694
- OpenAI signed
- Gatekeeper accepted

The older failed 26.928 canary used build 12404, so the current official build was retested rather than assuming the earlier result still applied.

## Initial 0.11.0 qualification

Before the local compatibility work, the CodexHost 0.11.0 candidate passed its renderer-focused validation and was installed for live acceptance. The installed renderer artifact was verified against the built candidate.

Live exhausted-quota testing showed that upstream 0.11.0 fixed the inner usage-gate owners but Send remained disabled in higher Desktop Composer layers.

## Live root-cause evidence

With a non-empty Composer and exhausted Codex/Work usage:

- CLIProxy model identity was proven from React state as `cliproxy/gpt-6-astra`.
- `Iot.submitDisabled=false` while outer `Not` and `R2e` remained `submitDisabled=true` before the compatibility fix.
- The blocker was therefore not empty input, response progress, thread history, handoff, workspace materialization, Router transport, or CLIProxy model identity.

Read-only inspection of the official Desktop build located the outer derivation in the Desktop Composer. The relevant exhausted-account selector combines Account/rate-limit state with `reserve.active` and the primary/secondary rate-limit windows.

CodexHost's prior semantic classifier intentionally rejected Account plus reserve selectors as ambiguous. This fail-closed behavior was safe but did not recognize the new bounded Desktop 26.928 selector shape.

## Compatibility patch

The final patch changes five implementation/test files:

- `packages/renderer-extension/src/renderer-codex-usage-gate.ts`
- `packages/renderer-extension/src/renderer-binding-probe.ts`
- `packages/renderer-extension/src/renderer-composer-dom.ts`
- `packages/renderer-extension/test/renderer-codex-usage-gate.test.ts`
- `packages/renderer-extension/test/renderer-agent-picker.test.ts`

Current patch diff size at documentation time:

- 148 insertions
- 16 deletions

The fix:

1. Adds bounded recognition for the Desktop 26.928 exhausted-account selector that combines Account/rate-limit state with `reserve.active`.
2. Projects only the component-local derived boolean subscription; shared Desktop store/atom state is not mutated.
3. Keeps ambiguous/hard-block combinations fail-closed.
4. Preserves the hard-block reserve gate behavior.
5. Adds model-selection lifecycle handling so the gate is recomputed after Desktop commits a native model menu selection.
6. Never globally forces the Send button enabled.

## Model-switch safety fix

Acceptance exposed a second issue: after a CLIProxy bypass, switching to a native OpenAI model needed a renderer refresh after the model menu click had committed the new selection.

The binding probe now schedules a next-frame re-render for mounted Composers after a native model `menuitemradio` selection. This causes the CLIProxy quota projection to be released immediately when the selected model becomes native OpenAI.

## Automated validation

Final focused validation:

- renderer Codex usage gate: 16 PASS
- renderer agent picker: 14 PASS
- renderer binding probe: 50 PASS
- focused total: 80/80 PASS

Final full renderer-extension validation:

- 56 test files PASS
- 605/605 tests PASS
- TypeScript no-emit PASS
- renderer build PASS
- `git diff --check` PASS

## Final live acceptance

All acceptance checks used a non-empty Composer while the Desktop visibly reported exhausted Codex/Work usage.

### CLIProxy

React-selected model:

`cliproxy/gpt-6-astra`

Observed:

- quota exhausted: true
- `Iot.submitDisabled=false`
- `Not.submitDisabled=false`
- `R2e.submitDisabled=false`
- Send `disabled=false`
- Send `aria-disabled=null`
- unsupported gate warning absent

Result: PASS.

### Native OpenAI after switching away from CLIProxy

React-selected model:

`gpt-6.1-sol`

Observed under the same exhausted quota:

- `Iot.submitDisabled=false`
- `Not.submitDisabled=true`
- `R2e.submitDisabled=true`
- Send `disabled=true`
- Send `aria-disabled=true`

Result: PASS.

This proves the bypass is released on model switch and native OpenAI remains quota-gated.

## Safety invariants retained

- External Harness / approved `cliproxy/*` route can bypass only the Codex inference quota gate.
- Native OpenAI remains quota-gated.
- Authentication/login is never bypassed.
- Shared usage state is not mutated.
- Unknown selector topology fails closed.
- No global Send-button override exists.

## Linux work completed

The Linux CodexHost installation was synchronized to stock 0.11.0 and its remote wrapper reinstalled/validated.

Effective Linux package path:

`/root/.nvm/versions/node/v22.22.3/lib/node_modules/@codexhost/cli`

Platform package:

`/root/.nvm/versions/node/v22.22.3/lib/node_modules/@codexhost/cli/node_modules/@codexhost/cli-linux-x64`

`codexhost --version`, package metadata, platform package, and remote status were validated at 0.11.0; remote status returned ready with no issues.

The macOS renderer compatibility patch is Desktop-specific and was not blindly propagated to Linux.

## Backups and rollback

Important macOS rollback points created/retained today:

- Desktop pre-26.928: `/Users/yazan/.codex/backups/chatgpt-desktop-pre-26928-20261002-043836`
- CodexHost pre-0.11.0: `~/.codex/backups/codexhost-pre-0110-20261002-042546`
- Pre-first outer-gate candidate: `/Users/yazan/.codex/backups/codexhost-pre-outer-gate-20261002-052434`
- Pre-final 26.928 mixed-selector canary: `/Users/yazan/.codex/backups/codexhost-pre-26928-mixed-20261002-054524`

## Documentation produced/updated today

Canonical fix document:

`docs/operations/desktop-26928-codex-usage-gate-fix.md`

Session-level handoff:

`docs/operations/2026-10-02-codexhost-0110-desktop-26928-session-summary.md`

Existing upgrade/diagnosis material used as continuity context:

`docs/operations/codex-desktop-upgrade-diagnosis-playbook.md`

## Current repository state

The final implementation, regression test, and documentation are present in the isolated 0.11.0 upgrade worktree. Temporary `.bak` files created during surgical edits remain untracked and are not part of the intended patch.

No destructive cleanup or history rewrite is required for qualification. Before creating a permanent commit/PR, exclude/remove the temporary `.bak` files and commit only the five patch files plus the canonical documentation/handoff documents.

## Future upgrade acceptance rule

After any future ChatGPT Desktop or CodexHost update:

1. reconcile upstream before replaying local compatibility changes;
2. run usage-gate, agent-picker, and binding-probe tests;
3. run full renderer-extension tests, TypeScript, renderer build, and diff check;
4. under exhausted quota with non-empty Composer, prove `cliproxy/*` enables Send;
5. switch to native OpenAI and prove Send becomes disabled again;
6. treat changed React/store selector topology as a new compatibility problem and fail closed until semantically proven.
