# CPA live-voice Desktop hook

CodexHost routes native live-voice call creation through the configured realtime gateway without rewriting `app.asar` or replacing `/Applications/ChatGPT.app`. Desktop **26.1007.30912** uses a call-ownership gate override. Desktop **26.1013.40934** uses the native client-owned-call flow described below.

## Default

**On** in this fork. The Desktop Controller injects the hook unless `CODEXHOST_CPA_LIVE_VOICE=0`. That environment variable is **not live**: changing it requires relaunching Codex. Codex Settings → General has an **Override live voice** switch, also on by default (`localStorage` missing means on; `"0"` means off). The switch applies on the next voice overlay without relaunch. If the hook was not injected (`CODEXHOST_CPA_LIVE_VOICE=0`), the page shows a restart warning and the switch cannot take effect until relaunch. The unaudited-Desktop asset gate still fail-closes. The Web console does not duplicate this switch.

The hook only changes Desktop call ownership. Point Codex at the realtime host in `~/.codex/config.toml` as well, then relaunch:

```toml
experimental_realtime_ws_base_url = "https://<realtime-host>/v1"
experimental_realtime_webrtc_call_base_url = "https://<realtime-host>/v1"
```

## Desktop 26.1013.40934: client-owned calls

This Desktop build always creates its WebRTC call in the Renderer before asking
app-server to attach with `transport: { type: "existingCall", callId }`. The old
Statsig gate is absent. The two `experimental_realtime_*_base_url` settings alone
therefore cannot route that initial frontend request.

On the exact audited `app-initial-90eb42395b7d.js` and
`app-shared-52443cbe9ac4.js` assets, the hook wraps the loaded native WebFetch
singleton's `fetch` method only for `POST /wham/realtime/calls`. It forwards the
native SDP/session through `codexhost/realtime/call` on the local Host connection.
Other WebFetch requests pass through with their original receiver and arguments.
No global fetch, message transport or application archive is replaced.

The Host reads the configured realtime URLs and selected provider's
`experimental_bearer_token` or `env_key`. Both URLs must use HTTPS and share an
origin. Header forwarding is allowlisted twice: the Renderer bridge drops every
name outside `REALTIME_CALL_FORWARDED_HEADERS` before the request crosses to the
Host, and the Host applies the same list again before sending. Desktop OAuth,
`ChatGPT-Account-Id`, `Cookie` and every other unlisted header are therefore
excluded at both boundaries. Credentials stay in the Host; only the SDP response,
status and allowed response headers return to the Renderer. Configuration and
transport failures do not fall back to the signed-in ChatGPT account. The
Settings preference is checked again at call time.

Cancellation aborts an in-flight bootstrap. A known created call is hung up if
startup fails or its answer arrives after cancellation. If no call identity is
available, remote cleanup cannot be confirmed. Existing native app-server
sideband and stop requests continue through their configured gateway route.
External Harness Threads attach to the same existing call without a second
creation or SDP exchange, retaining the selected Harness for new-chat launches.

The native frontend exports used here are version-specific and must be re-audited
before another Desktop build is enabled. An enabled CPA scheduler only selects
accounts for requests that actually reach CPA. Its configured inventory and
selection counts do not establish successful upstream calls.

### Account failover: current limitation

Bounded quota failover is **not** implemented, because no public CPA plugin
contract can observe a pre-call quota result for this route. Evidence from the
deployed baseline:

- `internal/client/codex/live/live.go:223` selects once via `selectOAuth`, and
  `:330` sends that single selection once (`performRequest(selected)`). There is
  no retry loop, no `tried`-set and no second `SelectAuthByKind` call on this
  path.
- The plugin-facing scheduler contract is pick-only: `SchedulerPickRequest` /
  `SchedulerPickResponse` in `sdk/pluginapi/types.go:487-546` carry no outcome or
  result field, and the only scheduler ABI method is `scheduler.pick`
  (`sdk/pluginabi/types.go:55`). A scheduler plugin cannot learn that its pick
  returned `usage_limit_reached`.
