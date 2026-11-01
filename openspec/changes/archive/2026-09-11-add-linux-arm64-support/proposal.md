## Why

OpenAI now publishes official ChatGPT Desktop `.deb` and `.rpm` packages for ARM64 Linux, but codexhost still rejects ARM64 Desktop executables and publishes only a Linux x64 npm package. Adding ARM64 support now lets local Desktop users and SSH Remote Hosts use the same codexhost capabilities on native ARM Linux without emulation.

## What Changes

- Add `linux-arm64` as a first-class npm release and distribution target using `aarch64-unknown-linux-gnu`.
- Publish and select `@codexhost/cli-linux-arm64` on `linux/arm64` hosts.
- Accept official little-endian ARM64 ChatGPT Desktop and packaged Codex CLI ELF executables while preserving same-architecture validation.
- Extend update metadata, release publishing, CI, package smoke tests, and Linux Gate A contracts to cover ARM64.
- Update Linux support documentation to describe official x64 and ARM64 `.deb`/`.rpm` support and the absence of a Linux installer package.

## Capabilities

### New Capabilities
- `linux-arm64-runtime-support`: Native ARM64 Linux Desktop discovery, npm distribution, Remote Host operation, and release validation.

### Modified Capabilities
- `remote-ssh-harness-host`: ARM64 Linux SHALL be supported as a packaged SSH Remote Host architecture.
- `github-release-background-update`: npm-installed ARM64 Linux distributions SHALL resolve and update through the matching architecture-specific platform package.

## Impact

Affected areas include Linux native installation discovery in `crates/platform`, npm release target registration and package publication under `scripts/release`, distribution/update target contracts, Linux Gate A evidence schemas, GitHub Actions matrices, release tests, and Linux/Remote Host documentation. No installer is added for Linux; both Linux architectures continue to use npm distribution and npm-managed updates.
