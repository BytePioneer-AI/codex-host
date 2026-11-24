# Repository Guidelines

## Product Intent

`codexhost` runs external Agent Harnesses as independent Threads inside Codex Desktop, preserving the official shell and native Codex path. Integrate each Harness through its native interface; preserve its actual capabilities and semantics rather than inventing equivalent-looking Host behavior.

## Code Layout

### Native Rust

- `crates/`
  - `launcher/`: native application launch
  - `shim/`: process proxying
  - `updater/`: update installation
  - `platform/`: cross-platform native integration

### TypeScript Workspace

- `packages/`
  - `protocol-core/`: Host protocol routing and projection
  - `mapping-store/`: external Thread metadata persistence
  - `harness-adapter/`: public Harness session and plugin contracts
  - `harness-discovery/`: Harness executable discovery and invocation helpers
  - `harness-plugin-files/`: on-disk discovery and configuration for installed Harness plugins and Desktop UI extensions, without executing either
  - `harness-broker/`: native Broker communication; currently retains Claude Code-specific semantics
  - `adapters/`: Harness-specific implementations and plugin entry points
  - `desktop-control/`: CDP / Electron Inspector-driven Desktop interaction
  - `host-runtime/`: Host composition and installed plugin loading
  - `update-manager/`: background update preparation
  - `console-server/`: local codexhost console that works without Codex Desktop (diagnostics, updates, Harness launch settings)
  - `shared-contracts/`: browser-safe types and runtime schemas
  - `renderer-extension/`: injected browser UI and Desktop extension host

### Build and Release

- `scripts/release/`: release preparation, packaging, and publishing
- `tools/`: development utilities and technical Gates
- `registry/desktop-extensions/`: standalone index template for independently distributed [Desktop UI extensions](docs/architecture/desktop-ui-extensions.md)

## Boundary Rules

- Rust owns native launch, process management, update installation, and platform integration. It must not own Host protocol or Harness semantics.
- `shared-contracts` must remain browser-safe and independent of other Workspace packages.
- `renderer-extension` must not import Node.js built-ins, Electron private APIs, or Harness SDKs.
- Harness-specific protocol details must remain inside the corresponding Adapter.
- Host Runtime loads installed plugins through public contracts, not direct imports of concrete Adapter packages. The preinstalled set belongs to `scripts/release/harness-plugins.json`, not Host registration code.
- Use package public exports for cross-package dependencies. Read `tools/check-boundaries.mjs` before changing dependency directions; it is the executable boundary check run by `npm run lint`.

## Coding Style & Naming Conventions

- Follow `docs/project/领域术语表.md`; in particular, do not conflate Harness, Model, Provider, Account, or Billing Source.

## Repository Skills

Load a skill only when its task occurs; read its `SKILL.md` before following it.

| Task | Skill |
| --- | --- |
| Version releases, Release Notes, preview channels, and release recovery | [codexhost-release](.agents/skills/codexhost-release/SKILL.md) |
| Triage a batch of PRs: overview table with 1–5 score, real-test plan, merge/close/label after approval | [codexhost-pr-overview](.agents/skills/codexhost-pr-overview/SKILL.md) |
| Reviewing a PR or local diff for correctness and boundaries | [codexhost-code-review](.agents/skills/codexhost-code-review/SKILL.md) |
| Quickly trying a feature in a Web or Desktop run with its own data directory | [codexhost-isolated-testing](.agents/skills/codexhost-isolated-testing/SKILL.md) |
| Finding evidence-backed simplification candidates (read-only audit) | [codexhost-find-simplifications](.agents/skills/codexhost-find-simplifications/SKILL.md) |
| Auditing comments and docs for reasoning-transcript leakage | [codexhost-trim-cot-leakage](.agents/skills/codexhost-trim-cot-leakage/SKILL.md) |
| Developing, packaging, or troubleshooting a Desktop UI extension | [codexhost-add-desktop-extension](.agents/skills/codexhost-add-desktop-extension/SKILL.md) |

## Implementation Principles

- Inspect related implementations, tests, contracts, and documentation before making changes. Prefer established repository patterns and public APIs over parallel implementations.
- Reuse code only when semantics and ownership are aligned. Abstractions and encapsulation should solve current, concrete problems; avoid layers of indirection without a clear benefit.
- Use as few concepts, states, entry points, and runtime actions as possible to express the real business flow directly.
- Keep changes narrowly scoped. Avoid unrelated refactors, renames, dependency upgrades, or formatting churn.
- Preserve the package and crate ownership boundaries described above. Prefer explicit data flow and typed contracts over hidden global state, stringly typed protocols, or implicit cross-module coupling.

