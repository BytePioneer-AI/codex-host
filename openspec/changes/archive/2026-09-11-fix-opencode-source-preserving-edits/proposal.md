## Why

OpenCode native revert also rewinds workspace files and mutates the source Session. Message editing needs an independent, durable history prefix while retaining current files. Cancellation errors can arrive before native idle and must not admit a follow-up Turn prematurely.

## What Changes

Use native exclusive-boundary Fork for rollback. Validate exact retained content, complete file-change projection, configuration and unchanged source. Preserve configuration on empty derived Sessions. Await native idle before cancellation completion.

## Capabilities

### New Capabilities

- `opencode-edit-recovery`: source-preserving native edits and idle-confirmed cancellation.

### Modified Capabilities

None.

## Impact

OpenCode Adapter, transport path inspection, focused regressions and real CLI gate. Uses current public interfaces; no Host-specific dispatch or mandatory fence. Company command and environment changes remain a later internal integration change.
