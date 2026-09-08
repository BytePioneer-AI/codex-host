## Context

The old PR coupled local concurrency protection to a mandatory native fence declaration. Current upstream supports more Adapters, including same-ID last-Turn rollback. This change preserves those declarations and separates Host-local guarantees from native guarantees.

## Decisions

ExternalSessionAccess wraps each registered HarnessSession. It tracks execute, readSnapshot, command list/execute and actual refreshUsage completion. An exclusive lease excludes these calls and in-flight output projection. The wrapper reads optional command capability lazily. No Harness-specific dispatch branches or global operation counters are introduced.

The single output consumer remains authoritative. Output arriving during preparation invalidates the lease and waits until preparation releases it. It is then delivered normally. During source close, the output gate opens while public calls remain blocked; any output invalidates the prepared candidate. A snapshot refresh uses the same coordination so it cannot overwrite freshly projected output with an older snapshot.

Candidates are reserved before configuration/read access. Check object ownership and native identity against loaded Threads and reserved candidates. Never close an aliased owned Session. Retain current same-ID last-Turn support for a distinct wrapper; legacy Fork-derived replacement still requires a distinct identity. Validate ordered input/items/outcomes/Model/checkpoint availability after removing only regenerated Item IDs. Restore selectable settings; fixed settings must already match. Snapshot native identity must match the candidate identity.

Before closing the source, recheck the preparation record, ownership and output state. Close and drain the source with a bounded resource wait, then commit through Store CAS. On confirmed close followed by failure, unload the old wrapper so the next request resumes the authoritative stored identity. If shutdown is unconfirmed, retire the wrapper and keep ownership blocked; do not silently resume or replay native input. Cleanup timeout is ten seconds and does not imply successful termination.

After Store success, a Runtime publication failure leaves the new record authoritative and the Runtime unloaded. Candidate cleanup closes wrappers, not durable native history. Failed candidate close retains its ownership reservation rather than allowing the same resource to be adopted elsewhere.

## Compatibility and limits

The wrapper cannot stop independently attached native clients or prove that a shared remote service has no background work. DSH/Antigravity declarations remain unchanged. Grok-style same-ID native rewind is still permitted and may already affect source history before a Store conflict; this change does not claim source-preserving native semantics for it. Native preparation requiring stronger guarantees remains Adapter-specific work.

No input or output is automatically replayed after failure. A failed shutdown blocks continued use of that loaded wrapper until its owner is torn down; restarting must preserve stored data. A source whose close succeeded can be safely reloaded from the record on ordinary failure.

FakeHarnessAdapter now creates a fresh wrapper over the same persisted snapshot when resuming a closed fake Session. This models the recovery boundary exercised by Host tests without reviving a closed output channel.

## Validation

Cover stale records, overlapping input/edit, foreign candidate ownership, same-ID compatibility, fixed settings, changed history, throwing reads, failed close, failed publication, queued output, usage refresh lifetime and cleanup timeout. Existing Store failure tests now verify cold recovery through the original identity. Run Host/steering/Fake Harness regressions and the real Claude seven-scenario gate. These native tests establish Claude behavior on macOS, not a universal fence for all Harnesses.
