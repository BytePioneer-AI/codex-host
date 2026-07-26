# Repository Guidelines

## Project Purpose & Structure

This repository contains the product and technical baselines for `codexhost` and its implementation workspace. The product aims to run Pi inside the Codex Desktop shell, with additional Harnesses planned later.

- `docs/产品需求文档.md` is the current product baseline: scope, MVP requirements, and acceptance criteria.
- `docs/领域术语表.md` defines the shared domain language, including Harness, Model, Provider, Thread, and Native Session.
- `docs/技术架构设计文档.md` is the formal technical architecture baseline.
- `docs/数据持久化设计文档.md` defines the Mapping Store implementation, atomic persistence, recovery, and migration baseline.
- `docs/工程落地文档.md` defines the toolchain, workspace layout, module dependencies, and build outputs.
- `docs/开发步骤清单.md` defines implementation priority, technical gates, development batches, and completion criteria.
- `reference/` contains ignored local reference repositories such as CodexPlusPlus and Paseo; it is not codexhost source.

If documents conflict, report the conflict explicitly. Follow the PRD as the current delivery baseline.

Use `docs/开发步骤清单.md`, active OpenSpec changes, source code, and tests to determine the current implementation status. Do not infer implemented capabilities solely from package names, directory structure, or module presence.

## Code Layout

- `crates/` is the Rust Cargo Workspace. `launcher` and `shim` are binary crates; `platform` is their shared Windows/macOS platform library. Rust owns native launch, process, and platform integration, not Host protocol or Harness semantics.
- `packages/` is the npm/TypeScript Workspace. `protocol-core`, `mapping-store`, `harness-adapter`, `desktop-control`, `host-runtime`, and `adapters/pi` are Node.js modules for protocol routing, metadata persistence, Harness abstraction, Desktop control, composition, and Pi integration.
- `packages/shared-contracts/` contains browser-safe shared types and runtime schemas. It must not depend on Node.js-only capabilities.
- `packages/renderer-extension/` is TypeScript built to browser JavaScript. It must not import Node.js built-ins, Electron private APIs, or Harness SDKs.
- `tools/` contains development-only Node.js utilities and technical Gate tooling. `tests/e2e/`, `tests/differential/`, and `tests/fixtures/` contain Playwright tests, protocol differential tests, and reviewed fixtures. Package-level `test/` directories contain Vitest tests; crate-level `tests/` directories contain Rust integration tests.
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

- Add or update tests for changed behavior, regressions, error handling, and boundary conditions.
- Prefer testing public behavior and complete structured values over internal implementation details.
- Run the narrowest relevant checks while developing, followed by `npm run check` and `npm run build` before considering implementation work complete.
- Do not claim a check passed unless it was executed. Report skipped or blocked checks and the reason.
- A change is complete only when implementation, contracts, tests, and affected documentation agree.

## Commit & Pull Request Guidelines

- Use concise, imperative commit subjects. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `test:` are preferred.
- Pull requests should explain purpose, affected requirements, validation performed, and linked issues. Include screenshots only for visible UI changes.
- Never commit ignored reference repositories, secrets, logs, downloads, or local environment files.
- Review license compatibility and AGPL obligations before copying anything from CodexPlusPlus or Paseo.
