## 1. Minimal Harness Contract

- [x] 1.1 Define create-session, text Turn command, result, state, error, output, Item, and Turn lifecycle types
- [x] 1.2 Export the minimal `HarnessAdapter` and `HarnessSession` interfaces without placeholder future methods
- [x] 1.3 Add a deterministic fake Adapter and contract tests for ordering, rejection, single active Turn, fault, and close

## 2. Pi Adapter

- [x] 2.1 Add injectable Pi transport fault reporting while keeping `PiRpcSession` private to the Pi package
- [x] 2.2 Implement lazy `PiAdapter` and `PiHarnessSession` with a single-consumer ordered output stream
- [x] 2.3 Normalize Pi startup, Turn, protocol, process, timeout, and close failures at the Adapter seam
- [x] 2.4 Test lazy startup, text delta order, success/failure terminals, Session fault order, multi-Turn reuse, and idempotent close

## 3. Host Runtime Migration

- [x] 3.1 Inject or compose a Pi `HarnessAdapter` in Host Runtime and remove direct `PiRpcSession`/`LazyPiSession` usage
- [x] 3.2 Consume Host-semantic Session outputs and preserve Codex response-before-notification projection order
- [x] 3.3 Preserve process-local `thread/read`, Codex passthrough, Pi route ownership, same-Thread reuse, and shutdown behavior
- [x] 3.4 Add Host tests with the fake Adapter for successful, rejected, failed, and early-output Turns

## 4. Validation And Documentation

- [x] 4.1 Update the HarnessAdapter design status and development checklist to distinguish the implemented text slice from deferred capabilities
- [x] 4.2 Run targeted tests, strict OpenSpec validation, `npm run check`, `npm run build`, and `git diff --check`
