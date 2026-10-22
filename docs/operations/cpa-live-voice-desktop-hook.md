# CPA live-voice Desktop hook

CodexHost routes native live-voice call creation through the configured realtime gateway without rewriting `app.asar` or replacing `/Applications/ChatGPT.app`. Desktop **26.1007.30912** uses a call-ownership gate override. Desktop **26.1013.40934**, **26.1016.51333**, and **26.1016.61520** use the native client-owned-call flow described below.

For upstream merges, follow the [Live Voice preservation checklist](fork-versioning.md#preserve-live-voice-when-syncing-upstream), including regression checks and separate Desktop-version qualification.

## Default

Desktop and the console expose the same **Voice** page using the existing settings components. Voice is separate from General/Appearance. Choose **Chat → Voice experience → ChatGPT or Codex**, then **Codex connection → Desktop default or Configured gateway** when Codex is selected. **Work → Voice connection** independently chooses Desktop default or gateway for Codex Work. External Harness voice remains Host → configured gateway, including when Codex Work selects Desktop default.

The local console owns `~/.codexhost/live-voice-inject-v1.json`: version 1 retains `inject` and optionally stores `routes` with `chatExperience`, `chatConnection` and `workConnection`. Desktop reaches this service through the local Host's bounded `codexhost/voice/settings` bridge; it does not open a browser or use cross-origin browser requests. Desktop legacy preferences migrate once, only while shared routes are absent. A console edit takes precedence over later migration. Atomic publication preserves the existing Controller reader. Revision checks reject stale edits from another window.

ChatGPT is the default Chat experience; its native START and Instant Connect prewarm remain owned by Desktop's browser-voice stack. Codex/Desktop default restores the original Codex voice entry and passes `/wham` through. Codex/gateway forwards call creation through Host. Explicit Chat launch ownership takes precedence over remembered Work/Harness selection. Work defaults to gateway; saved choices are preserved.

Edits are drafts until **Apply changes**. **Cancel** restores the loaded snapshot. Desktop polls shared choices every two seconds and acknowledges its applied revision; the page reports pending or unknown activation until that acknowledgment. A validated browser cache restores the last applied route before the first Host poll on a new document. Route changes are deferred during a detected active call, and fresh Desktop call reports block setting writes and Voice-page restarts. Runtime reports expire after 12 seconds; an absent report is unknown, not evidence that no call exists.

**Advanced → Enable voice integration** defaults on. Changing injection uses **Apply and restart codexhost**, with explicit task/call interruption confirmation. Environment `CODEXHOST_CPA_LIVE_VOICE=0|1` controls injection for that launch and locks its saved toggle. The Controller's loaded flag is compared with the desired effective setting; saving and restart completion alone never claim configuration activation. Restart failures retain the saved configuration and permit retry. The normal launch action attaches to an already running Desktop.

Gateway configuration details are collapsed under **Configuration → Gateway → Configure**. This reveals setup guidance, not a credential editor. The readiness check returns only a boolean from the Host; it does not probe a live call or expose provider credentials. Narrow console layouts use a compact expandable navigation menu and stacked preference controls without a horizontal navigation scrollbar.

The 26.1013 Work/Chat routing choices apply on the next call. The injection setting and process environment require restart. Host call creation rereads the selected provider and realtime URLs from `CODEX_HOME/config.toml`; Desktop-owned config consumers can require restart. End an existing call before changing its gateway configuration so cleanup uses the correct gateway.

**Desktop default** leaves Renderer call creation on Desktop's service; it does
not clear the native backend's `experimental_realtime_*` URL overrides. If those
still point at a gateway, native Work can create its call on Desktop and then
attempt to attach through the gateway, producing a WebSocket 404. With gateway
URLs configured, select **Configured gateway** for Codex Work to align creation
and attachment. Returning to the official backend also requires restoring the
native realtime configuration and restarting. The Voice page reports three facts separately: **Gateway configuration** (parsed
credentials), **Preferences applied** (Desktop acknowledged the saved routes),
and **Desktop gateway voice integration** (the version-qualified gateway transport hook). The
**Configured** status checks configuration and credential presence only, not
call connectivity. An unsupported hook means this Desktop build is outside the
audited allowlist; it does not mean the gateway settings were lost.

Desktop **26.1016.51333** hides native Start voice when Statsig rollout
`3683713372` is on and `model_provider` is not `openai`. CodexHost leaves
`model_provider = "custom"` unchanged. Work + gateway (and owned `codexhost/`
Harness composers) project only that composer’s `voice.realtime` /
`voice.thread` subscriptions. ChatGPT Chat stays on native Chat voice, which is
unqualified on this build.

The unaudited-Desktop asset gate still fail-closes. `~/.codex/config.toml` realtime keys stay manual.

Daily CI (`npm run compat:daily`, `.github/workflows/compat-daily.yml`) compares the public Sparkle appcast to the Work/gateway and Chat voice pins. It does not download ChatGPT.app. A pin behind Sparkle latest opens or comments on a `compat-broken` issue on this repository.

First-start official-backend recovery is covered by `packages/host-runtime/test/native-account-host.test.ts` (failed first generation, delayed second generation, no `unhandledRejection`). Manual cold-start UAT: fully quit ChatGPT and CodexHost, start **CodexHost 0.13.3** from the menu bar, wait ~15s. Pass: no 无法载入组织设定, console 总览 stays 启动成功, Work + Grok still shows Start voice. Fail: org-settings dialog on first launch only, then OK after 重试 — that is the remaining Host-wait gap, not Chat voice.

The hook only changes Desktop call ownership. Point Codex at the realtime host in `~/.codex/config.toml` as well, then relaunch:

```toml
experimental_realtime_ws_base_url = "https://<realtime-host>/v1"
experimental_realtime_webrtc_call_base_url = "https://<realtime-host>/v1"
```

## Desktop 26.1016.51333: client-owned calls

This Desktop build always creates its WebRTC call in the Renderer before asking
app-server to attach with `transport: { type: "existingCall", callId }`. The old
Statsig gate is absent. The two `experimental_realtime_*_base_url` settings alone
therefore cannot route that initial frontend request.

On the exact audited `app-initial-c95ddb62696e.js` and
`app-shared-2eda13eb7044.js` assets (Desktop **26.1016.61520**), the hook wraps the loaded native WebFetch
singleton's `fetch` method only for `POST /wham/realtime/calls`. It forwards the
native SDP/session through `codexhost/realtime/call` on the local Host connection
when the matching route uses the gateway. Codex Work honors **Work → Voice connection**; external Harness calls always use Host. **Chat → Codex → Configured gateway** uses the same Host path. **Chat → Codex → Desktop default** leaves `/wham` untouched. **Chat → ChatGPT** invokes native browser voice separately and leaves `/wham` untouched. Other WebFetch requests
pass through with their original receiver and
arguments.
External Harness ownership also comes from an explicit `codexhost/` backend
model in native request metadata, so a cold avatar overlay does not depend on
the main composer's routing state or remembered launch. Explicit Chat ownership
still takes precedence. Safe bootstrap diagnostics report the selected
`desktop` or `gateway` route without model names, identifiers or credentials.
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
Settings preference for the request's mode is checked again at call time.

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

### Work voice capability on 26.1016.61520

The audited native capability family requires first-party inference for `voice.realtime` and `voice.thread` when rollout `3683713372` is enabled. A custom provider can therefore hide Start voice even when gateway transport is ready.

`renderer-voice-capability.ts` projects only the owning visible local Work composer's subscriptions to those two capabilities. It requires the exact 26.1016 initial/shared assets, active client-owned and external-launch hooks, enabled injection, a successful live Host gateway-readiness check, and the Work gateway choice or an explicitly owned local external Harness selection. ChatGPT composers, remote Hosts and other capabilities retain native eligibility. Hidden composer roots do not make the visible composer ambiguous; multiple visible roots fail closed.

Runtime settings reports return `gatewayReady: null` because the console skips its callback to the requesting Host. The Renderer reads the existing local `codexhost/voice/gateway-status` method directly when readiness is omitted. Transient settings or status request failures retain the last successful readiness; an explicit negative result or disposal revokes it. No successful readiness read means the projection stays pending.

The projection replays the native readonly capability dependencies with the first-party inference restriction omitted only for that evaluation. It retains loading/error, access-policy, rollout and config-feature checks. It does not change the provider name, native capability atoms or global Statsig results. Family cache-key, scope-chain, signal and committed subscription ownership must all agree; absent, ambiguous or changed bindings fail closed. Changing scope, routes, readiness or injection restores native subscription getters.

A controlled live Renderer trial on 26.1016 showed Start voice changing from absent to one visible enabled button in an existing external Harness Work composer. Native capability values and the inference rollout remained unchanged. Disposing the projection restored native visibility. No call, microphone capture, audio connection or remote cleanup was tested.

### Work gateway call-start capability on 26.1016.61520

The composer and the persistent avatar overlay have separate capability readers.
The overlay's native starter reads `voice.realtime` again and emits
`Voice chat is not ready (voice_disabled)` when that reader is false. This check
precedes microphone setup, workspace readiness, call creation and app-server
attachment. Showing the composer button alone does not qualify call startup.

`renderer-voice-start-capability.ts` wraps the overlay's native
`registerRealtimeStarter` callback through the service reference. It accepts
explicit local Work composer starts using the Work gateway preference, or a
new-thread request carrying an explicit `codexhost/` model. It requires active
gateway transport, a successful local Host readiness read, and the exact initial,
shared and `avatar-overlay-native-page-fcc17283519a.js` assets. Within the exported
native overlay page, exactly one owned `voice.realtime` subscription can qualify.
The hook waits for React's committed capability snapshot before invoking the
native starter. Cancellation, failed startup, completed startup, unregistration
and disposal release the projection. Native access policy, treatment, workspace,
media and busy checks remain authoritative. ChatGPT Chat, remote Hosts, global
hotkeys and unowned starts retain native eligibility.

The overlay hook-only bundle must be updated alongside the primary Renderer.
An already-running Controller can retain its previously loaded bundle; staging
the installed file does not change that in-memory source. A controlled reload of
an idle voice overlay can qualify the new document without restarting Desktop or
reloading the primary window. The Controller's Zod `jitless` bootstrap must run
before evaluating the bundle under Desktop's Content Security Policy.

A controlled native Work/Harness trial on 26.1016 returned gateway HTTP 201,
applied the SDP answer, attached app-server with `transport: existingCall`, and
reported connected while `model_provider = "custom"`. Silent generated audio
replaced physical microphone input for the trial. Native stop restored an idle
overlay, native capability false and the unchanged inference rollout. Physical
microphone capture and spoken conversation quality remain separately untested.

cc-switch can deliberately use `model_provider = "custom"` to unify official and
third-party resume history. Its local provider writer preserves ChatGPT login
separately and can publish provider-scoped gateway credentials. CodexHost reads
that configuration without renaming the provider or modifying history. The
`voice_disabled` rejection is Desktop's capability restriction; it is not an
upstream gateway response or a session-history parsing error.

### Existing and new ChatGPT conversations: native Instant Connect

The primary Renderer installs `renderer-native-chat-voice.ts` only for the exact
26.1013.40934 Chat assets. Desktop **26.1016.61520** leaves native Chat voice
unsupported: individual-file inspection identifies composer start `start-voice-94a5b9fbf613.js` (`n`/`t`), the separate starter-prompt action `start-voice-de4c62bad45d.js`, and the `voice-prewarm-c95ccb6d68c5.js` entry over `voice-prewarm-2a13ee90e72c.js`. The old AppScope, backend-conversation, store, selection and lifecycle export mapping does not carry over, and the current prewarm also imports `app-primary`. That full ownership mapping and a live Chat composer have not been qualified, so changing filenames alone cannot enable native Chat safely. On 26.1013, it identifies the visible `data-chatgpt-composer`
through the committed React owner and its native AppScope. The owner must be a
non-temporary Chat conversation that permits external egress. Its composer
selection context must match. For a saved conversation, the native `pZn` selector
must resolve a backend ChatGPT conversation UUID. A new Chat can instead have a
native `local-chatgpt:` draft locator and no backend UUID. Its ComposerScope must
be a native new-Chat scope whose `lXt` draft selector matches the owner's locator.
A Desktop locator or `Thread-Id` is never used as a backend UUID. Missing or
ambiguous ownership leaves Start Voice unavailable.

While that Chat is selected and the Chat gateway override is off, the hook enables
Desktop's native browser-voice runtime (`Aw`) and mounts the native
`VoiceInstantConnectCacheController` under the native AppScope and ComposerScope
contexts. Both providers are required: prewarm reads the selected conversation from
ComposerScope. It preserves one controller across Chat selections and updates the
ComposerScope provider when its native chain changes. The new-Chat scope is passed
through unchanged; native eligibility decides whether that draft can prewarm.
Native eligibility, cache keys,
cancellation and reuse decide prewarming; the hook never creates a WM call on
selection itself. Leaving Chat after the call ends unmounts the controller and
restores the prior browser-voice flag. Startup and an active call retain their
runtime when the native voice UI hides the composer.

A separate **Start Voice** waveform button beside **Dictate** invokes the native
`start-voice` action (`Xe`, exported as `n` by the audited start-voice chunk).
While that control is installed, the eligible Chat composer's Codex **Start voice
chat** / **Start new voice chat** entry is hidden. Those entries initialize Codex
onboarding and optimistic launch state before the service RPC; forwarding that RPC
alone does not remove the competing screen. Leaving Chat, disposing the hook, or
enabling the Chat gateway override restores the entry's original inline display.
The action validates navigation and session state, reads `conversation_id` from
Chat's store, and dispatches `START`. Native `VoiceRoom`, WebRTC data-channel
configuration, WM event handling, microphone controls and End Voice remain in
Desktop's browser-voice lifecycle. Chat service launches are intercepted at
`realtimeVoiceRuntime.requestRealtimeStart` before the Codex overlay can create a
new Thread; a failed Chat binding or START does not fall back to that overlay.
The explicit Chat gateway override keeps the existing gateway launch path.
For a new Chat, START receives the native draft props with an absent backend
conversation ID; native voice owns creating and attaching the Chat conversation.
Existing Chats remain selected. For a new Chat, the hook selects its native draft
page once the active session has started, the Chat store has adopted the draft's
backend ID, and the transcript's current message exists. Desktop resolves the
draft alias and owns the canonical redirect. An early server ID alone never
triggers navigation. Selection is attempted once and cancelled if the user leaves
the starting page, the voice session ends or changes, or the binding is released.
The same AppScope runtime and prewarm root survive the hidden composer and native
page transition. Missing selection exports leave voice available with manual
transcript selection from Recents.

The hook does not build WM multipart requests, convert Thread IDs, suppress
`thread/realtime/start`, or copy browser cookies. Work and external Harness voice
continue through their existing overlay and Host → CPA gateway path.
The client-owned gateway hook initializes the shared chunk's native WebFetch
exports (`Oit` on 26.1016.51333) before reading its singleton classes. These exports are lazy at
document start, so loading the chunk alone does not establish gateway readiness.

Debug events use `__codexhostChatVoiceDebug` and the bounded localStorage key
`codexhost.chat-voice-debug.v1`. They contain event names, timestamps and routing
booleans, with no conversation IDs, SDP, credentials or raw errors. Native store
subscriptions additionally record active/connected/session-started and
server-conversation-ready flags, an allowlisted connection state, and the
allowlisted microphone request state. A
START return is a command acknowledgment, not evidence of a connected call.
These subscriptions are removed with the AppScope binding.

The production Renderer entry installs this hook on every document. Its polling
rebinds after leaving Chat, returning, or native composer replacement; no manual
session activation is required. The installed codexhost Renderer must contain the
change for it to survive a Desktop restart. A live CDP injection alone does not
update the installed release, and a subsequent codexhost update replaces a local
installation patch.

Attended verification uses both an existing web-backed Chat and a new Chat draft:
click **Start Voice**,
confirm the conversation remains selected, the native state reports `wm` and
`connected`, and **End Voice** is present. Confirm speech and microphone release
separately. Leave and return to each Chat, then reload Desktop and confirm the
waveform control returns. Then verify Work/Grok voice still reaches the configured
CPA gateway.

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

The legacy gate override reads the Work gateway preference at install time. Per-request routing and the separate Chat gateway switch apply to the 26.1013 client-owned fetch wrap.

## How it is installed

1. When the saved injection setting is on (unless overridden by `CODEXHOST_CPA_LIVE_VOICE=0|1`), the Controller prefixes the production Renderer source with a frozen `globalThis.__codexhostCpaLiveVoiceHookV1` record (audited Desktop version and `app-initial` asset name only).
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

Audited for Desktop **26.1007.30912** (gate path, primary bundle `app-initial-6350d04672d0.js`), **26.1013.40934** (client-owned path), **26.1016.51333**, and **26.1016.61520** (client-owned WebFetch wrap on `app-initial-c95ddb62696e.js` / `app-shared-2eda13eb7044.js`). Native Chat voice remains 26.1013-only. Re-audit before enabling on another build. Fail closed: no wrap, no ASAR patch, keep `~/Applications/ChatGPT-Voice.app` if that copy is still the working path.

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
`app-shared-2eda13eb7044.js` (26.1016.61520, export `ist`) and wraps only its native
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

V3 handoff text and user `turn.done` transcripts go to that same external Thread.
An open call also follows ordinary text or attachment tasks in that Thread,
including a task already running when the call opens. Completed agent progress
messages are forwarded during work: explicit `commentary` is eligible at Item
completion; an unphased message is eligible after a later Item starts, proving
that it is not the inferred final answer. The final result waits for successful
Turn completion. Partial messages, private reasoning and tool output are excluded.
Delegation IDs are deduplicated within a call and used only
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

Context forwarding confirms delivery to the voice control connection. Exact
audible progress and completion still require an attended Desktop call test.

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

### Automated smoke and attended verification

From the repository root, run:

```sh
npm run test:voice:smoke
```

This builds the TypeScript packages and packaged Harness plugins, then runs the
focused voice regression files using `tests/vitest.config.js`. It does not launch,
reload or stop Desktop, create a real call, or require gateway credentials. It
covers:

- Completed public progress, streamed final text, successful Turn completion,
  and exclusion of private reasoning and tool output.
- Ordinary text/attachment tasks during an open call, tasks already running
  when voice opens, and output held until the control connection is ready.
- Linked handoff deduplication, history seeding, gateway routing and cleanup,
  and suppression of late speech after hangup without cancelling Harness work.
- Claude native completed scout results containing quoted background-launch
  wording, while preserving genuine asynchronous scout launches.
- Overlay delivery after hangup, new-chat Harness selection, audited call hooks,
  preference gating, and CSP-compatible validation setup.

These files also run in the normal TypeScript CI suite; the named command is a
local focused entry point. Use it instead of `npm test -- <files>`: the root
`test` script invokes the broader TypeScript and Rust suites.

For attended verification, use the existing configured Desktop installation;
no separate voice hook, mock process or worktree is required:

1. Open an external Harness Thread and start voice. Keep the call open through
   task completion.
2. Submit a normal text task while the call is open, asking for a short read-only
   inspection, one separate public progress message before tool work, and a brief
   final summary. This exercises ordinary-turn forwarding. A task spoken into
   voice exercises the delegation path instead.
3. Verify progress only if the Harness actually emits a separate public message.
   A progress heading inside the final answer is one final message and does not
   verify intermediate speech. Private reasoning and command output are excluded.
4. Check that the final answer is heard before hangup, the backend Turn completes,
   and Desktop returns to idle. Native voice-work presentation can suppress the
   backend assistant text in favor of voice transcripts; hidden text alone does
   not establish a broken event stream.
5. If the UI appears stuck, preserve the call and inspect the backend Turn and
   Desktop state before restarting or reloading. An active command is expected
   to remain busy. Judge a stale busy state after the final backend reply.

The attended Claude Code check on Desktop **26.1013.40934** on 19 October 2026
confirmed an audible final answer, completed Turn and idle Desktop. That run
emitted no separate public progress message, so intermediate audio remains
unverified. Automated transport assertions do not establish physical playback,
universal Model compatibility or recovery from every long-task failure.

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
