## 1. Codex User Input Gate

- [ ] 1.1 Capture and runtime-validate the current `item/tool/requestUserInput` request and response shapes without storing prompt or answer text
- [ ] 1.2 Prove in the current Desktop build that a Tool-associated request renders, returns an answer, and can be dismissed
- [ ] 1.3 Prove or reject the synthetic Generic Tool Item strategy for standalone and preflight Questions; update the design before continuing if rejected

## 2. HarnessAdapter Question Contract

- [ ] 2.1 Add choice/text Question, response, Interaction output, closure event, and `interaction.respond` command types without adding Approval
- [ ] 2.2 Extend FakeHarnessSession with pending Question state, validated responses, expiry, cancellation, and unique closure
- [ ] 2.3 Add reusable contract tests for ordering, malformed/duplicate/wrong-Session responses, Turn terminal ordering, cancel, fault, close, and continuation

## 3. Codex Interaction Projection

- [ ] 3.1 Add a Protocol Core Question projector for `item/tool/requestUserInput`, including choice/text/secret/timeout conversion and runtime response validation
- [ ] 3.2 Add synthetic Generic Tool Item lifecycle projection for Questions without a native Item and reject conflicting or post-terminal projection
- [ ] 3.3 Add projector tests against the reviewed current Codex wire shape, including malformed answers and degraded editor behavior

## 4. Host Bidirectional Routing

- [ ] 4.1 Add a namespaced Host server-request registry and intercept only exact pending Desktop response IDs
- [ ] 4.2 Route validated answers to the owning external Session through `interaction.respond` while preserving official request/response transparency
- [ ] 4.3 Integrate Interaction response gating, synthetic Item completion, timeout, Turn cancel, Thread delete, fault, and Host shutdown cleanup
- [ ] 4.4 Add Host tests for early Question, answer, dismissal, malformed/unknown/duplicate response, concurrent official traffic, cancel, and unique terminals

## 5. Pi Native Interaction Mapping

- [ ] 5.1 Add strict Pi RPC schemas for blocking `select`, `confirm`, `input`, and `editor` requests plus native response writes
- [ ] 5.2 Map Pi requests to Host Questions with separate Host/native IDs, active Tool association, timeout, and no Approval inference
- [ ] 5.3 Implement exact response conversion, duplicate/unknown rejection, native timeout, abort, fault, close, and same-Session continuation
- [ ] 5.4 Add Pi transport and Adapter tests for normal, early, Tool-associated, standalone, timeout, cancel, exit, and race scenarios

## 6. Controlled Pi Question Extension

- [ ] 6.1 Add a side-effect-free `codexhost_question` Pi Extension Tool for one choice or text Question and build it as an explicit Adapter asset
- [ ] 6.2 Load the controlled Extension through an explicit repeatable Pi CLI flag without mutating user/project settings or disabling native Extension discovery
- [ ] 6.3 Test Extension path resolution, startup failure, Tool result semantics, and absence of project-trust or permission-policy behavior

## 7. End-to-End Verification

- [ ] 7.1 Run focused contract, Protocol Core, Host Runtime, Pi Adapter, and Extension tests
- [ ] 7.2 Run a controlled real Desktop/Pi Gate for choice, text, cancel, timeout, early Question, continuation, and process cleanup
- [ ] 7.3 Audit boundaries and privacy so Pi RPC fields, complete native IDs, prompts, answers, and secret values do not enter shared packages or tracked evidence
- [ ] 7.4 Update affected Pi/HarnessAdapter status and verification documentation, then run `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`
