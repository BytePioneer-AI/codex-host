## 1. Codex User Input Gate

- [x] 1.1 Capture and runtime-validate the current `item/tool/requestUserInput` request and response shapes without storing prompt or answer text
- [x] 1.2 Prove in the current Desktop build that a Tool-associated request renders, returns an answer, and can be dismissed
- [x] 1.3 Prove or reject the synthetic Generic Tool Item strategy for standalone and preflight Questions; update the design before continuing if rejected

## 2. HarnessAdapter Question Contract

- [x] 2.1 Add choice/text Question, response, Interaction output, closure event, and `interaction.respond` command types without adding Approval
- [x] 2.2 Extend FakeHarnessSession with pending Question state, validated responses, expiry, cancellation, and unique closure
- [x] 2.3 Add reusable contract tests for ordering, malformed/duplicate/wrong-Session responses, Turn terminal ordering, cancel, fault, close, and continuation

## 3. Codex Interaction Projection

- [x] 3.1 Add a Protocol Core Question projector for `item/tool/requestUserInput`, including choice/text/timeout conversion, secret fail-closed behavior, and runtime response validation
- [x] 3.2 Add synthetic Generic Tool Item lifecycle projection for Questions without a native Item and reject conflicting or post-terminal projection
- [x] 3.3 Add projector tests against the reviewed current Codex wire shape, including malformed answers and degraded editor behavior

## 4. Host Bidirectional Routing

- [x] 4.1 Add a namespaced Host server-request registry and intercept only exact pending Desktop response IDs
- [x] 4.2 Route validated answers to the owning external Session through `interaction.respond` while preserving official request/response transparency
- [x] 4.3 Integrate Interaction response gating, synthetic Item completion, timeout, Turn cancel, Thread delete, fault, and Host shutdown cleanup
- [x] 4.4 Add Host tests for early Question, answer, dismissal, malformed/unknown/duplicate response, concurrent official traffic, cancel, and unique terminals

## 5. Pi Native Interaction Mapping

- [x] 5.1 Add strict Pi RPC schemas for blocking `select`, `confirm`, `input`, and `editor` requests plus native response writes
- [x] 5.2 Map user Extension UI requests emitted by Pi to Host Questions with separate Host/native IDs, active Tool association, timeout, and no Approval inference
- [x] 5.3 Implement exact response conversion, duplicate/unknown rejection, native timeout, abort, fault, close, and same-Session continuation
- [x] 5.4 Add Pi transport and Adapter tests for normal, early, Tool-associated, standalone, timeout, cancel, exit, and race scenarios

## 6. Preserve Pi Native Capabilities

- [x] 6.1 Remove the codexhost-owned Question Extension asset and model-facing Tool
- [x] 6.2 Start Pi without a codexhost `--extension` argument or Adapter Extension-path option while leaving Pi-owned discovery unchanged
- [x] 6.3 Test absence of production Extension injection and retain generic mapping tests for native Interaction records emitted by user Extensions

## 7. End-to-End Verification

- [x] 7.1 Run focused contract, Protocol Core, Host Runtime, and Pi Adapter native Interaction tests
- [x] 7.2 Run a controlled real Desktop/Pi Gate with a reviewed temporary Extension fixture for choice, text, cancel, timeout, early Question, continuation, and process cleanup; do not ship or inject that fixture
- [x] 7.3 Audit boundaries and privacy so Pi RPC fields, complete native IDs, prompts, answers, and secret values do not enter shared packages or tracked evidence
- [x] 7.4 Update affected Pi/HarnessAdapter status and verification documentation, then run `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`