- The result-feedback contracts that do exist — `RequestLifecyclePlugin`
  (`HandleRequestComplete`), `RequestInterceptor` and `ResponseInterceptor` —
  are emitted only by `BaseAPIHandler` execution paths
  (`sdk/api/handlers/handlers_execution.go`, `handlers_stream.go`,
  `handlers_interceptors.go:160-165`). The Codex live handler is a standalone
  `Handler` (`internal/client/codex/live/live.go:49`) that never participates in
  interception or lifecycle, so those callbacks never fire for `/v1/realtime/calls`.
- The `QuotaProvider` contract (`sdk/pluginapi/types.go:1577`) reports and resets
  quota for management clients; it is not wired into live selection and cannot
  skip an exhausted account before a call.
- Disabled-account exclusion is already enforced by core before any plugin sees a
  candidate: `sdk/cliproxy/auth/conductor_selection.go:1852` drops
  `candidate.Disabled`, and `availableAuthsForSelector` narrows the set the plugin
  receives. `cpa-live-voice` intersects that set with `live_auth_ids`
  (`selector.go` `PickAuth`), so the disabled Alice Plus credential cannot be
  selected — no plugin change is required for exclusion.

Consequently a retry that skips the exhausted account and re-selects a remaining
priority needs a new CPA core seam: the live handler must record the definitive
`usage_limit_reached` result and re-enter selection with that account excluded.
That is a core change, not a plugin change, and is out of scope here pending a
separate decision. The smallest core seam would be an exported
"exclude these auth IDs and select again" entry point plus a single bounded retry
in `Handle` after a definitive pre-call quota response.

## Desktop 26.1007.30912: call-ownership gate

Desktop’s voice-start path sets `clientOwnsCall` when the `hostId` argument is `durable` **or** both of these hold: the host's app-server version supports the `threadRealtimeExistingCall` capability (a version comparison, not a stored flag), and Statsig gate `206132468` passes. That second branch POSTs to ChatGPT `/wham/realtime/calls` and then starts `thread/realtime/start` as `ExistingCall`. CPA never sees creation, so the sideband websocket 404s.

The hook forces Statsig `checkGate("206132468")` to false on every client registered on `__STATSIG__`. In the audited build that gate has no other reader, so the result is durable-only ownership: a local host gets `clientOwnsCall=false` and `transport=webrtc`, and CPA can `POST /v1/realtime/calls`. Other gates pass through unchanged. Official app-server traffic is not rewritten. Host still passes official `thread/realtime/*` through.

## How it is installed

1. Unless `CODEXHOST_CPA_LIVE_VOICE=0`, the Controller prefixes the production Renderer source with a frozen `globalThis.__codexhostCpaLiveVoiceHookV1` record (audited Desktop version and `app-initial` asset name only).
2. `Page.addScriptToEvaluateOnNewDocument` plus immediate `Runtime.evaluate` inject the Host Renderer into the primary `app://-/index.html` page.
3. Voice starts on the avatar overlay (`app://-/index.html?initialRoute=/avatar-overlay`). That page gets a **hook-only** bundle (`cpa-live-voice-hook.js`), not the Host Renderer binding. The overlay loads the same audited `app-initial` asset in its own JavaScript realm with its own Statsig client. The overlay bundle also drops Host `thread/started` and turn/item notifications for Threads that have not hosted voice in that overlay, so a leftover overlay does not upsert CLI-created Threads or rebind the same Turn into the main chat. Known voice Threads keep receiving notifications after hangup because native stream ownership can outlive the call.
4. The Renderer hook no-ops unless the exact audited `app://-/assets/app-initial-6350d04672d0.js` asset is present (performance entries, script src, or link href, including relative URLs). Unknown assets fail closed; matching text in a query string or source-map filename is insufficient.
5. On a matching page it polls for up to 60 seconds until a Statsig client is registered, then wraps that client's `checkGate`. The gate is read when voice starts, so the wrap only has to land before the first voice click.

Verify before a trial: on the overlay, `__STATSIG__.firstInstance.checkGate("206132468")` returns `false`.

