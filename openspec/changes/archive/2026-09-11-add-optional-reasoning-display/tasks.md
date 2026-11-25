## 1. Preference and settings

- [x] 1.1 Add a browser-local boolean preference with a fail-closed default
- [x] 1.2 Add an accessible Settings → Model Pool switch with English and Chinese copy
- [x] 1.3 Notify the live Renderer when the preference changes without persisting reasoning text

## 2. Notification boundary

- [x] 2.1 Validate only reasoning start, summary delta, and reasoning completion notifications
- [x] 2.2 Ignore content, encrypted/redacted fields, non-reasoning Items, malformed IDs, and unknown methods
- [x] 2.3 Add a request-manager relay that reconnects once when the active Host route changes

## 3. Presentation

- [x] 3.1 Gate notifications through one fixed external Thread ownership inspection
- [x] 3.2 Keep per-Thread reasoning summary state in memory only
- [x] 3.3 Mount a plain-text collapsible panel beside the verified Composer contract
- [x] 3.4 Expand and auto-scroll live output, then collapse completed output
- [x] 3.5 Subscribe and observe only while opted in, and prevent observer self-refresh loops

## 4. Validation

- [x] 4.1 Cover default-off persistence and settings interaction
- [x] 4.2 Cover notification validation, exact delta accumulation, Thread isolation, and completion state
- [x] 4.3 Cover request-manager subscription and route replacement
- [x] 4.4 Add Chromium coverage for live expansion, completion collapse, private-field omission, opt-out teardown, and native Codex exclusion
- [x] 4.5 Cover stale-route callbacks, route-scoped ownership, ownership timeout, and bounded pending output
- [x] 4.6 Run repository format, lint, typecheck, TypeScript, Rust, and packaging gates
