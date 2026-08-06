## 1. Contracts and Host Projection

- [x] 1.1 Add a browser-safe strict Thread Usage snapshot schema and type covering optional token, cache hit rate, context, and cost fields.
- [x] 1.2 Add the fixed Renderer Usage inspection method and Host handler, returning only the current in-memory External Thread snapshot.
- [x] 1.3 Include the validated current Usage snapshot in External Thread inspection responses without changing Mapping Store or native Codex Usage notifications.
- [x] 1.4 Add shared-contract and Host tests for valid snapshots, unavailable official/unknown Threads, malformed requests, and unknown-field rejection.

## 2. Renderer Usage Control

- [x] 2.1 Add a Renderer Usage client that validates the fixed inspection request and response.
- [x] 2.2 Add unique native context anchor detection and Usage sibling insertion immediately before the native anchor, with fail-closed behavior for missing or ambiguous anchors.
- [x] 2.3 Add the compact `CH` and cost summary plus an accessible details Popover for available Usage fields.
- [x] 2.4 Bind Usage state to Thread ID and Composer request generations, initialize it from Thread inspection, and refresh it after native context updates with stale-result rejection.
- [x] 2.5 Dispose Usage controls and pending refreshes with Composer replacement, Thread switch, and Renderer teardown.

## 3. Verification

- [ ] 3.1 Add focused Renderer tests for anchor placement, no-native-mutation behavior, summary formatting, detail scope, hidden unavailable state, and stale update rejection.
- [ ] 3.2 Run focused package tests, TypeScript type checking, Renderer build, Prettier check, and `git diff --check`.
- [ ] 3.3 Run the supported Desktop smoke/Gate and verify the Usage control is left of the native context circle while the native circle remains unchanged.
