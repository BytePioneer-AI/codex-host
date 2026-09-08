# Kiro CLI Adapter

This plugin connects to Kiro CLI's native ACP v3 engine. Protocol handling,
configuration confirmation and native interaction responses stay inside the Adapter.

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
