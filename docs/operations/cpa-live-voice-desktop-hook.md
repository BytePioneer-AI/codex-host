# CPA live-voice Desktop hook

CodexHost routes native live-voice call creation through the configured realtime gateway without rewriting `app.asar` or replacing `/Applications/ChatGPT.app`. Desktop **26.1007.30912** uses a call-ownership gate override. Desktop **26.1013.40934**, **26.1016.51333**, **26.1016.61520**, **26.1016.62342**, and **26.1021.31345** use the native client-owned-call flow described below. Native Chat Instant Connect has a separate **26.1021.31345** profile.

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

Desktop **26.1016.61520** hides native Start voice when Statsig rollout
`3683713372` is on and `model_provider` is not `openai`. CodexHost leaves
`model_provider = "custom"` unchanged. Work + gateway (and owned `codexhost/`
Harness composers) project only that composer’s `voice.realtime` /
`voice.thread` subscriptions. ChatGPT Chat stays on its separate native browser-voice stack.

The unaudited-Desktop asset gate still fail-closes. `~/.codex/config.toml` realtime keys stay manual.

Daily CI (`npm run compat:daily`, `.github/workflows/compat-daily.yml`) compares the public Sparkle appcast to the Work/gateway and Chat voice pins. It does not download ChatGPT.app. A pin behind Sparkle latest opens or comments on a `compat-broken` issue on this repository.

First-start official-backend recovery is covered by `packages/host-runtime/test/native-account-host.test.ts` (failed first generation, delayed second generation, no `unhandledRejection`). Manual cold-start UAT: fully quit ChatGPT and CodexHost, start **CodexHost 0.13.3** from the menu bar, wait ~15s. Pass: no 无法载入组织设定, console 总览 stays 启动成功, Work + Grok still shows Start voice. Fail: org-settings dialog on first launch only, then OK after 重试 — that is the remaining Host-wait gap, not Chat voice.

The hook only changes Desktop call ownership. Point Codex at the realtime host in `~/.codex/config.toml` as well, then relaunch:

```toml
experimental_realtime_ws_base_url = "https://<realtime-host>/v1"
experimental_realtime_webrtc_call_base_url = "https://<realtime-host>/v1"
```

## Desktop 26.1021.31345 qualification

Work/gateway client-owned-call is audited for **26.1021.31345** build **21828**. `/wham/realtime/calls` is `Htr.getInstance().fetch` on `app-initial-feb30b196d11.js`; the message bridge is shared `bIt` and services `Qot`. Overlay is `avatar-overlay-native-page-d549db3706f1.js`. The 26.1016.62342 and 26.1016.61520 Work profiles remain supported.

The same version profile supplies every Work voice consumer, including new-chat
launch routing and the overlay starter. Capability initialization uses initial
`l0n`, capability family `c0n`, and inference-gate family `Cnr`; the 26.1016
profiles retain `njr` / `tjr` / `uBr`. Family resolution accepts arbitrary cache
keys, so resolving `3683713372` on an unrelated family does not identify the
inference gate. Missing audited exports fail closed without probing other
families. Both composer and overlay project only their owned subscriptions.
Existing Codex chats send the native product experience `codex`; Work home
starts send `work`. Both use the Work connection choice for explicit local
composer starts. The starter and call transport retain that native product
identity, including when the overlay has no Composer or model metadata.
Starter qualification continues to exclude remote, global-hotkey and
avatar-button requests.

Composer health also compares the projected subscriber and instance snapshots
with React's committed capability value. A brief Host readiness or routing
interruption can commit the native fallback without changing its underlying
atom. When readiness returns, a stale committed value causes the next
one-second poll to rebind and notify the owned subscriptions. React's equivalent
lazy snapshot wrappers remain valid; account and workspace checks remain native.
Work surface discovery ignores retained zero-size, hidden or inert Chat composers.
A visible Chat composer still prevents that Work fallback from claiming the surface.

When Desktop omits resource timing and script asset names, the explicit Desktop
product version and platform select the profile and the hook imports its exact native assets.
Observed incomplete or mixed initial/shared pairs still fail closed. Overlay
preparation rechecks that profile and requires the committed starter component
to belong to its exported native overlay page.

A controlled live check on 25 October 2026 confirmed one enabled **Start new
voice chat** button in an idle Codex Work composer with the gateway selected.
The native capability remained false while the owned subscription read true.
The separate overlay check confirmed gateway readiness through `bIt` and a
committed projected starter snapshot, then restored the native subscription.
Neither check opened a call or captured microphone audio; physical microphone,
gateway call creation, audible reply and hangup acceptance remain unverified on
26.1021. The primary and overlay bundles must both be installed; replacing an
overlay hook after its native starter has registered does not replace that
existing callback. A fresh overlay document or Desktop restart binds it.

Native Chat Instant Connect uses the full composer START relocated to
`entity-business-profile-reference-b68063dfc05d.js` (`i`, initializer `r`). Its
scope/props/metadata/abort-signal signature preserves native navigation,
availability and session guards. `start-voice-5bbdc12fe620.js` provides a
different starter-prompt entry and cannot substitute for composer START.
`renderer-native-chat-voice-assets.ts` owns the version profiles and normalizes
audited exports to the retained Chat lifecycle contract. Native initializers run
before their mutable exports are captured.