Overlay discovery, connection, and injection share one timeout. Overlay attempts run concurrently, and a stalled or disappearing overlay does not prevent the primary Host session from becoming ready after that deadline.

The Controller sets Zod's global `jitless` configuration before evaluating either
the primary Renderer or the overlay bundle. Response validation therefore runs
without JavaScript string compilation under Desktop's Content Security Policy,
including when the bundle was initially evaluated through the debugger. The
policy does not need `unsafe-eval`.

The hook does not copy OpenAI frontend JavaScript into git. Tests cover the asset gate and Statsig override with synthetic clients.

## Version gate

Audited for Desktop **26.1007.30912** (gate path, primary bundle `app-initial-6350d04672d0.js`) and **26.1013.40934** (client-owned path, assets listed above). Re-audit before enabling on another build. Fail closed: no wrap, no ASAR patch, keep `~/Applications/ChatGPT-Voice.app` if that copy is still the working path.

## Invariants

- Do not overwrite `/Applications/ChatGPT.app` (Developer ID `2DC432GLL2`).
- Do not reuse `install_voice_patch.py`.
- Do not quit or replace the working Voice copy until the CodexHost path proves `POST /v1/realtime/calls` 201.
- Do not put call IDs, SDP, or auth material in docs, git, or command output.
- Do not `git push` this branch or open an upstream PR unless explicitly requested.

## External Harness voice (local development build)

New-chat voice launches use the primary Composer's current Harness selection.
On the audited Desktop build, the primary Renderer imports the already-loaded
browser module `app-shared-8bd9d0399038.js` (26.1007, export `fN`) or
`app-shared-52443cbe9ac4.js` (26.1013, export `Kat`) and wraps only its native
`realtimeVoiceRuntime` service reference. Its RPC stubs themselves
are immutable. For `composer_button_new_thread`, the wrapper snapshots the
matching Host's selected transport carrier into
`activeCollaborationMode.settings.model`. The separate voice overlay forwards
that collaboration mode into native Thread creation, which uses its model for
`thread/start`. This prevents a new Grok voice chat from silently becoming an
official Codex chat. No browser message transport or ASAR code is patched.

The wrapper requires both exact audited frontend assets. It imports only after
they are present and waits up to 60 seconds for the native services record.
Existing-Thread launches, avatar/global launches, official Codex selection,
ambiguous Composers and mismatched/disconnected Host owners pass through.
Selection is captured before launch, so changing the draft later cannot retarget
an in-flight voice chat. This is generic to the selected Harness, not Grok-specific.
The new-chat correction has focused routing/forwarding tests; installed native
button acceptance is still required. Earlier installed acceptance exposed the
missing new-chat selection handoff despite successful isolated transport trials.

External `thread/start`, `thread/resume`, and `thread/fork` report
`sandbox: { type: "externalSandbox", networkAccess: "enabled" }`. Codex does not
enforce a sandbox on those Threads; Harness permission modes stay authoritative.
Native voice overlay startup also sends `thread/settings/update` with
`summary: "detailed"` when concurrent reasoning summaries are enabled. External
`thread/settings/update` returns an empty success without applying Codex
sandbox or permission changes; Harness permission modes stay authoritative.
Official Codex sandbox traffic is unchanged.

External Threads now have a separate Host-owned handler for native WebRTC audio
`thread/realtime/start` and `thread/realtime/stop`. Official Codex Threads continue
through the native app-server unchanged, including their existing gateway routing.
The handler uses the selected external Thread's existing HarnessSession and normal
Turn/approval projection; it does not start a second agent or import a concrete Adapter.

