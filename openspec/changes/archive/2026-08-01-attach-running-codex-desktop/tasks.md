## 1. Runtime State And Classification

- [x] 1.1 Add a focused Launcher module for the three startup states with injected observations and unit tests
- [x] 1.2 Add a versioned minimal runtime descriptor with strict parsing, atomic replacement, matching-owner cleanup, and tests
- [x] 1.3 Publish the descriptor only after clean Desktop and Controller readiness, and remove it on matching shutdown

## 2. Windows Instance Control

- [x] 2.1 Add Windows process identity needed for validated stale-Launcher cleanup
- [x] 2.2 Probe and record Windows second-activation Inspector/CDP behavior before deciding the production boundary
- [x] 2.3 Add bounded endpoint and process-chain observation without logging command lines, environment, or user data

## 3. Controlled Instance Reuse

- [x] 3.1 Add a narrow Desktop Controller attachment handshake carrying a random nonce and fixed readiness result
- [x] 3.2 Make a second Launcher reuse the owning Controller and activate the existing window without starting duplicate runtime processes
- [x] 3.3 Add hermetic duplicate-launch, identity-mismatch, stale-state, and cleanup tests
- [x] 3.4 Simplify controlled reuse to launcher ownership plus one nonce-authenticated Controller activation handshake; remove repeated Inspector, Desktop PID, and Shim/Host validation

## 4. Independently Started Official Desktop

- [x] 4.1 Probe and record whether current Windows Codex accepts second-activation Inspector/CDP configuration on the existing Desktop root
- [x] 4.2 Remove the unsupported production bootstrap, dedicated platform activation/window APIs, and executable Probe while retaining the evidence record
- [x] 4.3 Return an explicit full-quit instruction without injecting, restarting, or terminating the existing Desktop

## 5. Launcher Integration

- [x] 5.1 Preserve the existing no-Desktop launch path and reuse a live codexhost-controlled instance
- [x] 5.2 Keep Start Menu and CLI errors explicit for an independently started official Desktop without automatically terminating it
- [x] 5.3 Add Launcher CLI integration coverage for clean launch, controlled reuse, stale recovery, and official-instance rejection

## 6. Verification And Baselines

- [x] 6.1 Run focused Rust format, Clippy, and Launcher/platform tests plus desktop-control lint, typecheck, and tests
- [x] 6.2 Run strict OpenSpec validation and update affected architecture/checklist documentation to supersede unconditional rejection
- [x] 6.3 Run a controlled real Windows capability Probe and record the unsupported second-activation result without sensitive data
- [x] 6.4 Run real Windows user-behavior scenarios for official-first launch, clean codexhost launch, repeat/double launch, official reactivation, stale recovery, and user quit
