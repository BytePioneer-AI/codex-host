---
name: codexhost-update-impact-audit
description: Diagnose whether a Codex Desktop update changed codexhost Composer/CDP bindings, private Renderer DOM or React state, Host bridges, routing, the Codex usage submission gate, or injected UI. Use after an installed Codex update or when compatibility regresses and the affected surface is unknown.
---

# codexhost update impact audit

Audit before changing codexhost. Produce a verdict backed by bundle and live-Renderer evidence. Apply a fix only when the user explicitly requests one.

可先运行 `npm run audit:codex-desktop` 辅助检测；该命令不能替代下面的语义对比、ownership 追踪、真实 Renderer 探测和必要的行为验证，后续步骤仍须继续执行。

## Guardrails

- Read the repository `AGENTS.md` and record `git status`; preserve unrelated dirty-worktree changes.
- Treat Codex Desktop private DOM, React state, and main-process services as versioned contracts.
- Use semantic attributes, API shape, ownership, and observed relationships as contracts. Bundle hashes, asset names, minified identifiers, localized labels, private CSS classes, credentials, prompts, and full payloads are evidence only.
- Start with a read-only inspection of an existing codexhost-controlled Desktop. Use a controlled launch or mutate Renderer state only when the required boundary cannot otherwise be verified.
- Store only sanitized evidence under ignored `.codexhost/update-impact/`. Never persist Thread IDs, request IDs, prompts, transcripts, tokens, credentials, URL query/hash values, or full DOM snapshots.
- Do not change production code during an audit. Do not claim a live or routing result unless that exact check ran.

## 1. Establish the comparison chain

Record the installed executable, Desktop version/build, Chromium version, and `app.asar` hash. Determine these distinct versions when possible:

- **reviewed baseline**: the last version whose audit passed;
- **direct predecessor**: the version immediately before the installed build;
- **current**: the installed build under review.

Use the reviewed baseline for the compatibility decision. Use a direct predecessor only to localize the newest change. Never silently substitute a much older bundle for either role.

Search, in order, for prior evidence under `.codexhost/update-impact/`, Sparkle installation caches, compatibility fixtures, and other complete local installations. The official Sparkle appcast may establish release order and download locations, but downloading a full application is optional and must not block the audit when live evidence and a reviewed baseline are available.

Unpack each available `app.asar` into a temporary directory. After the audit, retain a minimal sanitized baseline at:

```text
.codexhost/update-impact/<version>/
  manifest.json
  app-initial.js
  app-initial.css
  composer-utility-bar.js
  marker-inventory.json
  live-renderer.json
```

`manifest.json` should identify version/build, Chromium version, executable path, hashes, audit time, verdict, and which checks actually ran. Do not retain a full application or archive merely for the next comparison.

Completion criterion: the report names the reviewed baseline, direct predecessor if known, and current version without conflating them.

## 2. Diff semantic contracts

Compare relevant `app-initial`, `composer-utility-bar`, and relocated owning chunks. Hash and filename changes are not impact. Classify each observed difference as:

- unchanged contract;
- source relocation or chunk split;
- styling-only change;
- DOM relationship change;
- React/API-shape change;
- removed or ambiguous contract.

Inventory contracts by surface:

| Surface | Primary evidence |
| --- | --- |
| Composer identity | `data-codex-composer-root`, `data-above-composer-portal`, `data-above-composer-conversation-id` |
| Model | `data-codex-intelligence-trigger`, `data-composer-navigation-target="reasoning"`, owning Fiber props |
| Permission | `data-composer-navigation-target="permissions"`, `permissionsHostId`, permission-state Fiber props |
| Request/prewarm | `executionTargetHostId`, `permissionsHostId`, request-client and prewarm-manager API shape |
| Footer/layout | `FooterInlineControls`, Context radial indicator shape, trailing action ownership |
| Sidebar | `data-app-action-sidebar-thread-row`, `data-thread-title-trigger`, `data-thread-title` |
| Settings | `data-testid="app-shell-header-context-menu-surface"` and structural insertion slot |
| Fork | `data-response-annotation-conversation`, `data-content-search-turn-key`, owning callback/Fiber state |
| Codex usage gate | Composer owner props `onLocalSubmitStart` + boolean `submitDisabled`; boolean selectors reading `authMethod` → `rate_limit.allowed` and reserve `hardBlocked`; `useSyncExternalStore` hook layout |

