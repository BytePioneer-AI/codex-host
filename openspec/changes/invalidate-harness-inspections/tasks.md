## 1. Contract and Host
- [x] Add cursor-bearing Harness inspection invalidation event.
- [x] Publish after explicit refresh inspections, including Codex and failure results; add tests.

## 2. Web cache
- [x] Subscribe to Harness invalidation and hello, clear caches, forward browser event and unsubscribe on close.
- [x] Preserve cache Promise ownership for late completions and errors; test failure caching, model changes and reconnect.

## 3. Selector
- [x] Register browser event and refresh only the local catalog.

## 4. Settings
- [x] Coalesce manual refresh after in-flight checks while retaining availability purpose; add tests.

## 5. Validation
- [x] Run focused tests, TypeScript checks, lint and OpenSpec validation.
