# Desktop 26.928 Codex Usage Gate Compatibility Fix

Date: 2026-10-02
Status: Production-qualified on macOS acceptance target

## Qualified target

- ChatGPT Desktop: 26.928.40906, build 12694
- CodexHost: 0.11.0 plus the compatibility patch documented here
- macOS: Apple Silicon
- Exhausted-account acceptance condition: the Desktop banner reports Codex/Work usage exhausted

## Problem

CodexHost 0.11.0 contained upstream Desktop 26.928 quota compatibility work, but the real Desktop 26.928.40906 Composer could still leave Send disabled for external Harnesses and `cliproxy/*` native-model routes when the OpenAI Codex quota was exhausted.

The failure was not Router transport, CLIProxy model identity, empty Composer state, response progress, thread loading, handoff, or workspace materialization. Live React/Fiber inspection showed the outer Desktop Composer layers `Not` and `R2e` receiving `submitDisabled=true` while the inner `Iot`/`jZ` layers were not blocked.

## Root cause

Desktop 26.928 changed the exhausted-account selector topology. The relevant component-local selector combines Account/rate-limit state with `reserve.active`; its live exhausted-state read signature included auth/account fields, `limit.allowed`, primary/secondary rate-limit windows, and `reserve.active`.

The previous CodexHost semantic classifier intentionally treated Account plus reserve reads as an ambiguous mixed selector and failed closed. That was safe, but it meant the new Desktop selector was not projected for external/CLIProxy submissions.

A second lifecycle issue was found during acceptance: after a native-model menu selection, the usage-gate projection had to be recomputed after Desktop committed the new model selection. Without that re-render, a previous CLIProxy bypass could survive the model switch until another renderer event.

## Fix

1. Recognize the bounded Desktop 26.928 Account + `reserve.active` exhausted-account selector as a dedicated usage-gate kind while continuing to reject ambiguous combinations, especially selectors involving `reserve.hardBlocked`.
2. Project only the component-local derived boolean subscription. Do not mutate the shared Desktop store or atom.
3. Preserve the existing hard-block reserve projection and fail-closed behavior when the semantic owner cannot be proven.
4. Re-render mounted Composer gate state on the next animation frame after a native model `menuitemradio` selection, so switching away from `cliproxy/*` immediately releases the bypass.

## Safety invariants

- Only external Harness readiness or a Codex native-model route whose model ID starts with `cliproxy/` may request the quota bypass.
- Native OpenAI models remain subject to the exhausted Codex usage gate.
- Authentication/login gates are not bypassed.
- Shared Desktop usage state is not changed.
- The Send button is never globally force-enabled.
- Unknown or ambiguous selector shapes fail closed.

## Automated validation

Focused compatibility suite after the final patch:

- renderer Codex usage gate: 16 tests PASS
- renderer agent picker: 14 tests PASS
- renderer binding probe: 50 tests PASS
- focused total: 80/80 PASS

Full renderer-extension validation:

- 56 test files PASS
- 605/605 tests PASS
- TypeScript no-emit check PASS
- renderer build PASS
- `git diff --check` PASS

The new regression covers the Desktop 26.928 exhausted-account selector that also reads `reserve.active`, including projection without shared-store mutation and restoration to native behavior.

## Live acceptance

Acceptance was performed with a non-empty Composer while the Desktop visibly reported exhausted Codex/Work usage.

### CLIProxy route

Selected model identity was read from React state as:

`cliproxy/gpt-6-astra`

Observed:

- quota exhausted: true
- `Iot.submitDisabled=false`
- `Not.submitDisabled=false`
- `R2e.submitDisabled=false`
- Send `disabled=false`
- no unsupported usage-gate warning

Result: PASS.

### Native OpenAI route after switching away from CLIProxy

Selected model identity was read from React state as:

`gpt-6.1-sol`

Observed under the same exhausted quota and same non-empty Composer:

- `Iot.submitDisabled=false`
- `Not.submitDisabled=true`
- `R2e.submitDisabled=true`
- Send `disabled=true`
- Send `aria-disabled=true`

Result: PASS. The CLIProxy bypass was released and native OpenAI remained quota-gated.

## Rollback

Pre-26.928 mixed-selector canary backup:

`/Users/yazan/.codex/backups/codexhost-pre-26928-mixed-20261002-054524`

Earlier pre-custom-candidate backup:

`/Users/yazan/.codex/backups/codexhost-pre-outer-gate-20261002-052434`

Desktop pre-update backup:

`/Users/yazan/.codex/backups/chatgpt-desktop-pre-26928-20261002-043836`

## Upgrade rule

For future ChatGPT Desktop or CodexHost upgrades, do not assume this compatibility layer remains valid. Re-run at minimum:

1. usage-gate, agent-picker, and binding-probe tests;
2. full renderer-extension suite, TypeScript, renderer build, and diff check;
3. exhausted-quota live acceptance with a non-empty Composer:
   - `cliproxy/*` must enable Send;
   - switching to native OpenAI must disable Send again;
4. if React/store selector shape changes, inspect it read-only and fail closed rather than broadening the bypass heuristically.
