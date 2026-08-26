---
name: codexhost-update-impact-audit
description: Use when a Codex Desktop update may have changed codexhost behavior, Composer/CDP bindings, renderer DOM, Host bridges, or UI controls and the affected surface is unknown.
---

# Codexhost Update Impact Audit

Use this skill for diagnosis before changing codexhost. The output is an evidence-backed impact report and, only when explicitly requested, a narrowly scoped fix.

## Guardrails

- Read the repository `AGENTS.md`; preserve unrelated dirty-worktree changes.
- Treat Codex Desktop's private DOM and React internals as versioned, unstable contracts.
- Never use a bundle hash, minified function name, credential, token, prompt, or full request payload as a compatibility contract.
- Do not modify production code during the audit unless the user explicitly asks for a fix. Do not claim a live result without running the live check.

## Audit workflow

1. **Record the versions.** Inspect the installed Desktop bundle version/build and the actual executable. Unpack `app.asar` into a temporary directory. Keep an old bundle when available for differential comparison.

2. **Map semantic contracts.** Compare old/new `app-initial` and `composer-utility-bar` bundles for these markers:
   `[data-codex-composer-root]`, `FooterInlineControls`, `data-composer-navigation-target`, `data-codex-intelligence-trigger`, `data-above-composer-portal`, `executionTargetHostId`, and `permissionsHostId`.
   Classify each difference as component relocation, DOM relationship change, styling-only change, or unchanged. Hash/name changes alone are not impact.

3. **Trace the binding path.** Read the codexhost call site and follow each anchor from Composer discovery to insertion. Check Model, Permission, Context Usage, Credits, Agent, Send, React Fiber state, prewarm/request bridges, and Host routing separately. Prefer semantic attributes and ownership checks; fail closed on ambiguity.

4. **Probe the real renderer.** Use the existing CDP/renderer tools (`packages/desktop-control`, `tools/renderer-binding/run.mjs`). Inspect the populated Composer, parent/child/sibling relationships, visibility, computed styles, bounding rectangles, and bridge readiness. On macOS, pass `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT` to `--desktop`; the runner expects a file, not the `.app` directory. Redact captured output.

5. **Test before fixing.** Rank 3–5 falsifiable hypotheses. For a code fix, first add a regression test that models the observed DOM/bridge boundary, run it red, then make one minimal production change and run it green. A passing test that asserts only a mock call or control existence does not prove visual alignment or routing.

6. **Report the decision.** Classify every surface as `no impact`, `confirmed impact`, `possible impact`, or `unverified`. Include exact files/lines, observed old/new evidence, the smallest proposed change, commands and outputs, and any live check that could not complete. Keep source-location migration and anchor/contract changes distinct.

## Focused validation

Use the narrowest relevant checks first, for example:

```text
npx vitest run <affected renderer tests> --config tests/vitest.config.js
npm run typecheck
npm run build:renderer
git diff --check
```

Only run broader suites when the changed boundary warrants them.

## Common mistakes

- Moving the binding because `app-initial-<hash>.js` changed.
- Assuming a localized `aria-label` or private CSS class is stable.
- Treating equal button heights as proof that parent alignment is correct.
- Updating several controls at once without isolating the failing boundary.
- Reformatting, resetting, or staging unrelated work while investigating.