The transport targets CPA's frameless V3 client-delegation protocol. It posts the
Desktop SDP and client-delegation session to the configured realtime call base,
returns the answer through native `started`/`sdp` notifications, and joins the
configured WebSocket base at `/live/{callId}`. Reopened calls on an existing
External Thread include that Thread's user and agent messages as GPT-Live
`session.initial_items`, using the V3 role-bearing message format. A native
`delegation.created` with task text and `user_bidi_turn_id` starts Harness work
and binds its speakable handle (`item.id`) to that user turn. The service can
wait for the client answer before emitting user `turn.done`, so that final
transcript is not a prerequisite for a linked handoff. A completed user
`turn.done` starts work only if the same turn has not already been registered.
Matching uses protocol turn identifiers, including `turn_id` / `turnId`, not
text similarity or timing. A handle without a turn identifier is ignored for
routing. Both configured
bases must use HTTPS and share an origin. Authentication uses the
selected configured model provider's
`experimental_bearer_token` or `env_key`; OAuth from `auth.json` is never copied.
The Host reads `CODEX_HOME/config.toml` only and does not mutate gateway settings.
Profile/command-line credential overrides are not resolved by this prototype.

V3 handoff text and user `turn.done` transcripts go to that same external Thread. Only completed
agent-message results are returned as speakable context; private reasoning and tool
output are excluded. Delegation IDs are deduplicated within a call and used only
to address `delegation.context.append` when the handle names the user turn.
Results without a linked handle are appended with the supported
`session.context.append` event. A handoff with no task text or no turn identifier
does not start work and does not bind a later utterance. Partial `turn.created`
and `turn.delta` transcripts do not start work. Transcripts are
projected through native notifications. Closing the call releases voice resources
and suppresses late speech, but does not cancel a running agent task: explicit task
cancellation remains the existing `turn/interrupt` operation. The avatar overlay
keeps delivering known voice Threads' `turn/*` and `item/*` notifications after
hangup, including later text turns. The primary window may remain a native
stream follower of the overlay, so call closure or an idle status does not
release notification delivery. Deleting a Thread removes it from this set.
`turn/interrupt` for a Turn that is already complete, or that is not the active
Turn, returns success without cancelling a newer Turn.

The speech service is instructed to delegate every question and task, including
simple arithmetic; it supplies speech rather than owning task reasoning.
The prototype defaults to Cantonese and the protocol's `cove` voice; supported V3
voices can be requested. Text/audio append transports,
overlapping-task steering, newer public GPT-Live event dialects, remote-host media
topology, and seamless call recovery are not supported. A rejected control connection
or session-initialization timeout emits error/closed notifications and performs
bounded hangup cleanup. Retry is explicit and never resubmits an agent task.
If the gateway returns success without a usable call identity, the Host rejects
startup and releases the response body, but cannot identify a safe remote hangup
target. Remote cleanup is then unconfirmed. Network failures during hangup are
also reported as `cleanup_unconfirmed`; a closed local overlay is not proof of
remote cleanup.

Verification includes an isolated real native call through New API/CPA (creation,
WebRTC, data channel, session initialization, sideband, and hangup), a real Host
trial using the public Grok plugin and an existing microphone clip, and Host
fixtures for multiple Harness IDs and official passthrough. The Host trial
observed a completed Grok Turn and the returned spoken-answer transcript, with
no official app-server request; the final trial confirmed hangup with HTTP 404
(call already gone). One preceding trial returned the answer but did not confirm
hangup. These are isolated headless-page trials, not installed Desktop button
acceptance or proof that every plugin is voice-compatible. Continuous conversation,
speech interruption, task cancellation and approvals need attended acceptance.

## Harness session rules (Grok ACP `_meta.rules`)

The Grok Adapter passes Desktop session rules through Grok's official ACP
`session/new` and `session/load` `_meta.rules` field. Grok appends that text in
a `<human_rules>` block. Host Runtime does not write `~/.grok/rules/` or
`~/.claude/rules/`. On startup it removes Host-owned copies of
`codexhost-desktop.md` whose content still matches a previous managed digest;
a user-edited copy is preserved. TUI and Orca Grok sessions therefore stay
free of that file unless the user kept an edited copy.

Grok appends that text to `system_prompt.txt` inside `<human_rules>`. The
agent never prints tokens, endpoints, or runtime descriptors.

The rule covers composer Model selection (including that `flash-max` is Gemini
Flash), starting in the real repo, voice versus text tool work, per-Harness MCP
and skills, Codex Desktop chrome / Markdown View, and official Codex live voice
versus Host-owned external `thread/realtime/*`.
