## ADDED Requirements

### Requirement: ARM64 Linux SHALL be a native codexhost target
The release system SHALL define `linux-arm64` as an npm distribution target using Rust target `aarch64-unknown-linux-gnu`, npm platform `linux`, and npm CPU `arm64`. The architecture-neutral CLI package SHALL select the matching ARM64 platform package when `process.platform` is `linux` and `process.arch` is `arm64`.

#### Scenario: ARM64 user installs the npm CLI
- **WHEN** an ARM64 Linux user installs `@codexhost/cli` with optional dependencies enabled
- **THEN** npm installs `@codexhost/cli-linux-arm64`
- **AND** the CLI resolves that package instead of the x64 package

### Requirement: Linux Desktop discovery SHALL enforce the native architecture
On supported Linux builds, codexhost SHALL accept official little-endian 64-bit ELF Desktop and packaged Codex CLI executables only when their ELF machine matches the codexhost build architecture. It SHALL accept `EM_X86_64` on x86-64 and `EM_AARCH64` on ARM64, and SHALL reject cross-architecture or unsupported ELF executables.

#### Scenario: ARM64 official package is discovered
- **WHEN** ARM64 codexhost inspects an official production ChatGPT package whose Desktop and packaged Codex CLI are little-endian `EM_AARCH64` ELF executables
- **THEN** installation discovery succeeds with the existing official Linux package identity and paths

#### Scenario: Package architecture does not match codexhost
- **WHEN** the official package Desktop or packaged Codex CLI ELF machine differs from the codexhost build architecture
- **THEN** installation discovery rejects the package before managed launch

### Requirement: ARM64 Linux release validation SHALL run natively
CI and release workflows SHALL build and smoke-test the `linux-arm64` npm package on a native ARM64 Linux runner. Linux Gate A contracts SHALL record either `x64` or `arm64` and SHALL not classify one architecture's evidence as proof for the other architecture.

#### Scenario: ARM64 release package is prepared
- **WHEN** the release workflow builds `linux-arm64`
- **THEN** it compiles the ARM64 Rust binaries, builds browser and Host bundles, installs the platform and meta tarballs, verifies npm OS/CPU constraints and executable modes, and runs `codexhost --version` on ARM64
