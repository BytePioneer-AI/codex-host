# Antigravity Permissions

Antigravity exposes only **Skip permissions (dangerous)**, which is also the
new-session default. Every Turn starts agy with its native
`--dangerously-skip-permissions` flag. codexhost does not add tool approvals,
allow/ask/deny matching, a read-only allowlist, or workspace path restrictions.
Use this Harness only in an environment where unrestricted tool execution is
acceptable. This does not grant administrator privileges or bypass OS controls.

## Why only Skip permissions?

Native agy 1.1.27 print mode cannot consume interactive permission responses.
The previous Configured permissions mode could therefore deny a tool and leave
an empty response. The former Desktop approvals workaround disabled native
permission checks and gated tools through a private Hook. Reimplementing agy's
permission policy in codexhost is not a supported replacement for a native
permission interface.

Configured permissions and Desktop approvals are no longer offered. Explicit
legacy mode IDs on create, resume, rollback, or live selection are rejected with
an instruction to select Skip permissions; they are not silently translated.
When the Host restores a saved legacy selection, restoration fails rather than
executing a Turn with broader permissions. Start a new Thread with Skip
permissions if the old Thread cannot be opened to change its selection.

The Adapter does not inspect `/config`, verify an all-tool `/hooks` gate, or
promise that native allow/ask/deny rules remain effective under skip. Actual CLI
behavior, independently configured native Hooks, and OS restrictions remain
outside codexhost's permission policy. A native denial is still reported with
sanitized diagnostics, not treated as success.

## Questions are not tool approvals

The private `PreToolUse` Hook is retained **only for `^ask_question$`** to bridge
single-choice and text questions to Desktop. Its `deny.reason` carries the real
user answer and prevents native automatic question skipping; it does not grant
or refuse permission for ordinary tools. Authentication, bounded payloads,
deadlines, duplicate-question checks, and cleanup remain in place.

Ordinary parent and child tools do not enter this bridge, do not consume its
128-question budget, and do not incur a Host Hook process or HTTP round trip.
The Question mechanism still depends on private CLI behavior and should be
revalidated after CLI updates.

## Validation

Focused tests cover the single dangerous/default mode, rejection of legacy
selections, native skip startup without permission probes, and 160 ordinary tool
calls followed by a Desktop Question in one Turn. Existing Question tests cover
responses, expiry, cancellation, authentication, and cleanup.

The long-Turn test uses a stand-in CLI to verify Adapter wiring, not to establish
agy's native permission-rule semantics. The obsolete opt-in Desktop approval
real test was removed because that mode is no longer supported.
