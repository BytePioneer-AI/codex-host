## 1. HarnessAdapter Contract

- [x] 1.1 Add Turn Cancel command/result and Command Execution, Generic Tool, File Change, Tool output, and typed update unions
- [x] 1.2 Extend the Fake HarnessSession with correlated Tool lifecycles, cumulative output replacement, cancellation, and unique finalization helpers
- [x] 1.3 Add shared contract tests for interleaved Tools, failure, truncation semantics, cancellation idempotency, and Item-before-Turn terminals

## 2. Codex UI Projector

- [x] 2.1 Add a stateful Protocol Core projector for Agent Message, Command Execution, Generic Tool, File Change, and Turn snapshots
- [x] 2.2 Add projector tests for current Codex item shapes, command deltas, generic fallback, patch and turn Diff updates, outcomes, and invalid ordering
- [x] 2.3 Migrate Host Runtime text projection to the projector while preserving response-before-notification and thread/read behavior

## 3. Pi Tool And Cancel Mapping

- [x] 3.1 Extend the private Pi RPC transport with runtime-validated text/Tool events, cumulative Tool snapshots, Abort acknowledgement, and stable cancellation settlement
- [x] 3.2 Add Pi RPC tests for interleaved Tool calls, cumulative updates, failed Tools, cancellation, continuation, malformed lifecycle events, and bounded close
- [x] 3.3 Map Pi Bash, Generic Tool, bounded output, reliable successful Edit Patch, and Tool outcomes into Host Item lifecycles
- [x] 3.4 Add PiAdapter tests for Tool correlation, no synthetic Patch, truncation, Cancel/Close/Fault races, and continuation after Cancel

## 4. Host Routing And Integration

- [x] 4.1 Route Pi-owned `turn/interrupt` to `turn.cancel`, preserve official passthrough, and gate cancellation notifications behind the response
- [x] 4.2 Add Host tests for Command, Generic Tool, File Change/Diff, accepted and rejected interrupt, cancel response ordering, and Codex-owned interrupt passthrough
- [x] 4.3 Confirm Host Runtime and Protocol Core contain no Pi-native Tool event, Call ID, result detail, or Patch interpretation

## 5. Validation And Documentation

- [x] 5.1 Update affected design/status documentation to distinguish implemented Tool/Cancel behavior from deferred Interaction and history capabilities
- [x] 5.2 Run targeted tests, strict OpenSpec validation, `npm run check`, `npm run build`, and `git diff --check`
- [x] 5.3 Run a controlled real Desktop/Pi Tool, reliable Edit Patch, Cancel, continuation, and process-cleanup Gate, retaining only minimal local evidence
