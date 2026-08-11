# Repository Guidelines

## Code Layout

### Native Rust

- `crates/`
  - `launcher/`: native application launch
  - `shim/`: process proxying
  - `updater/`: update installation
  - `platform/`: shared Windows/macOS integration

### TypeScript Workspace

- `packages/`
  - `protocol-core/`: Host protocol routing and projection
  - `mapping-store/`: external Thread metadata persistence
  - `harness-adapter/`: Harness abstraction
  - `adapters/`: Pi and Claude Code Harness integrations
  - `desktop-control/`: Desktop interaction
  - `host-runtime/`: runtime composition
  - `update-manager/`: background update preparation
  - `shared-contracts/`: browser-safe types and runtime schemas
  - `renderer-extension/`: browser JavaScript extension

### Build and Release

- `scripts/release/`: release preparation, packaging, and publishing
- `tools/`: development utilities and technical Gates

## Boundary Rules

- Rust owns native launch, process management, update installation, and platform integration. It must not own Host protocol or Harness semantics.
- `shared-contracts` must not depend on Node.js-only capabilities.
- `renderer-extension` must not import Node.js built-ins, Electron private APIs, or Harness SDKs.
- Harness-specific protocol details must remain inside the corresponding Adapter.

## Coding Style & Naming Conventions

- Write the brand as lowercase `codexhost`.
- Follow `docs/领域术语表.md`; in particular, do not conflate Harness, Model, Provider, Account, or Billing Source.
- TypeScript uses Strict Mode, ESLint, and Prettier. Rust uses rustfmt and Clippy.

## Implementation Principles

- Inspect related implementations, tests, contracts, and documentation before making changes. Prefer established repository patterns and public APIs over parallel implementations.
- Reuse code only when semantics and ownership are aligned. Do not introduce a generic abstraction for a single speculative caller.
- Use as few concepts, states, entry points, and runtime actions as possible to express the real business flow directly.
- Keep changes narrowly scoped. Avoid unrelated refactors, renames, dependency upgrades, or formatting churn.
- Preserve the package and crate ownership boundaries described above. Prefer explicit data flow and typed contracts over hidden global state, stringly typed protocols, or implicit cross-module coupling.

## Code Size & Structure

- Keep handwritten production modules focused on one primary responsibility.
- Treat 500 lines as a design-review signal, not a hard limit. When an existing module approaches or exceeds 800 lines, prefer placing cohesive new functionality in a separate module unless there is a documented reason not to.
- Split code by responsibility and ownership, not solely to satisfy a line-count target.
- Keep executable scripts focused on orchestration. Move reusable, domain, parsing, persistence, and testable logic into the owning package or crate.
- Do not create wrapper functions that add no domain meaning and are used only once.
- Generated files, fixtures, migrations, and declarative schemas are exempt from line-count guidance.

## Testing & Completion

- To build and launch the application from a source checkout, run `npm start` at the repository root.
- Small, low-risk changes do not require tests. For high-risk or cross-package changes, or when explicitly requested, add focused tests for changed behavior and boundary conditions; do not run full test suites by default.
- Do not claim a check passed unless it was executed. Report skipped or blocked checks and the reason.
- A change is complete only when implementation, contracts, tests, and affected documentation agree.

## Commit & Pull Request Guidelines

- Use concise, imperative commit subjects. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `test:` are preferred.
- Pull requests should explain purpose, affected requirements, validation performed, and linked issues. Include screenshots only for visible UI changes.
- Never commit ignored reference repositories, secrets, logs, downloads, or local environment files.
