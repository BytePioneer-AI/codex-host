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
  - `harness-plugin-files/`: installed Harness plugin manifests and per-plugin launch settings, read without importing plugin code
  - `harness-broker/`: native Broker communication; currently retains Claude Code-specific semantics
  - `adapters/`: Harness-specific implementations and plugin entry points
  - `desktop-control/`: CDP / Electron Inspector-driven Desktop interaction
  - `host-runtime/`: Host composition and installed plugin loading
  - `update-manager/`: background update preparation
  - `console-server/`: local codexhost console that works without Codex Desktop (diagnostics, updates, Harness launch settings)
  - `shared-contracts/`: browser-safe types and runtime schemas
  - `renderer-extension/`: browser JavaScript extension

### Build and Release

- `scripts/release/`: release preparation, packaging, and publishing
- `tools/`: development utilities and technical Gates

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

Use the applicable repository-local skills below when their task occurs; they support contextual invocation. Read the selected `SKILL.md` before using its workflow. Select by task rather than loading or executing every skill on every change. These guides supplement the ownership, scope, and validation rules in this file; copied examples do not establish installed tools or product capabilities.

| Task | Skill |
| --- | --- |
| Version releases, Release Notes, preview channels, and release recovery | [codexhost-release](.agents/skills/codexhost-release/SKILL.md) |
| Overview table of a batch of PRs with a 1–5 recommendation score | [codexhost-pr-overview](.agents/skills/codexhost-pr-overview/SKILL.md) |
| Reviewing a PR or local diff for correctness and boundaries | [codexhost-code-review](.agents/skills/codexhost-code-review/SKILL.md) |
| Selecting local checks before pushing or claiming checks pass | [codexhost-pre-push-checks](.agents/skills/codexhost-pre-push-checks/SKILL.md) |
| Finding evidence-backed simplification candidates (read-only audit) | [codexhost-find-simplifications](.agents/skills/codexhost-find-simplifications/SKILL.md) |
| Auditing comments and docs for reasoning-transcript leakage | [codexhost-trim-cot-leakage](.agents/skills/codexhost-trim-cot-leakage/SKILL.md) |

Existing Harness integration and Desktop update audit skills remain applicable to their specialized tasks.

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

- Choose build and validation commands from `package.json`, not a copied command catalog. For focused tests, use the repository configuration in `tests/vitest.config.js` or `tests/e2e/playwright.config.js`, and the owning `Cargo.toml` for Rust test features.
- To build and launch from source, run `npm start` at the repository root for Desktop or `npm start web` for Web; both restart the corresponding interface after building, reusing an unchanged shared Host. A changed Host restarts automatically only when the other interface is closed; otherwise a post-build prompt defaults to keeping Host (non-interactive runs keep it and warn). `--restart-host` / `--keep-host` override this choice; no running Host is left to the interface's `host ensure`. `--no-build` reuses existing artifacts and applies the same Host decision. Restarting Host interrupts its tasks. `npm start web -- --watch` also rebuilds Web UI sources on edit and swaps them into open pages without further restarts. On macOS/Windows the Desktop command stops running Codex Desktop processes before launch. Use it when launching is intended, not as a routine validation command; implementation is in `tools/dev-desktop/run.mjs`.
- Small, low-risk changes do not require tests. For high-risk or cross-package changes, or when explicitly requested, add focused tests for changed behavior and boundary conditions; do not run full test suites by default.
- Do not claim a check passed unless it was executed. Report skipped or blocked checks and the reason.
- A change is complete only when implementation, contracts, tests, and affected documentation agree.
- For core logic or major feature changes, update the corresponding feature document in `docs/`, creating one only when needed. Describe current behavior and key constraints; prefer maintaining an existing document over adding a change report. Minor fixes and local refactors need no documentation changes.
- Keep `docs/index.md` links and one-line descriptions current when adding, moving, or removing documents. Introduce feature-based subdirectories as navigation needs grow.

## Commit & Pull Request Guidelines

- Use concise, imperative commit subjects. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `test:` are preferred.
- Pull requests should explain purpose, affected requirements, validation performed, and linked issues. Include screenshots only for visible UI changes.
- Never commit ignored reference repositories, secrets, logs, downloads, or local environment files.
