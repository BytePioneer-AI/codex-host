## 1. Native Linux Architecture

- [x] 1.1 Make official Linux Desktop and packaged Codex CLI ELF validation target-architecture-aware for x86-64 and ARM64
- [x] 1.2 Add focused Rust tests for accepted native and rejected cross-architecture Linux packages

## 2. Distribution and Updates

- [x] 2.1 Register `linux-arm64` in release targets, npm platform packages, distribution metadata, and Host update target resolution
- [x] 2.2 Extend release, npm package, publish, and update-manager tests for `linux-arm64`

## 3. CI and Compatibility Gates

- [x] 3.1 Add native ARM64 Linux CI/release jobs and package smoke coverage
- [x] 3.2 Generalize Linux Gate A architecture contracts and runtime reporting for x64 and ARM64

## 4. Documentation and Validation

- [x] 4.1 Update Linux and Remote Host documentation to include official ARM64 support and npm-only codexhost distribution
- [x] 4.2 Run focused formatting, type, release, update, and Rust checks; document any native Desktop Gate not executable on the current host

Validation note: the implementation host is macOS ARM64, so native Linux ARM64 npm smoke execution and the interactive Linux ARM64 Desktop Gate remain delegated to the `ubuntu-22.04-arm` CI/release jobs and a native ARM64 Linux Gate A run. Local `npm run check` reached a failure in unrelated uncommitted nvm-windows discovery work already present in the working tree; all ARM64-focused TypeScript tests, Rust checks, formatting, lint/type checks before that failure, and OpenSpec validation passed.
