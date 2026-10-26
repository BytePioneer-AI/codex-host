# Read a Thread on another Host

The delegation CLI can read a native Codex or external Harness Thread through an
existing Codex Desktop remote connection:

```sh
codexhost thread read 'thread://THREAD_ID?hostId=remote-ssh-discovered%3Amac' --view messages --limit 25
codexhost thread read THREAD_ID --host remote-ssh-discovered:mac --view result
```

The local CLI, Host Runtime, Desktop renderer and remote Host must include this
feature. Installing codexhost on both machines alone is not enough: the local
Desktop must have the requested Host connection available. The Host ID is the
Desktop connection identity, not an arbitrary SSH hostname or URL.

For a remote external Harness submission, the renderer supplies its submitting
connection identity on that start/steer request. The Host retains that identity
for the accepted external Turn. The CLI supplies its Host-provided calling Thread
ID; when that Thread's execution identity matches the requested Host, the Runtime
reads locally while preserving the Host-qualified result link. User text and
links are unchanged. This context is per Thread/Turn, not a global alias or a
guess from a hostname/target Thread ID. A rejected submission cannot replace the
previous context; a later context-free submission clears it. Registered Harness
commands (such as `/init`) use the same context update and rollback boundary as
ordinary prompt Turns, before invoking the native command. A command without
source context clears the prior identity too. Standalone CLI
commands without caller context use the bare Thread ID on the owning machine.
Explicit foreign Host reads still require a Desktop connection and never fall
back to local history. Context is in memory and is restored by the next Desktop
submission after a Runtime restart.

The authenticated local Runtime delegates a fixed `read-thread` operation over
the existing Launcher/Controller channel. The renderer selects exactly that
Host's existing request client. The remote `codexhost/thread/delegation-read`
operation uses the same Harness-aware snapshot projection as local CLI reads.
Shared external Threads remain routed to their shared owner.

No new Turn is submitted. Thread ownership is not transferred. Native Harness
history may be loaded by the ordinary read path. There is no shell execution,
arbitrary RPC forwarding, automatic SSH connection creation, credential copying,
or local fallback on remote failure. Requests are bounded and not retried.

`messages` pages visible user/Agent text, not tool output or reasoning. Preserve
the returned Host-qualified link and `nextCursor` when requesting another page.
Remote send, cancel, wait and watch are outside this feature's scope.

Serialized Controller replies (including the envelope and newline) are limited to
16 MiB for Thread reads; settings operations retain their 1 MiB limit. Oversized
Thread replies return `RESPONSE_TOO_LARGE`, not a connection failure. Reduce the
message page size when possible; individual results larger than this limit are
not supported. No message text is silently truncated.

Thread reads have a 35-second renderer deadline and a 40-second Controller
transport deadline, allowing the underlying 30-second Desktop RPC to finish.
Other renderer management operations retain their 8-second deadline. Expiry does
not cancel an already dispatched native read and never triggers a retry.

## Desktop-local references from a remote Agent

An explicit `hostId=local` reference (including `--host local`) first reads the
executing Runtime's local history. Only a not-found or not-loaded error triggers
fallback: the Runtime tries its currently attached Desktop connections in
registration order and returns the first successful read of that Desktop's local
Host. Bare IDs remain machine-local; explicit non-local Host IDs keep their
existing routing. Permission, storage, invalid-reply and size errors do not
trigger further probing. Missing Threads, disconnected Desktops and unanswered
callbacks allow the next connection to be tried.

The callback uses a fixed read notification and reply RPC on each existing
connection. It does not open SSH connections, scan machines, retain a
Thread-to-source mapping, or expose arbitrary RPC execution. The Desktop uses
`codexhost/thread/delegation-read` directly, so a callback cannot recursively
trigger fallback. Shared external Thread owners use their attached GUI sessions
for these callbacks, not their internal owner stream.

Both the requesting Runtime and Desktop renderer/local Host must be updated.
Each Desktop attempt expires after 35 seconds; disconnect closes its pending
reads. Old renderers may not answer and therefore incur that deadline. Replies
are bounded to 16 MiB and their Thread identity is validated. No Turn is started.
The returned JSON and compact output include `readSource: "connected-desktop"`
when fallback succeeds, and preserve the `hostId=local` link for subsequent reads.

This is deliberately first-success probing, not source affinity. If several
machines contain the same Thread ID, local history wins, then the first
successful Desktop. Each page repeats that selection; connection changes or
replicated histories may change which copy answers. Only use this fallback with
trusted attached Desktops: their local Thread reads are available to the connected
Host, not restricted to references in the most recent prompt.

## Validation boundary

Source regression tests cover CLI Host preservation, explicit remote routing
without local fallback, strict operation validation, renderer Host selection,
Desktop-local fallback ordering, callback correlation, disconnect/timeout cleanup,
and a CLI-to-Host callback round trip. A browser fixture covers real window
notification delivery; it does not validate installed Desktop transport.
Before deployment, additionally validate Windows-to-macOS real native and external
Harness reads, pagination, active-turn observation, disconnected/old Hosts,
shared owner routing and post-restart behavior. Unit tests are not evidence of
an installed runtime handoff.
