## 1. Browser-safe ownership contracts

- [x] 1.1 Add strict unique bounded Thread ownership-list params/result schemas and public exports
- [x] 1.2 Add Shared Contracts tests for valid mixed ownership, bounds, duplicates, leaked fields, and browser-safe build compatibility

## 2. Mapping Store-only Host route

- [x] 2.1 Add the fixed `codexhost/thread/ownership/list` Host handler using only ExternalThreadRepository lookup
- [x] 2.2 Add Host tests for ordered Codex/Pi/Claude ownership, invalid params, Store failure, official passthrough isolation, and no Adapter resume

## 3. Versioned sidebar decoration

- [x] 3.1 Extract the existing Agent labels/icon factory into a shared browser-safe Renderer module and preserve picker behavior
- [x] 3.2 Extend the fixed Renderer client with exact-match ownership-list validation
- [x] 3.3 Implement a focused sidebar observer/controller for validated row/Fiber identity, batching, caching, title-prefix decoration, row reuse, React replacement, failure, and disposal
- [x] 3.4 Integrate sidebar decoration with Renderer Binding Probe lifecycle and add focused integration tests

## 4. Validation

- [x] 4.1 Run focused Shared Contracts, Host Runtime, and Renderer Extension tests plus affected typecheck/build checks
- [x] 4.2 Run OpenSpec strict validation and a controlled supported-build Desktop visual check without recording Thread IDs or content
