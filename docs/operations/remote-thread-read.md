# Read, continue and manage Threads on another Host

## Portable links and bidirectional access

In a connected Desktop, right-click a sidebar Thread and choose **复制 → 复制深度链接**
(**Copy → Copy deeplink**). The native menu keeps its original label; codexhost
qualifies the clipboard text for the selected sidebar Thread. The copied reference includes a stable Host
installation identity as well as the Desktop connection hint:

```text
thread://THREAD_ID?hostId=local&machineId=12345678-1234-4123-8123-123456789abc
```

Give the complete link to a session on either machine, or read it through the CLI:

```sh
codexhost thread read 'thread://THREAD_ID?hostId=local&machineId=12345678-1234-4123-8123-123456789abc' --view messages --limit 25
```

`machineId` identifies the owning Host; `hostId` is only a connection hint when a
machine identity is present. A Linux session can therefore access a local-machine
link even though its hint says `local`. On the owning machine the Runtime reads
locally. Otherwise an attached Desktop relays the read through its existing
Host clients. Both Host runtimes and the Desktop extension must support this
feature. The Desktop must remain open and connected to both machines; links
do not create connections. The bridge refreshes its routes every 15 seconds and
expires a window's advertisement after 45 seconds without a refresh.

The identity is stored in `~/.codexhost/host-id`, or `CODEXHOST_DATA_DIR/host-id`.
It survives restarts, SSH alias changes and IP changes. Do not copy this file
to another machine. Links contain neither credentials nor a network endpoint;
no public port or reverse SSH tunnel is required. Read replies retain the machine
identity and pagination cursor. Unknown, disconnected or replaced connections
fail without reading a local Thread that happens to have the same ID.

Inside the Desktop renderer, clicking a machine-qualified link resolves its
current connection and opens the matching sidebar row. The Thread must be
present in the sidebar for this navigation; CLI reads can access older history.
System-wide URL handling remains owned by Codex Desktop. A link identifies a
Thread; instructions to read it do not authorize sending messages to it.

Native Codex shell commands must inherit `CODEXHOST_RUNTIME_ENDPOINT` and
`CODEXHOST_RUNTIME_TOKEN`, plus `CODEXHOST_CLI_PATH` and `CODEXHOST_CLI_NODE_PATH`
for the installed CLI. A `shell_environment_policy` using `inherit = "core"`,
an allowlist without these names, or automatic token exclusion can remove them.
The CLI then reports `RUNTIME_UNREACHABLE` before attempting cross-machine routing.
Configure the calling machine's shell environment policy to preserve these
Host-provided variables and reload the session. Keep credential values in the
process environment; do not paste them into links, prompts, or configuration.
The calling session must also permit loopback network access to its Runtime.
Inheriting environment variables does not enable network access in a read-only
or otherwise network-restricted sandbox.

The bridge permits only fixed, Host-local read and send operations. A response
must come back through the connection and window that accepted the request.
Multiple Desktop windows may attach without replacing each other's requests.
Reads have a 35-second renderer deadline and 40-second Host deadline, at most
64 pending requests per Runtime, and a 16 MiB serialized reply limit. They are
not retried automatically.

## Send a message or continue a task

Use the same copied link on either machine:

```sh
codexhost thread send 'thread://THREAD_ID?hostId=local&machineId=12345678-1234-4123-8123-123456789abc' --message 'Continue the task and verify the result'
```

The destination uses the existing native Codex or external Harness send path.
An idle Thread starts its next Turn. An active Thread returns `THREAD_BUSY`;
messages are not queued and an existing Turn is not interrupted. Native session
configuration and approval requirements remain in effect. Shared external
Threads dispatch through their shared owner. Older Hosts without send support
are not advertised as send destinations.
Native Codex resolves settings when the Thread is resumed by its app-server;
one-off flags from a standalone CLI invocation need not carry over. Set the
Thread's network permission through native Thread settings before asking it to
call another Host. Cross-machine sends do not enable network access themselves.
The CLI uses dedicated Runtime routes for machine-qualified reads and receipt-based
sends, so a still-running older Runtime rejects them instead of treating them as local.

The result contains `requestId`, `turnId`, machine identity and a machine-qualified
read command. Success confirms submission, not task completion. Read the complete
link again to check progress. Cross-machine cancel, wait and watch are unavailable.
Host-only legacy links cannot send remotely; copy a new machine-qualified link.

