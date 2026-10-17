# CPA live-voice Desktop hook

Gated CodexHost Renderer hook that forces durable-only `clientOwnsCall` on official Codex Desktop **26.1007.30912**, so CPA can create the realtime call (`POST /v1/realtime/calls`) without rewriting `app.asar` or replacing `/Applications/ChatGPT.app`.

## Default

**On** in this fork. The Desktop Controller injects the hook unless `CODEXHOST_CPA_LIVE_VOICE=0`. That environment variable is **not live**: changing it requires relaunching Codex. Codex Settings → General has an **Override live voice** switch, also on by default (`localStorage` missing means on; `"0"` means off). The switch applies on the next voice overlay without relaunch. If the hook was not injected (`CODEXHOST_CPA_LIVE_VOICE=0`), the page shows a restart warning and the switch cannot take effect until relaunch. The unaudited-Desktop asset gate still fail-closes. The Web console does not duplicate this switch.

The hook only changes Desktop call ownership. Point Codex at the realtime host in `~/.codex/config.toml` as well, then relaunch:

```toml
experimental_realtime_ws_base_url = "https://<realtime-host>/v1"
experimental_realtime_webrtc_call_base_url = "https://<realtime-host>/v1"
```

## What it changes

Desktop’s voice-start path sets `clientOwnsCall` when the `hostId` argument is `durable` **or** both of these hold: the host's app-server version supports the `threadRealtimeExistingCall` capability (a version comparison, not a stored flag), and Statsig gate `206132468` passes. That second branch POSTs to ChatGPT `/wham/realtime/calls` and then starts `thread/realtime/start` as `ExistingCall`. CPA never sees creation, so the sideband websocket 404s.

The hook forces Statsig `checkGate("206132468")` to false on every client registered on `__STATSIG__`. In the audited build that gate has no other reader, so the result is durable-only ownership: a local host gets `clientOwnsCall=false` and `transport=webrtc`, and CPA can `POST /v1/realtime/calls`. Other gates pass through unchanged. Official app-server traffic is not rewritten. Host still passes official `thread/realtime/*` through.

## How it is installed

1. Unless `CODEXHOST_CPA_LIVE_VOICE=0`, the Controller prefixes the production Renderer source with a frozen `globalThis.__codexhostCpaLiveVoiceHookV1` record (audited Desktop version and `app-initial` asset name only).
2. `Page.addScriptToEvaluateOnNewDocument` plus immediate `Runtime.evaluate` inject the Host Renderer into the primary `app://-/index.html` page.
3. Voice starts on the avatar overlay (`app://-/index.html?initialRoute=/avatar-overlay`). That page gets a **hook-only** bundle (`cpa-live-voice-hook.js`), not the Host Renderer binding. The overlay loads the same audited `app-initial` asset in its own JavaScript realm with its own Statsig client. The overlay bundle also drops Host `thread/started` and turn/item notifications unless that overlay currently owns the realtime Thread, so a leftover overlay does not upsert CLI-created Threads or rebind the same Turn into the main chat.
4. The Renderer hook no-ops unless the exact audited `app://-/assets/app-initial-6350d04672d0.js` asset is present (performance entries, script src, or link href, including relative URLs). Unknown assets fail closed; matching text in a query string or source-map filename is insufficient.
5. On a matching page it polls for up to 60 seconds until a Statsig client is registered, then wraps that client's `checkGate`. The gate is read when voice starts, so the wrap only has to land before the first voice click.

Verify before a trial: on the overlay, `__STATSIG__.firstInstance.checkGate("206132468")` returns `false`.

Overlay discovery, connection, and injection share one timeout. Overlay attempts run concurrently, and a stalled or disappearing overlay does not prevent the primary Host session from becoming ready after that deadline.

The hook does not copy OpenAI frontend JavaScript into git. Tests cover the asset gate and Statsig override with synthetic clients.

## Version gate

Audited only for Desktop **26.1007.30912** (primary bundle `app-initial-6350d04672d0.js`). Re-audit before enabling on a newer build. Fail closed: no wrap, no ASAR patch, keep `~/Applications/ChatGPT-Voice.app` if that copy is still the working path.

## Invariants

- Do not overwrite `/Applications/ChatGPT.app` (Developer ID `2DC432GLL2`).
- Do not reuse `install_voice_patch.py`.
- Do not quit or replace the working Voice copy until the CodexHost path proves `POST /v1/realtime/calls` 201.
- Do not put call IDs, SDP, or auth material in docs, git, or command output.
- Do not `git push` this branch or open an upstream PR unless explicitly requested.

## External Harness voice (local development build)

New-chat voice launches use the primary Composer's current Harness selection.
On the audited Desktop build, the primary Renderer imports the already-loaded
browser module `app-shared-8bd9d0399038.js` and wraps only its native
`realtimeVoiceRuntime` service reference (export `fN`). Its RPC stubs themselves
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
configured WebSocket base at `/live/{callId}`. Both configured bases must use HTTPS
and share an origin. Authentication uses the selected configured model provider's
`experimental_bearer_token` or `env_key`; OAuth from `auth.json` is never copied.
The Host reads `CODEX_HOME/config.toml` only and does not mutate gateway settings.
Profile/command-line credential overrides are not resolved by this prototype.

V3 `delegation.created` task text goes to that same external Thread. Only completed
agent-message results are returned as speakable context; private reasoning and tool
output are excluded. Delegation IDs are deduplicated within a call. Transcripts are
projected through native notifications. Closing the call releases voice resources
and suppresses late speech, but does not cancel a running agent task: explicit task
cancellation remains the existing `turn/interrupt` operation.

The speech service is instructed to delegate every question and task, including
simple arithmetic; it supplies speech rather than owning task reasoning.
The prototype defaults to Cantonese and the protocol's `cove` voice; supported V3
voices can be requested. Text/audio append transports, ExistingCall attachment,
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