The current Chat profile uses shared `Bst` / `XVt` / `KNt` for AppScope, React
and ReactDOM; initial `CQn` / `PXn` / `tdn` / `qXt` for RouteScope,
ComposerScope, backend Chat ID and browser voice store; primary `um` / `lm` for
browser initialization and its enable flag; and
`voice-prewarm-d672f1245523.js` for the native prewarm controller. Draft
selection retains the native location/navigation/transcript/intent roles via
initial `Xkn` / `yAn` / `ydn` / `fdn` / `R2` and shared `Fot`.

A live no-call check confirmed one enabled Chat waveform immediately before
Send, matching size and vertical alignment, and one native prewarm controller.
Microphone capture, native call creation, audible reply and hangup are separate
acceptance checks.

### Native Voice Settings with a custom provider

cc-switch's Unified Codex session history intentionally uses `model_provider =
"custom"` for official-subscription and third-party sessions. Keep that provider
identity and its history. Changing it to `openai` is not a voice repair.

The native Voice Settings page reads the `voice.realtime`, `dictation.composer`
and `dictation.global` capability family members. Its Voice chat group also reads
a derived boolean, and the page and shortcut controls read the native dictation
mode selector. On 26.1021.31345, CodexHost restores the native controls by
projecting only these owned Settings subscriptions when the voice access policy
is `allowed`, root voice capability is ready and capable, and readonly replay
proves the inference-provider condition is the sole blocker. The Voice chat boolean replay must read that exact realtime capability and agree
with its native value before substitution. Dictation mode replay preserves the
native platform choice (`os-global` on macOS/Windows, `app` on eligible Linux)
and all non-provider dictation policy and feature checks. Native atoms, provider configuration and global Statsig values
retain their values. Account/workspace denial, loading, errors, rollout gates
and unrelated restrictions remain authoritative.

`renderer-voice-settings-availability.ts` identifies committed Settings groups
below the exported page and binds the boolean reader. The existing capability binder handles only the explicitly selected family
members on the exported Settings page. `renderer-dictation-settings.ts` binds
the exact native mode selector within Settings, including newly mounted shortcut
controls, so their save handlers select the correct OS service. Ambiguous ownership or unsupported
subscriptions fail closed, with rollback if a required reader could not be bound.
Navigation, disposal and eligibility changes restore native readers. While a
supported binding is unavailable, the existing text-only explanation can identify
a provider-only rejection; it does not grant access. The hook retries controls
after passive subscription initialization without repeatedly rewriting that text.
The installer also retries native asset discovery during document startup: an
initial chunk observed before its shared chunk cannot permanently skip Settings
installation. Incomplete or mixed asset pairs still fail closed.

The restored controls keep their native handlers:

| Control | Native persistence and consumers | Verification limit |
| --- | --- | --- |
| Voice | Account `voice_name`, through `/settings/account_user_setting`; catalog from `/settings/voices` in `wingman` mode. Native Chat browser voice consumes the account voice. Work realtime resolves the same catalog's effective slug, including native alias mapping, and puts it into session audio output. The gateway bootstrap preserves that session body; external Harness voice accepts the native voice parameter. | Picker opens with nine compatible voices. Saving a different voice and audible selection require attended acceptance. |
| Language | Native account `voice_main_language` preference, shared with voice and dictation. Visibility follows the native dictation capabilities or available dictation mode. | Language selection is visible; the existing saved language is retained. |
| Dictation | Native composer/global dictation capabilities and mode selector. The macOS shortcut editor uses the native global-dictation service and retains permission setup. | Shortcut row is visible and its owned mode readers commit `os-global`. Capture, transcription, OS registration and permission grants are not established by restoring Settings. |
| Voice chat hotkey | Desktop `commandKeybindings` service, command `realtimeVoice`; its main-process controller starts `global_hotkey_new_thread` through the avatar overlay. | Editor is enabled. Registration and call launch retain native main-process and overlay capability checks. The gateway starter hook qualifies explicit local composer starts, not global-hotkey starts; restoring Settings does not establish global-hotkey call support with a custom provider. |
| Screen context | Native `realtimeVoiceScreenContextEnabled` preference. The row retains macOS, appshot availability and dynamic-tool configuration checks, plus the native first-use introduction and OS permissions. Work's `capture_screen_context` handler checks this preference again and requires the matching active voice task. | Row and toggle are enabled in the observed eligible environment. Actual foreground capture and permissions were not exercised. Chat browser voice has separate camera/screen-share controls; this toggle does not establish equivalent capture there. |

Live checks on this build confirmed the native controls, an account policy of
`allowed`, and a native `voice.realtime` capability that stayed false while the
owned Settings readers rendered the controls. Language and Dictation also retain
their native capability values while the owned mode readers commit the platform
mode. Three Settings navigation round
trips retained the controls. No account voice, hotkey or permission was changed.
The Composer capability hook reports `native-ineligible` when its provider-only
replay still cannot make the native capability capable; this is diagnostic state
and leaves the native account, workspace and rollout checks authoritative.
These checks do not establish a complete spoken call. On 25 October 2026,
Karl reported that the instructed manual Voice Settings and existing-Codex-chat
voice test passed after a full restart with the startup and `codex` request
fixes installed. This is operator-reported acceptance; the global voice hotkey,
screen capture, dictation and separate Chat browser-voice call still require
their own live checks.

| Asset | 62342 | 26.1021.31345 |
| --- | --- | --- |
| Initial | app-initial-dddef47d6ef6.js | app-initial-feb30b196d11.js |
| Shared | app-shared-fc3316d48427.js | app-shared-2cae01273bae.js |
| Work overlay | avatar-overlay-native-page-ef8332c6a2fb.js | avatar-overlay-native-page-d549db3706f1.js |
| Native Chat START | start-voice-7cbf0a39d53b.js | entity-business-profile-reference-b68063dfc05d.js |
| Native Chat prewarm | voice-prewarm-5d107129ac1c.js | voice-prewarm-d672f1245523.js |

The 26.1021.31345 ASAR SHA-256 is
`130145706a912db74e4d260ad7538f10f1e05e88af955f9afba42cdf01e64606`.
Sanitized evidence is under ignored `.codexhost/update-impact/26.1021.31345/`.

## Windows MSIX product and platform qualification

Windows discovery reads the Desktop product version from a bounded ASAR
`package.json` entry and retains the MSIX deployment version in `build` and its
activation identity. The Launcher supplies that product version to the Controller;
the voice bootstrap includes `desktopPlatform`. `CODEXHOST_DESKTOP_VERSION` remains
a diagnostic override. Missing metadata falls back to the deployment version,
which cannot qualify a different product profile by numeric resemblance.

Product `26.1021.31345` has separate macOS and Windows asset profiles. A complete,
unambiguous pair identifies a profile; empty resource lists require an exact
product/platform match. Mixed assets, partial pairs, unknown versions and platform
contradictions fail closed. Windows uses the public prewarm wrapper, which
initializes and re-exports the native Instant Connect controller.

Profile selection does not grant account/workspace access or prove a spoken
call. Native Windows Settings excludes screen context; codexhost preserves that
platform restriction. Voice selection and hotkey controls remain subject to native
account and workspace eligibility. The daily Windows CI job verifies MSIX and
profile fixtures, independently of the macOS Sparkle latest-version check.

On 26 October 2026, the user reported that both Chat and Work voice-chat paths
passed manual testing on the Windows VM after completing official login. Before
login, the configured gateway was ready but native provider-only capability
replay remained ineligible. This acceptance resolves that observed login-related
blocker while preserving the custom provider route and native eligibility checks.
The report does not separately qualify Voice Settings controls, screen context,
external Harness voice, or long-call recovery.

## Live voice-hook debug on a running Desktop

Use this procedure when a voice control is missing on an already running
codexhost-controlled Desktop after a hook source fix. Live `Runtime.evaluate`
updates the current document. Composer visibility can be confirmed without a
Desktop restart. A later manual restart remains the user's choice for loading
new document-start source. This is an attended debug path; it is not a generic
hot-reload contract for the Renderer binding.

For native Chat, use the same attach/build/evaluate procedure with
`installNativeChatVoiceHook` and `__codexhostNativeChatVoiceV1.dispose()`;
`activeCall` must be false before disposal. The Settings controls and fallback explanation have their
own `installVoiceSettingsExplanation` / `__codexhostVoiceSettingsV1` lifecycle.
Verify the actual Chat button and native Settings controls after refresh, not just hook
installation. Both installers are included in the persistent Renderer bundle.

Read-only attach and status (steps 1–2) come first. Run mutation steps within
the user's requested debug/install scope; preserve any manual-restart
preference. Skip mutation during an active or unknown call.

### 1. Attach through repository CDP

Discover the current loopback HTTP origin from the running Controller
`--renderer-cdp-endpoint` or the Desktop `--remote-debugging-port`. The Launcher
runtime descriptor identifies the current process tree; extract only that origin.
Leave ports, PIDs, minified export names, temporary paths, nonce, tokens, query
and hash values, and whole target lists out of notes and command output.

Attach with `CdpClient` from `packages/desktop-control/dist/index.js` (or
`dist/cdp-client.js`). `listCdpTargets(origin)` reads loopback `/json/list`.
`selectPrimaryRendererTarget` requires exact `app://-/index.html` with empty
search and hash. Overlay targets are distinct URLs that include `avatar-overlay`
(`selectAvatarOverlayRendererTargets`).

