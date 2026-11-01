## 1. Direct Renderer CDP control

- [x] 1.1 Add focused tests for exact primary target selection, current/new-document injection order, activation, binding validation, and target replacement.
- [x] 1.2 Implement the Renderer-only CDP Control Session in a focused Desktop Control module and export its production entry point.
- [x] 1.3 Add direct Renderer Request Manager policy installation while preserving the existing reviewed discovery and bridge runtime.

## 2. Production launch and recovery

- [x] 2.1 Point Production Controller at the Renderer-only Session and rename the production endpoint option and state from Inspector terminology to Renderer CDP terminology.
- [x] 2.2 Change Launcher runtime control to pass an ephemeral loopback `--remote-debugging-port` and the Renderer CDP endpoint to the Controller.
- [x] 2.3 Update focused Controller and Launcher tests for complete installation failure, background recovery, attachment activation, and new arguments.

## 3. Renderer prerequisite degradation

- [x] 3.1 Remove the main-process title-ready marker as a hard Adapter installation prerequisite without synthesizing readiness.
- [x] 3.2 Update focused Renderer Adapter tests for installation with title policy absent while preserving draft-policy fail-closed behavior.

## 4. Validation

- [x] 4.0 Configure Renderer schema validation for strict CSP before the production bundle initializes, with a focused regression assertion.
- [x] 4.1 Run focused Desktop Control and Renderer Extension tests.
- [x] 4.2 Run TypeScript build and focused Rust Launcher tests.
- [x] 4.3 Run a controlled local Codex Desktop launch/audit when the installed application is available, and record any blocked validation.