## Code Size & Structure

- Keep handwritten production modules focused on one primary responsibility.
- Treat 500 lines as a design-review signal, not a hard limit. When an existing module approaches or exceeds 800 lines, prefer placing cohesive new functionality in a separate module unless there is a documented reason not to.
- Split code by responsibility and ownership, not solely to satisfy a line-count target.
- Keep executable scripts focused on orchestration. Move reusable, domain, parsing, persistence, and testable logic into the owning package or crate.
- Generated files, fixtures, migrations, and declarative schemas are exempt from line-count guidance.

## Testing & Completion

- Choose commands from `package.json`. Focused tests use `tests/vitest.config.js`; Rust changes run `cargo test` for the owning crate with the features in `package.json`; `scripts/release/**` changes run the matching `tests/release` tests.
- Verification budget, for every agent including delegated ones. CI runs the full suite on every PR and every push to `main`; local checks only shorten the feedback loop.
  - While developing, run only the test files for the behavior you changed. Once they pass after your last edit, verification is done; there is no separate final pass.
  - Vitest does not type-check. Add `npx tsc -b packages/<pkg>` only for cross-package or public contract changes; otherwise CI catches type and lint errors.
  - Cross-package imports read `dist`: rebuild only the changed dependency (`npx tsc -b packages/<dep>`). Use `npm run build:typescript` only when a test loads bundled plugins.
  - After a fix, rerun only what failed. Do not rerun checks on an unchanged tree or checks a delegate already reported for the same state.
  - Full-repo `npm run lint`, `typecheck`, `check`, `test`, `format:check` belong to CI; run them locally only when asked or when diagnosing a CI failure. Docs, copy, style, and small fixes need no local checks.
  - After pushing, do not wait for, poll, or report CI results; the user handles CI failures. Do not describe unchecked CI as passing.
- Writing tests. Every test is code to maintain and CI time to pay; add one only when it earns that.
  - Small, low-risk changes need no new tests. Add focused tests for high-risk or cross-package changes, or when asked.
  - A new test must catch a regression the existing tests would miss. Extend the nearest existing case or `test.each` instead of adding near-duplicates.
  - Assert observable behavior (inputs, outputs, protocol messages, persisted state), not internal call order, private state, or mock call counts.
  - Mock only external boundaries (network, clock, real CLIs, the OS), never the code under test. Avoid large snapshots and long literal expectations that can only be updated mechanically.
  - A bug-fix test must fail before the fix. Never weaken assertions or delete tests just to make a change pass; report the conflict instead.
  - When a change makes existing tests redundant or ties them to removed internals, delete them in the same change.
- Do not write browser, e2e, or component tests for Web pages (`apps/web-ui`); the user checks page changes directly. Codex Desktop compatibility after an update is checked with `npm run audit:codex-desktop` and `npm run probe:renderer-binding` (`codexhost-update-impact-audit`).
- `npm start` / `npm start web` rebuild and relaunch the user's Desktop / Web and may restart the shared Host; `npm stop` stops all local codexhost services across worktrees. Both interrupt running tasks: run them only when the user asks, never as validation. Details: `docs/product/standalone-web.md`.
- When pushing rewritten history, use `--force-with-lease`, never a bare `--force`.
- Do not claim a check passed unless it was executed. Report skipped or blocked checks and the reason.
- A change is complete only when implementation, contracts, tests, and affected documentation agree.
- For core logic or major feature changes, update the corresponding feature document in `docs/`, creating one only when needed. Describe current behavior and key constraints; prefer maintaining an existing document over adding a change report. Minor fixes and local refactors need no documentation changes.
- Keep `docs/index.md` links and one-line descriptions current when adding, moving, or removing documents. Introduce feature-based subdirectories as navigation needs grow.

## Commit & Pull Request Guidelines

- Use concise, imperative commit subjects. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `test:` are preferred.
- Pull requests should explain purpose, affected requirements, validation performed, and linked issues.
- Any PR with visible UI changes (Web UI, Desktop shell, Android shell, Renderer extension, or Console UI) must include sanitized demo screenshots or short recordings showing key states (or before/after) in the PR description. Agents working on visible UI changes must capture and inspect rendered screenshots before handing off or opening the PR; if a change under UI paths has no visible change, state `No visual changes: <reason>` instead of attaching screenshots.
- Never commit ignored reference repositories, secrets, logs, downloads, or local environment files.