```js
import { execFileSync } from "node:child_process";
import {
  CdpClient,
  listCdpTargets,
  selectAvatarOverlayRendererTargets,
  selectPrimaryRendererTarget,
} from "./packages/desktop-control/dist/index.js";

function discoverRendererCdpOrigin() {
  const text = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
  let fromDesktop;
  for (const line of text.split("\n")) {
    const endpoint =
      /--renderer-cdp-endpoint\s+(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)\b/.exec(line);
    if (endpoint) return endpoint[1];
    const port = /--remote-debugging-port=(\d+)/.exec(line);
    if (port && /ChatGPT|Codex\.app|codexhost/i.test(line)) {
      fromDesktop = `http://127.0.0.1:${port[1]}`;
    }
  }
  if (fromDesktop) return fromDesktop;
  throw new Error("Running Desktop has no loopback Renderer CDP origin");
}

async function evaluate(client, expression) {
  const response = await client.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response?.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Runtime.evaluate failed",
    );
  }
  return response?.result?.value;
}

const origin = discoverRendererCdpOrigin();
const targets = await listCdpTargets(origin);
const primary = selectPrimaryRendererTarget(targets);
const overlay = selectAvatarOverlayRendererTargets(targets)[0] ?? null;
if (!primary) throw new Error("No primary app://-/index.html target");
```

Define `SANITIZED_STATUS` from step 2 before running the attach example there.
`evaluate` allows an `undefined` value, which is the normal `Runtime.evaluate`
result for an IIFE that returns nothing. `CdpClient.evaluate` still checks
`exceptionDetails` but requires a returned value, so use this helper for
injection. Connect `overlay?.webSocketDebuggerUrl` only for steps 5–6.

### 2. Inspect sanitized status only

Evaluate counts and booleans. Keep config, credentials, prompts, transcripts,
IDs, and the DOM out of the result.

```js
const SANITIZED_STATUS = `(() => {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && !el.closest("[hidden], [inert]");
  };
  const nameOf = (el) =>
    (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim();
  const routes = JSON.parse(localStorage.getItem("codexhost.voice-routes-cache.v1") || "null");
  let localComposer = false;
  try {
    const routing = window.__codexhostHostRoutingV1;
    const route = routing?.forComposer();
    localComposer = route?.hostId === "local" && routing?.forHost("local") === route;
  } catch {}
  const workComposers = [...document.querySelectorAll("[data-codex-composer-root]")].filter(
    visible,
  );
  const workComposer = workComposers.length === 1 ? workComposers[0] : null;
  const start = workComposer
    ? [...workComposer.querySelectorAll("button")].filter((el) => {
        const name = nameOf(el);
        return (
          visible(el) &&
          !el.disabled &&
          /^(Start new voice chat|Start voice chat|Start voice)$/i.test(name)
        );
      })
    : [];
  return {
    desktopVersion: window.__codexhostCpaLiveVoiceHookV1?.desktopVersion ?? null,
    clientOwned: window.__codexhostClientOwnedVoiceV1?.status ?? null,
    externalLaunch: window.__codexhostExternalVoiceLaunchV1?.status ?? null,
    voiceCapability: window.__codexhostVoiceCapabilityV1?.status ?? null,
    voiceStartCapability: window.__codexhostVoiceStartCapabilityV1?.status ?? null,
    gatewayReady: window.__codexhostVoicePreferenceStateV1?.gatewayReady?.get(window) === true,
    workGateway: routes?.workConnection === "gateway",
    chatGateway: routes?.chatExperience === "codex" && routes?.chatConnection === "gateway",
    chatgptChat: routes?.chatExperience === "chatgpt",
    localComposer,
    visibleWorkComposers: workComposers.length,
    visibleChatComposers: [...document.querySelectorAll("[data-chatgpt-composer]")].filter(visible)
      .length,
    enabledStartVoiceButtons: start.length,
    stopPresent: [...document.querySelectorAll("button")].some((el) => {
      const name = nameOf(el);
      return visible(el) && /^(Stop|Stop generating)$/i.test(name);
    }),
  };
})()`;
```

Count **Start voice** inside the unique visible Work composer
(`[data-codex-composer-root]`). Native Chat **New voice chat** stays out of Work
acceptance. On overlay, `voiceStartCapability` is the overlay hook. Hook
`active` is not proof that the composer button is visible.

```js
const inspectClient = await CdpClient.connect(primary.webSocketDebuggerUrl);
try {
  const status = await evaluate(inspectClient, SANITIZED_STATUS);
} finally {
  inspectClient.close();
}
```

### 3. Authorized live refresh of the primary page

Build an ephemeral browser IIFE from current repository modules with esbuild.
Do not copy vendor chunks. Write the bundle outside tracked source. Evaluate it
once on the primary page. Dispose existing handles first:
`installExternalVoiceLaunchHook` and `installVoiceCapabilityProjection` return
the already-installed object when present.

Desktop CSP forbids dynamic code generation, so set Zod `jitless` before
install. Refresh only the voice hooks. Leave the production Renderer binding,
native capability atoms, global Statsig, `model_provider`, global `fetch`, and
immutable RPC stubs unchanged.

```js
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outfile = path.join(await mkdtemp(path.join(os.tmpdir(), "codexhost-voice-")), "primary.js");
await build({
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2024",
  outfile,
  stdin: {
    resolveDir: root,
    loader: "ts",
    contents: `
      import { z } from "zod";
      import { installExternalVoiceLaunchHook } from "./packages/renderer-extension/src/renderer-external-voice-launch.ts";
      import { installVoiceCapabilityProjection } from "./packages/renderer-extension/src/renderer-voice-capability.ts";
      z.config({ jitless: true });
      window.__codexhostVoiceCapabilityV1?.dispose();
      window.__codexhostExternalVoiceLaunchV1?.dispose();
      installExternalVoiceLaunchHook();
      installVoiceCapabilityProjection();
    `,
  },
});
const refreshClient = await CdpClient.connect(primary.webSocketDebuggerUrl);
try {
  await evaluate(refreshClient, await readFile(outfile, "utf8"));
  const deadline = Date.now() + 20_000;
  let status;
  while (Date.now() < deadline) {
    status = await evaluate(refreshClient, SANITIZED_STATUS);
    if (status?.externalLaunch === "active" && status?.voiceCapability === "active") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (status?.externalLaunch !== "active" || status?.voiceCapability !== "active") {
    throw new Error(
      `Voice hooks did not become active within 20s (externalLaunch=${status?.externalLaunch}, voiceCapability=${status?.voiceCapability})`,
    );
  }
} finally {
  refreshClient.close();
}
```

Installation is async. The loop is bounded hook initialization: it waits until
`externalLaunch` and `voiceCapability` read `active`, then throws if they never
do. It does not prove a committed React snapshot, owned subscription, or visible
button; that verification is step 4. `Runtime.evaluate` of the IIFE returns
`undefined`; the custom `evaluate` helper allows that. Use the current production
profile from `CLIENT_OWNED_VOICE_ASSETS` for the observed `desktopVersion`. On
exact **26.1021.31345** the audited exports
are `capabilityInit=l0n`, `capabilityFamily=c0n`, `inferenceGateFamily=Cnr`,
service `Qot`, bridge `bIt`, and fetch `Htr` from initial, as recorded in the
qualification section above. Those names document that profile. They are not a
generic discovery contract. Resolving an arbitrary cache key on a family does
not identify the inference gate; an unrelated family can read `active` while
projected `voice.realtime` / `voice.thread` remain false.

### 4. Verify composer behavior

Confirm the control, not only hook status. Use an idle, unique, visible **LOCAL**
Work composer with gateway ready and **Work → Voice connection** set to
Configured gateway. Pass: exactly one **Start new voice chat** button is visible
and enabled; native capability stays false; the owned subscription reads true.

An idle blank composer may be selected for this check without submitting text or
editing existing drafts or turns. A running agent task stays running. A visible
Stop control can hide the microphone while the turn is busy. Native Voice Settings retain their account access policy; restoring their controls
does not establish call eligibility for every voice entry point.

### 5. Overlay document

The avatar overlay is a separate JavaScript realm with its own document-start
registration. To replace a pending overlay hook, dispose only
`__codexhostVoiceStartCapabilityV1`, then install from
`renderer-voice-start-capability.ts`:

```ts
import { z } from "zod";
import { installVoiceStartCapabilityHook } from "./packages/renderer-extension/src/renderer-voice-start-capability.ts";
z.config({ jitless: true });
window.__codexhostVoiceStartCapabilityV1?.dispose();
installVoiceStartCapabilityHook();
```

That wrap applies to future `registerRealtimeStarter` calls. It cannot replace a
callback already registered on this overlay document. Bind an already-registered
starter with a fresh idle overlay document that received the updated
document-start injection, or with the user's later manual full restart. Refreshing
the primary page does not fix overlay registration. Leave the overlay document
alone during an active or unknown call. A full Desktop restart is not required
to validate primary composer visibility.

### 6. Optional overlay validation without a call

A bounded overlay check can confirm gateway readiness and a committed projected
starter snapshot without opening the microphone. Import
`initializeVoiceCapabilityFamilies` and `bindVoiceCapabilitySubscriptions` from
`renderer-voice-capability.ts`, `overlayVoiceStarterFibers` from
`renderer-voice-start-capability.ts`, and `requestVoiceHost` from
`renderer-client-owned-voice.ts`. Use the current profile's exact `bridge` export
and `realtimeOnly: true`. Always `binding.dispose()` in `finally`.

```js
const ready = await requestVoiceHost(
  shared[profile.bridge].getInstance(),
  {},
  "codexhost/voice/gateway-status",
);
const { family, gates } = initializeVoiceCapabilityFamilies(initial, profile);
const binding = bindVoiceCapabilitySubscriptions(
  () => overlayVoiceStarterFibers(document, overlay.AvatarOverlayNativePage),
  family,
  gates,
  () => true,
  true,
);
try {
  for (let i = 0; i < 40 && !binding.current(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    gatewayReady: ready === true,
    overlayProjectionCommitted: binding.current() === true,
  };
} finally {
  binding.dispose();
}
```

Report those two booleans. Observed pass on 26.1021 was `gatewayReady: true` and
`overlayProjectionCommitted: true` with no call. This check does not replace an
already registered overlay starter.

### 7. Persist built bundles

Live evaluation lasts for the current document. For later documents, build and
stage the installed files:

```sh
npm run build:renderer
```

Copy `packages/renderer-extension/dist/production.js` onto the running
installation's `app/renderer-extension.js`, and
`packages/renderer-extension/dist/cpa-live-voice-hook.js` onto `app/cpa-live-voice-hook.js`.
On the macOS app bundle those paths are
`/Applications/codexhost.app/Contents/Resources/app/`. Discover the equivalent
payload from the current Controller `--renderer` argument on other layouts.
Back up both files and hash-verify the copies. Skip `npm run install:local` when
the goal is only to stage assets; that command can restart Desktop.

The running Controller can keep the previous source in memory. A disk copy does
not replace the active script or change document-start registration for future
pages in this process. A later package update can replace a locally staged fix.
Leave `/Applications/ChatGPT.app` and `app.asar` unchanged.

### Limits

- Live injection is the current document only.
- Overlay starter wrapping is future registrations on that overlay document.
- Physical microphone, gateway call creation, audible reply, and hangup remain
  separately unverified on 26.1021.
- Keep call IDs, SDP, credentials, and runtime tokens out of docs and output.

## Desktop 26.1016.62342 qualification

Work/gateway and native Chat have independently audited **26.1016.62342** build
**21477** profiles. The exact **61520** profiles remain supported, so installing
the host before upgrading Desktop preserves the working baseline. Unknown
versions, version/asset mismatches, incomplete pairs and mixed audited assets
fail closed before native imports. Without version metadata, exactly one
complete audited initial/shared pair is required. The selected profile also
owns its overlay or native Chat START/prewarm imports.

| Asset | 61520 baseline | 62342 target |
| --- | --- | --- |
| Initial | app-initial-c95ddb62696e.js | app-initial-dddef47d6ef6.js |
| Shared | app-shared-2eda13eb7044.js | app-shared-fc3316d48427.js |
| Primary Chat owner | app-primary-58a09006cc0c.js | app-primary-10e84ec314b8.js |
| Work overlay | avatar-overlay-native-page-fcc17283519a.js | avatar-overlay-native-page-ef8332c6a2fb.js |
| Native Chat START | start-voice-18b08f0acdd7.js | start-voice-7cbf0a39d53b.js |
| Native prewarm entry | voice-prewarm-94271e581c1b.js | voice-prewarm-5d107129ac1c.js |
| Native prewarm controller | voice-prewarm-de985dbe0490.js | voice-prewarm-9695e173952c.js |
| Voice session | voice-session-7d5ee22a0da4.js | voice-session-c6b0f08e69a2.js |

The 62342 ASAR SHA-256 is
`5b5cf52887cfd4de19cb5862155a8ef6cf58830c0a2fc592b72060cfcc3be869`.
Acquisition reads selected entries through ZIP ranges, then individual ASAR
header offsets; it does not install Desktop or extract the full ASAR.

After replacing imported asset hash suffixes, the primary owner, overlay, START,
prewarm and voice-session sources equal 61520 byte for byte. Initial/shared
also differ in the embedded build commit:
`d7acb7a1b13f5e0f32a1e399e3fce368b08bd754` becomes
`293b23553a2ef1949121cc87c52983472a85ea23`.
The relevant CSS is byte-identical. Thus the 61520 contract table below also
applies to the corresponding 62342 files at the same formatted line numbers
(Prettier 3.9.6, Babel defaults, printWidth 80).

Work evidence includes initial:111047/111148 (capability and inference gate),
:682702/682778 (existingCall and WebFetch bootstrap), overlay:4084 (owned realtime
subscription) and :4693 (starter registration). Native Chat evidence includes
START:1119/1173/1194/1260; primary:121258/121370/125082/125124 (RouteScope and
inner ComposerScope/form); shared:84170/84202/84461/104176 (provider chain,
node token, scope ref and AppScope); initial:256888/685663/685754 (store,
runtime flag and VoiceRoom). Export names and the guarded transcript adoption
contract remain unchanged.

A broader offset comparison covers all 15,305 Renderer JS/CSS files. Aside from
asset references/build metadata, changes are CSS module identifiers in control
and placement UI, and the automation dialog's model-list client version changing
from 0.163.0-alpha.11.1 to .11.2. The consumed composer, routing, usage-gate and
voice contracts have no source change requiring additional integration.

This is source qualification plus isolated regression coverage. The installed
upstream app remains 61520 until an explicit upgrade. No 62342 live Desktop,
physical microphone, audible reply, transcript adoption or cleanup acceptance is
claimed. Issues [#7](https://github.com/karlorz/codex-host/issues/7) and
[#8](https://github.com/karlorz/codex-host/issues/8) retain functional acceptance;
[#4](https://github.com/karlorz/codex-host/issues/4) retains the original Chat
acceptance limits. A matching compat-daily pin warrants a recovery comment,
independently of those live checks.

## Desktop 26.1016.61520: client-owned calls

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

Explicit Work launch ownership selects the Work connection preference in the
avatar overlay, where no primary Composer is present. It applies even when the
backend model name has no `codex` marker (for example, `gpt-6.1-sol`) or call
metadata omits the model. Model-name and visible-Composer detection remain
fallbacks for launches without an explicit product experience. Explicit Chat
ownership still selects the Chat connection preference.

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

`renderer-voice-capability.ts` projects the owning visible local Work composer's subscriptions to those two capabilities. It requires the exact 26.1016 initial/shared assets, active client-owned and external-launch hooks, enabled injection, a successful live Host gateway-readiness check, and the Work gateway choice or an explicitly owned local external Harness selection. ChatGPT voice, remote Hosts and other capabilities retain native eligibility. The explicit Codex Chat gateway option qualifies the owned Chat form and overlay as described below. Hidden composer roots do not make the visible composer ambiguous; multiple visible roots fail closed.

Runtime settings reports return `gatewayReady: null` because the console skips its callback to the requesting Host. The Renderer reads the existing local `codexhost/voice/gateway-status` method directly when readiness is omitted. Transient settings or status request failures retain the last successful readiness; an explicit negative result or disposal revokes it. No successful readiness read means the projection stays pending. Route and
readiness caches share the document lifetime with the retained voice-hook globals.
A replacement Renderer bundle updates the same caches; disposing the settings
poll revokes readiness until its replacement completes a successful check.

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
explicit local Work composer starts using the Work gateway preference, explicit Codex Chat gateway starts, or a
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

The retained native Chat baseline is **26.1016.61520** build **21421**:
`app-initial-c95ddb62696e.js`, `app-shared-2eda13eb7044.js`,
`start-voice-18b08f0acdd7.js`, and `voice-prewarm-94271e581c1b.js`.
Native Chat uses Desktop's browser Instant Connect stack. Its authentication,
account availability, START/RESTART commands, WM requests, microphone, VoiceRoom
and cleanup remain native. Codex Chat uses the separate Codex overlay and its
own connection preference. Missing or ambiguous native Chat bindings reject
without falling through to that overlay.

The audited 61520 baseline ASAR SHA-256 is
`c9945f821fcbaf48424933a82860beac4dd4ad8b8a5444a75568fa6e38a1ad4b`.
Only individual assets were read by ASAR offsets. These native file references
use Prettier 3.9.6 Babel formatting with default options (printWidth 80):

| Contract | 61520 evidence and binding |
| --- | --- |
| Native START | `start-voice-18b08f0acdd7.js:1119` accepts scope, composer props, metadata and signal; `:1173` reads `B1n`; `:1194` dispatches START. Exports `n`/`t` at `:1260`. Native navigation, active-session and availability checks remain authoritative. |
| Scope ownership | `app-primary-58a09006cc0c.js:121258` holds the composer's RouteScope ref (`initial.MOr`). `app-shared-2eda13eb7044.js:84461` defines that ref's get/set and chain. Its AppScope node must match the native context (`shared.Qst`, defined at `:104176`). |
| Saved and draft selection | `app-primary-58a09006cc0c.js:121370` builds an inner chatgpt ComposerScope value with the current selection; `:125082` mounts its provider above the form at `:125124`. `app-shared-2eda13eb7044.js:84170` publishes the chain through that context provider; `:84202` stores the scope descriptor as the node token. Draft IDs originate in useState at `:129002`. The nearest committed ComposerScope provider between the form and owner must carry the native `initial.CDr` token, the owner's RouteScope and AppScope nodes, and the same selected conversation ID. The owner's consumed context can still be the outer new-Chat scope and cannot substitute for the form's provider. |
| Store and runtime | `app-initial-c95ddb62696e.js:256888` exports the native store accessor as SPn. `:685663` initializes browser voice with oT and flag aT; `:685754` mounts native VoiceRoom. `voice-session-7d5ee22a0da4.js:7745` publishes VoiceRoom, START command handling and native cleanup through initializeVoiceSession. |
| Prewarm | `voice-prewarm-94271e581c1b.js:1` re-exports the controller from `voice-prewarm-de985dbe0490.js`. Its AppScope, ComposerScope, selected-system-hint reads, eligibility, abort watchers and cache ownership stay native. React and createRoot are shared.FBt and shared.PNt, the same React/ReactDOM instance used by Desktop. |
| Adopted-draft navigation | `initial.Ycr` is the current location; Nir invokes native AppNavigation. B1n resolves the adopted backend ID; n0n and Y1n resolve the transcript mapping/current node. `shared.Vot` constructs the draft page path. Navigation waits for the connected session, adopted ID and current transcript message; an early server ID alone is insufficient. |
| Primary action presentation | `app-initial-c95ddb62696e.js:202194` places `icon-primary-action text-composer-primary` on the icon, while `:202249` applies disabled opacity/cursor classes to the button. Voice reuses Send geometry and colors, with its own disabled state. |
| Home headline | `app-primary-58a09006cc0c.js:140384` marks the rotating headline with data-headline; `:140770` puts it in the --vt-splash-screen-headline container. During active native voice on that same Chat draft, the unique visible headline container is hidden with visibility to preserve layout and leave room for the native orb. Ending, leaving the eligible composer or disposal restores its prior visibility. Work voice does not suppress the headline. |

The visible Chat owner must be non-temporary, writable, and allow external
egress. Its props, selection context, RouteScope chain, AppScope context and
inner ComposerScope must agree. Saved Chats require a backend ChatGPT UUID;
unsaved Chats require a valid native local-chatgpt draft locator and no backend
ID. A Desktop Thread-Id is never converted into a ChatGPT UUID.

For ChatGPT voice, the hook mounts one native prewarm controller per AppScope
under both native contexts and enables the native browser-voice flag. RouteScope
replacement during navigation updates the provider chain without replacing the
AppScope runtime. Starting or active voice retains the runtime while the composer
is hidden. Leaving Chat after voice ends restores the prior flag and unmounts
the controller. Native eligibility determines whether a selection can prewarm.

The Start Voice waveform sits immediately before the visible native Send button,
including compact Chat home composers without Dictate. It follows Send when its
wrapper changes and is removed while the form has no unique visible submit
action (such as during Stop).
It matches the native voice control row's gap-2 spacing (normally 8px),
supplementing only the spacing missing from its parent and centering the action.
Native voice's microphone/end row uses flex items-center gap-2 in
voice-session-7d5ee22a0da4.js:7563. Existing parent spacing is not doubled.
The waveform uses the native contrasting icon foreground and stays enabled
when an empty message disables Send. Its dimming follows voice startup,
streaming and active-call state independently of Send.
It invokes native START with the current
RouteScope, props, composer metadata and cancellation signal. While present it
hides the competing Codex Start voice entry in that Chat composer. Switching to
Codex voice or leaving Chat restores the original entry. Saved Chats remain
selected. Draft navigation is attempted once, after adoption, and cancels if the
user leaves, the session changes or ends, or the binding is released. Missing
navigation exports leave native voice available with manual transcript selection.

Home stays selected until native voice has connected, adopted the Chat and
published the current transcript message. Starting while muted or without
microphone input does not by itself satisfy those conditions. The orb and
microphone/end controls alone do not establish transcript readiness. Early page
navigation can interrupt native voice; no timer or early server ID bypasses
the adoption and transcript guards.

Instant Connect may adopt a prewarmed voice-session ID during startup. The
native `initial.HJt` request-generation counter remains unchanged for that
adoption and advances for a new voice intent. Draft selection tolerates the
startup ID change only with the same proven generation; it still cancels on
a new intent, an established session ID change, navigation, abort or voice end.
If the optional generation reader is absent or invalid, session ID changes
continue to cancel selection. Native START remains available independently.

The native version/asset and scope guards fail closed on unsupported builds.
Lifecycle tests cover saved and draft starts, prewarm contexts, navigation,
cancellation, retry, hidden composers and disposal. Native Chat microphone,
connected WM audio and account eligibility have **not** been exercised on the
running Desktop: Computer Use refuses access to com.openai.codex. Static source
qualification and tests do not establish those live results. Issue
[#4](https://github.com/karlorz/codex-host/issues/4) retains that acceptance limit.
A matching compat-daily pin clears version drift only.

### Codex Chat gateway capability

Chat → Codex → Configured gateway qualifies the visible Chat composer's owned
voice.realtime/voice.thread subscriptions, including the native hooks on the
form's owning component. The owner must match the form's eligible Chat props and
selection context; ambiguous owners or multiple visible forms fail closed. Work
routing state is not required to claim a Chat form. The overlay starter accepts
explicit local Chat starts only when that Codex gateway preference is active.
ChatGPT voice and Codex/Desktop default retain native capability checks. Both
composer and overlay projections preserve non-inference availability checks;
no global Statsig or provider-name override is used.

The client-owned WebFetch hook initializes shared.Oit before reading its lazy
singleton exports. Call creation for explicit Codex Chat gateway launches uses
Host credentials; native ChatGPT voice does not use this /wham transport.

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

Audited for Desktop **26.1007.30912** (gate path, primary bundle `app-initial-6350d04672d0.js`), **26.1013.40934** (client-owned path), **26.1016.51333**, and **26.1016.61520** (client-owned WebFetch wrap on `app-initial-c95ddb62696e.js` / `app-shared-2eda13eb7044.js`). Native Chat voice is pinned separately to 26.1016.61520 with live microphone/audio acceptance pending. Re-audit before enabling on another build. Fail closed: no wrap, no ASAR patch, keep `~/Applications/ChatGPT-Voice.app` if that copy is still the working path.

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

External Agent Messages completed during a voice call use Desktop's native
`::codex-realtime-inline{}` Markdown presentation. The Host adds the directive
only to Desktop projections; Harness history and speech context retain the
original answer. The Turn mapping records `realtimeInline: true`, so history
reloads and Host restarts preserve the same written presentation. This keeps
exact links and other Markdown visible alongside the speech transcript.

Grok text Item IDs use the native Session, visible Turn index, Item kind and
message ordinal in both live projection and history replay. Chunk boundaries,
optional native message IDs and message text do not determine those IDs.
History hydration can therefore replace the streamed Item while preserving
separate messages that happen to contain identical text.

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
4. Check that the final answer is heard before hangup, its written Markdown and
   links appear in the voice timeline, the backend Turn completes, and Desktop
   returns to idle. Reopen the chat and check the same links again. Compare a
   manual Grok chat with an automatically delegated chat using the same Model
   and Thinking option; each answer should appear once.
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