Marker counts are triage signals, not conclusions. If a marker moves to another chunk with the same use and live relationship, classify it as relocation. If counts remain equal, still inspect changed relationships and API shape.

Completion criterion: every codexhost-consumed contract is accounted for, including relocation to a new chunk.

## 3. Trace codexhost ownership paths

Read the current call sites and follow each surface independently from discovery through insertion or routing:

- Composer and Send/trailing actions;
- Agent and Model;
- Permission;
- Context Usage, Harness Usage, and Credits;
- Composer DOM identity and React Model target;
- request bridge and prewarm clear;
- title policy;
- sidebar decoration;
- settings entry;
- Fork;
- Codex usage gate (`renderer-codex-usage-gate.ts`, driven by `renderComposerAgentControl`'s external-submission readiness);
- Host create and subsequent-Turn routing.

Prefer unique semantic candidates plus ownership checks. Record fail-closed behavior for absent or ambiguous candidates. Keep source relocation separate from an actual anchor or ownership change.

Completion criterion: each reported surface points to the exact codexhost file/line that consumes the contract.

## 4. Probe the real Renderer

### Read-only probe first

If Codex is already running under codexhost, discover the active Inspector endpoint from the process arguments or runtime descriptor and attach through `packages/desktop-control`. Do not reload the Renderer or reinstall policies merely to read status.

Inspect only sanitized summaries:

- selected primary `app://-/index.html` Renderer and element count;
- populated Composer count and visibility;
- unique semantic Model, Permission, Context, Send, and portal candidates;
- direct parent/child/sibling relationships;
- computed `display`, `visibility`, `align-items`, `gap`, and bounding rectangles;
- codexhost control presence, visibility, ordering, overlap, and containment;
- Renderer Adapter, title policy, and draft-prewarm policy readiness;
- Harness availability;
- sidebar rows/icons, settings trigger, and Fork candidates.

Interpret visibility in state. A Credits, Permission, Usage, or Model control hidden because the current Agent, phase, or data availability does not require it is not an impact. For visible controls, alignment and ownership matter more than a fixed pixel height. Equal heights alone do not prove correct placement.

### Controlled probe when required

Use `tools/renderer-binding/run.mjs` only when a clean controlled lifecycle, reload, observer, or submission boundary is required. On macOS pass the executable file:

```text
/Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

The runner does not accept the `.app` directory. A controlled flow may verify Agent switching, stale-prewarm clearing, new Thread creation, title behavior, or Fork. State clearly when user interaction or creation boundaries were not exercised.

### Codex usage gate probe

This surface lets an external Harness submit while the ChatGPT-signed-in Codex subscription is out of usage by projecting `false` for one Composer's two Desktop usage-gate subscriptions. It depends on private React/state-library internals, so check it on every update. `npm run audit:codex-desktop` reports its structure as the `codex-usage-gate` surface (see `tools/codex-desktop-contract-audit/README.md`); `codex-usage-account-gate-dormant` means the audit ran without a ChatGPT sign-in whose Account gate reads usage. The audit does not verify behavior.

Bundle evidence (evidence only, not contracts): the Composer owner combines `submitDisabled` from an Account rate-limit selector (`authMethod !== "chatgpt"` early return, then `rate_limit.allowed === false`, gated to host `local`) and a reserve `hardBlocked` selector. Confirm both still exist and still feed `submitDisabled`, and that no new Account-wide usage blocker was added beside them. If Desktop now exempts external models/Threads or stops blocking in the Renderer, report that the module can be removed.

Manual read-only live probe, when the audit surface is not `no-impact` or its counts need explaining, in a Composer inside the primary Renderer. Do not patch `getSnapshot`, subscribe to the store, or call effect functions:

1. From the editor's nearest React host, walk committed ancestors; exactly one owner has `onLocalSubmitStart` and boolean `submitDisabled`, in both a new draft and an existing Thread.
2. In its hook list, find candidates shaped `useMemo → [subscriber, [store, atom]]`, next hook `queue = { value: boolean, getSnapshot === subscriber.getSnapshot }`, next hook effect `{ create, deps: [subscriber.subscribe] }`, without `atom.write`, and `createRender()` returning nothing.
3. Replay each candidate's `atom.read` with tracing proxies. Exactly one reads `hardBlocked` without `active` (reserve). When signed in with ChatGPT, exactly one reads `authMethod` and `rate_limit.allowed` (Account). The replayed value must equal `store.get(atom)`.
4. `store.sub`, `subscriber.getSnapshot`, and the instance `getSnapshot` are writable.

With codexhost running and an external Agent selected, bound gates show an instance `getSnapshot` of `() => false` for both hooks. The Agent control's hover title shows the "cannot separate from Codex usage" message when binding failed.

Behavioral check requires a ChatGPT account that is out of Codex usage; API-key sign-in never triggers the gate. With non-empty text and an external Agent, Send is enabled in a new draft and an existing Thread; after switching to Codex it returns to disabled. Do not submit a message unless the user asks. Remove any temporary text without touching text the user typed. Report `unverified` when no exhausted account is available.

Completion criterion: no surface receives a live verdict from bundle inspection alone.

## 5. Rank hypotheses and validate narrowly

Before proposing a fix, rank 3–5 falsifiable hypotheses by evidence and name the observation that would disprove each. Run the narrowest relevant tests first, for example:

```text
npx vitest run <affected renderer tests> --config tests/vitest.config.js
npm run typecheck
npm run build:renderer
git diff --check
```

For a requested fix:

1. Add a regression test that models the observed DOM, Fiber, API-shape, visual relationship, or routing boundary.
2. Run it red for the observed reason.
3. Make one minimal production change in the owning module.
4. Run it green and repeat the relevant live probe.

A test that proves only that a control exists or a mock was called does not prove visual alignment, ownership, or routing.

Completion criterion: a fix is tied to one confirmed failing boundary, not to a changed bundle name or broad suspicion.

## 6. Report verdict first

The first line must answer the user's question directly:

```text
结论：无影响 / 有确认影响 / 可能有影响 / 尚未验证。
```

Then give 3–5 decisive facts before detailed evidence. Classify every surface as:

- `no impact`: bundle contract and relevant live boundary both agree;
- `confirmed impact`: a live or focused regression check demonstrates failure;
- `possible impact`: evidence changed materially but the decisive boundary is unavailable;
- `unverified`: the boundary was not exercised or observable.

Include:

- reviewed baseline, direct predecessor if known, and current version;
- exact files/lines consuming each affected contract;
- old/new semantic evidence and whether it is relocation, styling, relationship, or API-shape change;
- live commands/checks and sanitized outcomes;
- focused tests actually run;
- skipped or blocked checks and why;
- smallest proposed change only for confirmed impact;
- confirmation that unrelated worktree changes were preserved.

Do not bury the answer in the evidence. “Frontend changed” and “codexhost is impacted” are separate conclusions.

## Common failure modes

- Comparing current against whatever old bundle is easiest to find instead of the reviewed baseline.
- Losing the reviewed baseline and downloading hundreds of megabytes on every audit.
- Treating an asset hash, minified name, marker count, or chunk relocation as compatibility impact.
- Reloading a user's active Renderer before attempting a read-only inspection.
- Treating a state-hidden control or a pixel-height change as a visual regression without checking its parent layout and role.
- Declaring Host routing, title creation, or Fork healthy without exercising that boundary.
- Updating multiple controls before isolating the failed ownership contract.
- Reformatting, resetting, staging, or overwriting unrelated work while investigating.
- Declaring the Codex usage gate healthy from a Codex-selected, empty, API-key-signed-in, or not-exhausted Composer; only the external Agent path with exhausted ChatGPT usage exercises it.
- Checking only the Send button's DOM `disabled`; Desktop also guards Enter and the submit function with the same `submitDisabled`.
