## Why

Store compare-and-swap cannot prevent concurrent Host calls from using the same native Session during history preparation, nor recover a Runtime wrapper closed around a failed commit. Candidate ownership and retained content also require validation before configuration or publication.

## What Changes

- Coordinate public Session access and output projection through one Host-owned wrapper.
- Reserve candidate ownership before access; reject aliases of loaded or reserved Sessions.
- Validate retained history, identity and current settings on both rollback paths.
- Close and drain the source before Store commit, then publish the candidate; use the persisted record for recovery after confirmed close.
- Bound cleanup waits and block reuse after unconfirmed shutdown.

## Capabilities

### New Capabilities

- `external-thread-history-replacement`: local ownership, admission, output and failure recovery.

### Modified Capabilities

None; the existing Mapping Store expected-record contract remains the commit precondition.

## Impact

Host Runtime only, plus Fake Harness recovery support and focused tests. Depends on mapping CAS; integrated here with Claude recovery for native validation. No new Harness capability or mandatory replacementFence. Upstream steer retains cancel/terminal/new-Turn semantics.
