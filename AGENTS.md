# Repository Guidelines

## Code Layout

- `crates/` is the Rust Cargo Workspace. `launcher`, `shim`, and `updater` are binary crates; `platform` is their shared Windows/macOS platform library. Rust owns native launch, process, update installation, and platform integration, not Host protocol or Harness semantics.
- `packages/` is the npm/TypeScript Workspace. `protocol-core`, `mapping-store`, `harness-adapter`, `desktop-control`, `update-manager`, `host-runtime`, and Harness adapters are Node.js modules for protocol routing, metadata persistence, Harness abstraction, Desktop control, background update preparation, composition, and Harness integration.
- `packages/shared-contracts/` contains browser-safe shared types and runtime schemas. It must not depend on Node.js-only capabilities.
- `packages/renderer-extension/` is TypeScript built to browser JavaScript. It must not import Node.js built-ins, Electron private APIs, or Harness SDKs.
- `scripts/release/` contains shared build-time release infrastructure plus platform-specific macOS and Windows packaging definitions. This path is not an application Runtime package. `tools/` contains development-only Node.js utilities and technical Gate tooling. `tests/e2e/`, `tests/differential/`, `tests/fixtures/`, and `tests/release/` contain Playwright tests, protocol differential tests, reviewed fixtures, and release infrastructure tests. Package-level `test/` directories contain Vitest tests; crate-level `tests/` directories contain Rust integration tests.
- `openspec/` tracks specifications and proposed, active, or archived changes. `docs/` remains the product and architecture authority. `.github/workflows/` contains Windows/macOS CI.
- Generated and local-only paths defined by `.gitignore`, including dependencies, build outputs, reports, logs, downloads, `.pi/`, `.codexhost/`, and `reference/`, must not be committed.

## Coding Style & Naming Conventions

- Write the brand as lowercase `codexhost`.
- Follow `docs/领域术语表.md`; in particular, do not conflate Harness, Model, Provider, Account, or Billing Source.
- Name new documentation with concise Chinese titles, for example `Pi适配器设计文档.md`. Retain established technical terms such as Pi, Harness, Adapter, RPC, and SDK when translation would reduce precision.
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
