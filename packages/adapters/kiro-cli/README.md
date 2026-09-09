# Kiro CLI Adapter

This plugin connects to Kiro CLI's native ACP v3 engine. Protocol handling,
configuration confirmation and native interaction responses stay inside the Adapter.

## Asynchronous Model confirmation

Kiro CLI 2.21.2 can finish loading a forked Session before its native Model
catalog refresh completes. A subsequent Model write may succeed while its RPC
response temporarily omits the `model` configuration option. This previously
made last-message edits fail after the native Fork had already succeeded.

The Transport subscribes before the write and, only when the Model option is
absent from an otherwise valid response, waits for a matching
`config_option_update` from the same Session within the existing configuration
request timeout. Notifications from earlier requests or other Sessions cannot
confirm the write. An explicit mismatched response or RPC rejection still fails;
the Adapter does not retry the write, substitute a default Model, or manufacture
confirmation. Closing the Transport cancels the wait. Keeping this wait inside
the existing configuration request lifecycle ensures timeout faulting and cleanup
remain the same as for the RPC itself.

`test/acp-effort.test.ts` covers rollback Model restoration with notifications on
either side of the RPC reply, live selection, missing/wrong-Session/mismatched
confirmation, close, and preservation of explicit rejection behavior. Native
verification on 2.21.2 reproduced the missing-option response and confirmed that
rollback retained exactly one fewer Turn after the fix; Desktop click-through
acceptance remains a separate check.

## Configuration failure and recovery

Model, Thinking and Permission Mode writes are effective only after native
confirmation. An explicit RPC rejection reports an operation failure without
closing an otherwise usable Session.

A configuration request timeout is different: the native write may already have
succeeded, and a local timeout does not undo it. The Adapter therefore faults the
Session and closes its transport, rejecting subsequent Turns and commands rather
than executing with stale Host configuration. The caller must reopen/resume the
Native Session to obtain confirmed configuration before continuing. A late reply
does not revive the closed Session or publish the requested value as confirmed.

## Concurrent interactions

ACP requests can arrive while earlier requests are awaiting a response. Each
Approval, user-input Question and requirements Question retains its own Host
Interaction ID and native response callback. Answers may arrive out of order;
invalid or duplicate responses do not consume another interaction. Cancellation,
Turn completion, Session fault and close resolve and close every pending
interaction before the Turn's terminal event.

## Regression coverage

`test/acp-session-lifecycle.test.ts` exercises the real ACP SDK, Transport and
Session over simulated process streams. It covers delayed configuration replies,
explicit rejections, overlapping native requests, out-of-order answers and
terminal cleanup. These are protocol-level regressions, not evidence that a
particular Kiro CLI version emits concurrent interactions in a live task, nor a
substitute for Desktop/native CLI acceptance testing.
