## Context

The first DeepSeek fast path copied the official JSON-RPC demo composition into codexhost, disabled most tools and Skills, and redirected persistence to `.codexhost/deepseek-harness-sessions`. That proved event projection but created a second DSH deployment with different behavior and invisible Sessions.

DSH `0.1.0-rc.6` Web exposes an official typed loopback API with `session.create`, `session.history`, `session.models`, `session.prompt`, `session.cancel`, `session.fork`, HTTP upstream calls, and WebSocket mux/host event streams. Its Web profile owns the complete local Cordis composition and official `$DSH_HOME` stores. The protocol currently has no independent version-negotiation field and documents that client and Host ship together.

## Goals / Non-Goals

**Goals:**

- Treat the user's local DSH Web profile as the source of truth for runtime composition and Native Sessions.
- Make codexhost-created Sessions visible and resumable in official DSH Web while keeping pre-existing DSH Sessions out of codexhost.
- Connect to an existing loopback Host or start the configured local Web profile without routine manual setup.
- Preserve the existing `HarnessAdapter` boundary and normalized text, Reasoning, Tool, Diff, Usage, cancellation, and fault behavior.
- Add history-backed resume so mapped codexhost Threads survive application restart.

**Non-Goals:**

- Importing or listing Sessions that are not present in codexhost Mapping Store.
- Parsing DSH JSONL or copying Native transcripts into a second store.
- Managing DSH profile plugins, Skills, settings, credentials, presets, or permission policy from codexhost.
- Supporting arbitrary remote/non-loopback DSH Hosts in this change.
- Claiming approval, question, permission switching, slash-command UI, or Fork until each is projected through existing Harness contracts.

## Decisions

1. **Use the official Web Host API as the native transport.** The Adapter talks to the loopback Host through its public HTTP upstream and WebSocket mux stream. This preserves the exact active profile and avoids a codexhost transport overlay changing composition. Starting one JSON-RPC process per Thread was rejected because it creates separate live registries and cannot share official Web interactions reliably.

2. **Share one Host connection across Adapter Sessions.** A connection manager owns Host discovery, optional managed process startup, and one mux subscription. It dispatches only frames whose Session ID belongs to a loaded codexhost `HarnessSession`. Closing a Thread detaches that consumer but never deletes the Native Session. Closing an externally started Host is forbidden; Adapter close terminates only a process it started. For this MVP, a lost event connection faults loaded Sessions; a later open can attach again through public history.

3. **Prefer an existing Host, then start local DSH on demand.** The default endpoint is `http://127.0.0.1:3080`, configurable by environment. If `host.describe` fails, the manager resolves the explicitly configured local DSH command or installed `dsh` executable, starts the `web` profile on that endpoint, and waits with a bound. It does not use an unpinned network download as silent fallback. A port occupied by a non-DSH server fails explicitly.

4. **Pin the client protocol family.** Official DSH client/API packages remain exact `0.1.0-rc.6` dependencies. Transport envelopes and payloads are parsed with official schemas. A malformed or incompatible Host is unavailable/protocol-faulted rather than heuristically accepted.

5. **Official Native Session identity drives persistence.** Create calls `session.create` with cwd and optional selected model, then publishes the returned Session ID in `NativeSessionRef`. Resume validates the mapped ID through `session.history`; it does not scan `session.list`. Mapping Store remains the only source for which Native Sessions become codexhost Threads, producing one-way visibility naturally.

6. **History is authoritative on attach.** `session.history` pages the public event API and projects the full transcript when a mapped Session is opened or resumed. The live mux starts before prompt admission. DSH private JSONL is never opened. Online reconnect and missed-event reconciliation are deferred beyond this MVP.

7. **Keep capability claims narrower than the Host API.** This migration enables resume/history and preserves create-time model selection. Approval/question frames initially fail the active Turn explicitly unless the corresponding Adapter projection is implemented in this change; they must never remain pending invisibly. Permission selection, Fork, rollback, and slash commands stay unsupported even though native endpoints exist.

8. **Remove replaced runtime ownership.** Delete `runtime/cordis.yml`, `runtime/server.mjs`, newline JSON-RPC transport, private Session root options, and runtime bundle audit entries. Retain and adapt stateless event projection code and Host/Renderer routing already aligned with the Adapter abstraction.

## Risks / Trade-offs

- [The DSH Web protocol has no negotiated version] -> Exact-pin rc.6 client contracts, validate every envelope, and fail clearly on incompatibility.
- [Port 3080 may be occupied] -> Probe `host.describe`; never kill or reuse an unidentified listener; support an explicit endpoint/port.
- [A user closes an externally owned DSH Host] -> Active Sessions fault explicitly; mapped Sessions remain resumable after the Host is available again.
- [Managed Host startup may outlive one Thread] -> Own it at Adapter scope, stop only on Adapter shutdown, and never stop a pre-existing process.
- [Full profile exposes interactive tools] -> Project supported interactions or fail active work explicitly; do not auto-approve or pretend completion.

## Migration Plan

1. Add Host API transport and lifecycle manager behind focused tests.
2. Rewire create/resume/history/live turns and model inspection to the Host API.
3. Remove the private runtime and dependencies once real Host create/prompt/history passes.
4. Restart Desktop, create a codexhost DSH Thread, and verify its Session ID appears in official `session.list` while an old official Session remains absent from codexhost ownership.
5. Rollback restores the prior Adapter package and private runtime; official Sessions created during the new path remain valid DSH Sessions and are not deleted.
