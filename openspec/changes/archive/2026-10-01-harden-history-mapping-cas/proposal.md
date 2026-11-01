## Why

External history replacement validates retained Turn IDs but does not require the mapping record that was used to prepare the replacement to remain current. A configuration or identity update during asynchronous native derivation can therefore be overwritten by a stale replacement even when the retained Host Turn prefix still matches.

## What Changes

- Require the expected record revision and complete source Native Session Ref for both ready-session replacement operations, checked inside the existing serialized atomic update.
- Preserve the preparation record across asynchronous rollback work and pass it through Repository to Mapping Store.
- Add regressions for stale revisions, changed source locators, queued writes, persistence failure, and both rollback paths.
- Retain existing same-identity last-Turn rollback, Adapter capability declarations, stored record format, and native lifecycle behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-thread-mapping-store`: A history replacement must compare and replace the exact expected ready record, not just a matching shorter Turn prefix.

## Impact

Changes are limited to Mapping Store replacement input types and checks, Host Repository and rollback preparation, focused tests, and this specification. The internal TypeScript replacement API requires new arguments; all workspace callers are updated together. No plugin API, wire protocol, persistent schema, dependency, or native Harness change is required. This does not provide native execution fencing or undo native in-place mutations.
