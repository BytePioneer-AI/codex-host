## Context

Linux support currently assumes x86-64 at three boundaries: official Desktop ELF validation, the npm release target registry, and Linux Gate A evidence. The remaining Launcher, Shim, Host Runtime, Remote Host, `/proc`, pidfd, Unix socket, and process-supervision implementations are Linux-generic. OpenAI now publishes matching official ARM64 Desktop `.deb` and `.rpm` packages, so architecture support can be expressed as another native Linux target instead of a separate runtime path.

## Goals / Non-Goals

**Goals:**

- Treat `linux-arm64` as a first-class npm and distribution target.
- Validate that official Linux Desktop and packaged Codex CLI ELF architectures match the codexhost build architecture.
- Build, smoke-test, and publish the ARM64 package on a native GitHub Actions runner.
- Allow Linux Gate A evidence to identify either supported native architecture.
- Preserve npm-owned update behavior and Remote Host semantics on ARM64.

**Non-Goals:**

- Add `.deb`, `.rpm`, AppImage, or another codexhost Linux installer.
- Support 32-bit ARM, cross-architecture Desktop execution, emulation, or non-official ChatGPT package layouts.
- Change Harness, protocol, Renderer, or Mapping Store semantics.

## Decisions

- Add one `linux-arm64` target beside `linux-x64`, using Rust target `aarch64-unknown-linux-gnu` and npm CPU `arm64`. This reuses the current architecture-specific optional-package design and avoids a multi-architecture binary package.
- Make Linux ELF validation compile-target-aware with `EM_X86_64` for `target_arch = "x86_64"` and `EM_AARCH64` for `target_arch = "aarch64"`. Desktop and bundled Codex CLI must both match the running codexhost architecture; accepting either architecture at runtime would weaken package identity checks.
- Keep Linux updates npm-only. `linux-arm64` participates in distribution metadata and npm updates but remains excluded from installer asset selection.
- Run package build and smoke tests on `ubuntu-22.04-arm`, rather than cross-building on x64, so Node optional dependencies, Rust binaries, npm CPU constraints, executable smoke checks, and the existing Linux glibc compatibility baseline are observed natively.
- Generalize Linux Gate A schemas from literal `x64` to `x64 | arm64`, while retaining architecture-specific evidence and release-readiness wording.

## Risks / Trade-offs

- [Official ARM64 package layout may diverge from x64] → Preserve strict paths, metadata identity, ELF, and symlink checks; require native Gate A evidence before claiming release readiness.
- [ARM64 hosted runner availability or queueing can delay releases] → Use the standard `ubuntu-22.04-arm` runner and keep target jobs independent with `fail-fast: false`.
- [A dependency may install a different ARM64 native optional package] → Build and smoke-test on native ARM64 with `npm ci`, package installation, executable-mode checks, and `codexhost --version`.
- [Broad string unions can accidentally enable Linux installer flow] → Keep installer targets separately typed and treat both Linux npm targets explicitly as non-installer distributions.
