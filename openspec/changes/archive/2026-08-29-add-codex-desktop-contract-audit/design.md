## Context

codexhost binds to private Codex Desktop surfaces across `packages/renderer-extension` and `packages/desktop-control`. The existing `tools/renderer-binding/run.mjs` exercises the core Agent-routing chain in a controlled lifecycle, while `inspectRendererDom()` provides a small generic DOM summary. Neither provides one default-read-only audit covering every consumed GUI surface, a reviewed-baseline comparison, or a per-surface verdict suitable for deciding whether an upstream Desktop update affects codexhost.

The audit must remain developer tooling. Production startup deliberately treats Renderer integration failures as recoverable and must not regain a compatibility modal or blocking version gate. The tool must also avoid persisting user content or entire upstream applications.

## Goals / Non-Goals

**Goals:**

- Provide one local command that audits the installed or already-running Codex Desktop against the semantic contracts consumed by codexhost.
- Make read-only live inspection the default and controlled installation/reload an explicit opt-in tier.
- Keep contract discovery local to the owning production modules and expose sanitized inspection summaries instead of duplicating selectors or private structure knowledge in the runner.
- Produce schema-validated JSON and human-readable Markdown with per-surface evidence and verdicts.
- Persist a bounded reviewed baseline that can be compared with a later Desktop update.
- Cover the MVP surfaces: Composer, Model, Permission, request/prewarm, title, Settings, Sidebar, Usage/Credits, and Fork.

**Non-Goals:**

- Do not run from Launcher, Controller startup, Host runtime, Renderer production entry, or Settings update flows.
- Do not block or downgrade the user's Desktop based on audit output.
- Do not automatically download Codex Desktop builds or retain complete applications, `app.asar`, full bundles, full DOM, screenshots, prompts, transcripts, payloads, credentials, IDs, Model values, or user paths.
- Do not claim end-to-end routing, title creation, Fork execution, or visual behavior unless an explicit controlled check exercises that boundary.
- Do not build a generic crawler for all Codex GUI code.

## Decisions

### 1. Add one deep audit module with a small CLI seam

The external interface will be a local CLI under `tools/codex-desktop-contract-audit/`, invoked through a root npm script. Internally it will compose installation metadata, CDP inspection, Electron Inspector inspection, optional production-control status, baseline loading, classification, and report writing.

The command will support two explicit modes:

- `read-only`: attach to caller-provided loopback CDP and Inspector endpoints and evaluate only side-effect-free expressions.
- `controlled`: delegate installation/reload and binding verification to the existing Renderer Control Session or controlled Renderer probe after an explicit flag.

Alternative: add many surface-specific scripts. Rejected because callers would need to understand ordering, sanitization, and verdict aggregation, creating a shallow interface and inconsistent reports.

### 2. Keep contract discovery in owning production modules

`renderer-extension` will expose bounded inspection functions for the semantic relationships it already owns. These functions may return cardinality, state, ownership, visibility, and stable reason codes, but never raw Fiber objects, function source, Thread IDs, Model values, text content, or arbitrary attributes. `desktop-control` will validate the returned schema and handle CDP/Inspector transport.

The audit runner will own orchestration and cross-version comparison, not private selectors.

Alternative: duplicate all production selectors in the audit tool. Rejected because production and audit assumptions would drift and either create false failures or false passes.

### 3. Separate observation levels in the report

Each surface records independent evidence levels:

- `static`: installed metadata and optional bounded marker inventory;
- `liveStructure`: read-only candidate, relationship, state, and ownership inspection;
- `installation`: production binding/policy readiness when observable;
- `behavior`: only present for an explicitly exercised controlled boundary.

The aggregate verdict is:

- `no-impact`: required observed contracts pass and no material baseline difference remains unexplained;
- `confirmed-impact`: an expected active contract or explicitly exercised behavior fails;
- `possible-impact`: material shape/relationship evidence changed but the decisive live boundary was unavailable;
- `unverified`: the current Renderer state did not expose the conditional surface and no failure was observed.

An absent state-conditional control does not become `confirmed-impact` without evidence that its precondition was active.

Alternative: one boolean compatible flag. Rejected because it hides unexercised states and encourages unsafe conclusions.

### 4. Make the reviewed baseline explicit and bounded

Reports are stored under `.codexhost/update-impact/<version-or-build>/`. A baseline manifest contains only schema version, Desktop version/build, Chromium/protocol identity, app.asar integrity, relevant bounded marker counts or hashes, per-surface normalized results, checks run, timestamp, and verdict. The command accepts an explicit baseline path and never silently substitutes an arbitrary older report.

The first MVP will compare normalized reports rather than performing broad minified-source diffs. Source extraction can be added later only for contracts that cannot be localized from live and metadata evidence.

Alternative: save every `app.asar` and diff all generated JavaScript. Rejected due to storage, noise, upstream-code retention, and poor correlation with actual impact.

### 5. Reuse the controlled Renderer probe for behavioral escalation

The existing `tools/renderer-binding/run.mjs` remains the owner of controlled Agent switching, prewarm clearing, title-policy installation, and sanitized submission observation. The new audit command may invoke shared operations or consume its normalized output in controlled mode; it will not create a second implementation of those flows.

Read-only mode must not reload the Renderer, install policies, inject the Renderer bundle, switch Agent state, submit, create Threads, or alter Settings.

Alternative: always run the existing probe. Rejected because its reload and injection behavior is inappropriate for default inspection of an active user Renderer.

### 6. Classify command exit status separately from surface verdicts

The command exits non-zero for invalid arguments, inaccessible endpoints, invalid report schemas, write failures, or `confirmed-impact`. It exits zero for `no-impact`, `possible-impact`, and `unverified` while making the verdict explicit in JSON/Markdown. This keeps scripting useful without treating a state-dependent unverified surface as a technical execution failure.

## Risks / Trade-offs

- **[The audit and production code share the same faulty discovery assumption]** → Include independent cardinality, DOM relationship, visibility, and ownership observations instead of trusting a single success boolean; use controlled behavior checks for decisive routing boundaries.
- **[Conditional UI creates false failures]** → Record explicit preconditions and classify unavailable states as `unverified` unless the precondition is known active.
- **[Read-only inspection cannot prove all behavior]** → Separate structure, installation, and behavior evidence and prohibit behavior claims when the boundary was not exercised.
- **[Private Renderer changes expand inspection code]** → Keep each contract owned by its production module and expose one normalized aggregate interface to the runner.
- **[Evidence leaks user data]** → Validate report schemas, use stable reason codes and counts only, sanitize URLs to scheme/path, and reject unknown fields before writing.
- **[Baseline becomes stale or misleading]** → Require an explicit reviewed baseline, record which checks ran, and never auto-promote a current report to reviewed.
- **[MVP scope grows into full upstream bundle analysis]** → Limit the first implementation to normalized metadata and live semantic contracts; defer source extraction unless a concrete audit gap requires it.
