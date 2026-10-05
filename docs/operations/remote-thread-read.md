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

## Validation boundary

Source regression tests cover CLI Host preservation, explicit remote routing,
no local fallback, strict operation validation and renderer Host selection.
Before deployment, additionally validate Windows-to-macOS real native and external
Harness reads, pagination, active-turn observation, disconnected/old Hosts,
shared owner routing and post-restart behavior. Unit tests are not evidence of
an installed runtime handoff.
