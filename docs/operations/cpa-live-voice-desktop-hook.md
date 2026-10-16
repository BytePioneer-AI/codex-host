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
3. Voice starts on the avatar overlay (`app://-/index.html?initialRoute=/avatar-overlay`). That page gets a **hook-only** bundle (`cpa-live-voice-hook.js`), not the Host Renderer binding. The overlay loads the same audited `app-initial` asset in its own JavaScript realm with its own Statsig client.
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
