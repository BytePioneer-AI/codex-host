## 1. Claude Native Question Transport

- [x] 1.1 Add private typed Claude Question request, response, and Interaction closure events to the transport contract
- [x] 1.2 Preserve the inherited Claude Tool set and enable native `AskUserQuestion` callbacks with `permissionMode: "default"` and `canUseTool`
- [x] 1.3 Runtime-validate native Question input and reject non-Question or malformed callbacks without exposing them
- [x] 1.4 Implement exact deferred callback response, AbortSignal cleanup, duplicate rejection, and bounded close/fault convergence

## 2. Claude HarnessAdapter Mapping

- [x] 2.1 Map native single, multiple, multi-select, and Other Questions to `HostQuestionInteraction` with private native correlation
- [x] 2.2 Implement validated `interaction.respond` conversion to native answer strings and explicit cancellation
- [x] 2.3 Close pending Interactions before Turn terminal, cancel, fault, and Session close while preserving continuation

## 3. Automated Verification

- [x] 3.1 Extend FakeClaudeTransport and Adapter tests for answer, multi-select, Other, Skip, invalid/duplicate response, early Question, and same-Session continuation
- [x] 3.2 Add SDK transport tests for query options, native input validation, exact `PermissionResult`, unknown Tool denial, AbortSignal, and duplicate response
- [x] 3.3 Audit boundaries and privacy so native IDs and SDK payloads stay in the Claude Adapter while prompt/answer values remain ephemeral and absent from diagnostics or tracked evidence

## 4. Completion Gates

- [x] 4.1 Run a controlled real Claude SDK Gate for native `AskUserQuestion`, cancellation, and continuation without registering a codexhost Tool
- [x] 4.2 Run a controlled Desktop Gate for the supported current UI shapes and record any multi-question, multi-select, Other, or visible-Thread limitation
- [x] 4.3 Update affected Claude/HarnessAdapter status documentation and run `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`
