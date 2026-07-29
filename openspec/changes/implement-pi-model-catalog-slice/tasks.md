## 1. Browser-Safe Model Contracts

- [x] 1.1 Add strict browser-safe Model Ref, catalog, inspection, capability, effective-state, and fixed control-param Runtime Schemas to `shared-contracts`
- [x] 1.2 Add Shared Contracts schema, public-export, browser-bundle, privacy, and boundary tests

## 2. HarnessAdapter Model Semantics

- [x] 2.1 Extend `HarnessAdapter`, create input, Session capability/state, and command/result unions with inspect and Model selection
- [x] 2.2 Extend Fake HarnessAdapter with deterministic inspection, create-time Model validation, ordered effective-state output, and Idle-only selection
- [x] 2.3 Add shared contract tests for no-side-effect inspection, state-before-result ordering, duplicate/race rejection, and failed selection state preservation

## 3. Pi Native Mapping

- [x] 3.1 Add strict private Pi RPC parsing for available Models, native selection, and state readback without leaking native catalog fields
- [x] 3.2 Add exact `(provider, model id)` opaque Ref encoding/decoding, duplicate normalization, deterministic sorting, and malformed catalog tests
- [x] 3.3 Implement PiAdapter ephemeral inspection, lazy create-time selection, Idle-only `model.select`, readback mismatch handling, and configuration/Turn serialization
- [x] 3.4 Add Pi RPC and PiAdapter tests for cleanup, privacy, first-Turn ordering, successful selection, busy races, native rejection, and uncertain-state fault

## 4. Protocol And Host Routing

- [x] 4.1 Extend Protocol Core with bounded selected-Pi transport carrier encoding/decoding while preserving the generic token and official Model transparency
- [x] 4.2 Add Host handling for fixed inspect/select methods, ordered Session state observation, selected create input, and `turn/start.model` assertion/application
- [x] 4.3 Add Protocol/Host tests for malformed carriers, exact request ownership, state-before-response behavior, busy/error paths, and Codex passthrough

## 5. Renderer Model Experience

- [x] 5.1 Extend logical Composer state and replacement/revisit rules with a Pi Model Ref and stale asynchronous request generations
- [x] 5.2 Add a version-locked narrow request-manager client for only the fixed inspect/select methods and selected transport atom updates
- [x] 5.3 Add the separate Pi Model option control with loading, ready, empty, selecting, error, rollback, and fail-closed states
- [x] 5.4 Add Renderer state, adapter, DOM, stale-response, create-binding, existing-Thread selection, and Codex-restoration tests

## 6. Validation

- [x] 6.1 Run focused package tests, `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`
- [ ] 6.2 Run the controlled supported-Desktop/Pi Gate with operator approval and record only sanitized catalog/selection/routing/process conclusions
