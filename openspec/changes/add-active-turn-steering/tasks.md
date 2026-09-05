## 1. Public contract and broker

- [x] 1.1 Add optional active-Turn steering capability and typed command/result
- [x] 1.2 Validate and round-trip steering through the Harness broker
- [x] 1.3 Make unsupported Adapters reject steering explicitly without advertising it

## 2. Host routing

- [x] 2.1 Route externally owned `turn/steer` locally and preserve official passthrough
- [x] 2.2 Validate expected active Turn, text input, bounded client identity, and capability
- [x] 2.3 Deduplicate identified retries and gate steer output behind each response

## 3. OpenCode implementation

- [x] 3.1 Admit serialized steering through the current prompt transport with owned sortable message IDs
- [x] 3.2 Prevent idle reconciliation from completing across pending or newly admitted steering
- [x] 3.3 Serialize cancellation and close behind already-started admission while rejecting queued steering
- [x] 3.4 Group root and steering messages into one live and historical Host Turn
- [x] 3.5 Preserve root Native Turn identity, final Checkpoint, per-segment Diffs, Fork, and rollback boundaries
- [x] 3.6 Recover one persisted orphan steering admission at stable idle and converge transport faults without bypassing admission

## 4. Validation and documentation

- [x] 4.1 Cover capability compatibility, broker transport, Host ownership/fallthrough, idempotency, and response ordering
- [x] 4.2 Cover message ID grouping, multiple steering inputs, completion races, cancellation races, history, Fork, and rollback
- [x] 4.3 Update capability and OpenCode integration documentation
- [x] 4.4 Run OpenSpec validation, format check, lint, typecheck, focused tests, full TypeScript tests, and diff checks