Each cross-machine send has a UUID request ID, generated by the CLI unless supplied
with `--request-id`. The destination reserves that ID on disk before invoking the
Harness and records the receipt in `~/.codexhost/thread-send-receipts/` (under
`CODEXHOST_DATA_DIR` when set). Repeating the same ID, machine, Thread and message
returns the recorded receipt without starting another Turn, including after a
Runtime restart. Reusing an ID for different input is rejected. Receipts contain
an input fingerprint and outcome, not the message body; they are retained to keep
old retries from re-executing.

If a connection breaks after dispatch, the result is `OUTCOME_UNKNOWN` with the
request ID. Read the target or repeat the **same** link, message and request ID to
recover its receipt. Do not blindly generate another ID. An interrupted Runtime
may leave an incomplete receipt: repeating it returns `OUTCOME_UNKNOWN` and does
not invoke the Harness again. Inspect the Thread before deciding whether a new
request is needed. This reservation protocol avoids automatic replay; it cannot
atomically commit a filesystem receipt together with a native Harness operation.

Messages sent from a Thread automatically include a `codexhost sender` header:
the source Runtime's `machineId`, the calling `threadId`, and a machine-qualified
`replyTo` link. The CLI identifies its caller from `CODEXHOST_THREAD_ID` (external
Harness) or `CODEX_THREAD_ID` (native Codex). The recipient can send a requested
reply with `codexhost thread send 'REPLY_TO_LINK' --message 'RESULT'`. This is
routing context, not an authentication claim or an instruction to automatically
acknowledge every message. Calls outside a Thread do not invent a sender. The
sender header is part of the durable send receipt's payload, so a retry must
come from the same calling Thread.

## Create and manage Threads

Use a link from the destination machine to create an independent Thread there.
The existing Thread only identifies the destination; it is not modified or used
as a parent. The working directory must be absolute and exist on the destination:

```sh
codexhost thread create --on 'thread://EXISTING_ID?hostId=local&machineId=MACHINE_UUID' --cwd /absolute/target/workspace
```

Alternatively select the destination with `--machine MACHINE_UUID`. Omitting
both selectors creates on the calling machine. `--harness` defaults to `codex`;
installed external Harnesses use their existing Desktop creation path. Creation
returns an idle Thread and a machine-qualified `thread` link. Use `thread send`
with that link to submit its first task. Native creation defaults apply; the Host
does not raise permissions or start an implicit Turn.
Native Threads use the `legacy` history contract consumed by Host read/send.
An empty native Thread may not survive a Runtime restart before its first Turn;
submit the first task before restarting. A recovered creation receipt identifies
the original Thread and never recreates a lost empty Thread.

Use the returned link for the remaining lifecycle operations:

```sh
codexhost thread rename 'THREAD_LINK' --name 'New name'
codexhost thread archive 'THREAD_LINK'
codexhost thread unarchive 'THREAD_LINK'
codexhost thread delete 'THREAD_LINK' --confirm permanent
```

Archive is reversible. Delete is permanent and requires explicit user intent;
the CLI requires `--confirm permanent`. All operations reuse the target Host's
Desktop handlers, including external Thread ownership, native errors and
notifications. Unknown methods and extra parameters cannot be forwarded.

Every operation returns `requestId`. Repeating the identical command with
`--request-id` recovers the original receipt, including its created Thread ID,
without creating another Thread or repeating a deletion. Changed arguments with
the same ID are rejected. Lost replies and incomplete receipts return
`OUTCOME_UNKNOWN`; do not retry with a fresh ID. Creating and sending are separate
operations, so a failed first message never repeats creation. Both Hosts and the
Desktop extension must advertise management support; older or disconnected
destinations fail without a local fallback.

## Legacy Desktop connection links

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
commands without caller context use the bare Thread ID or `--host local` on the
owning machine. Foreign reads still require a Desktop connection and never fall
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
Legacy Host-only links support reads; sends require the machine-qualified links above.

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

Source regression tests cover stable identity publication, CLI link preservation,
both directions through a renderer/Runtime bridge, read pagination, send receipts,
deduplication across restarts, busy Threads, connection expiry and replacement,
no local fallback, strict operation validation and renderer Host selection.
Browser fixtures cover the sidebar copy action and link navigation.
Live CLI validation must run from ordinary session shell tools with their inherited
environment; manually supplying Runtime credentials does not verify that path.
Before deployment, additionally validate local-to-Linux native and external
Harness reads and sends, pagination, active-turn observation, disconnected/old
Hosts, shared owner routing and post-restart behavior. Unit tests are not evidence of
an installed runtime handoff.
