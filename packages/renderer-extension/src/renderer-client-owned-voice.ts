import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { chatVoiceDebug } from "./renderer-chat-voice-debug.js";
import {
  REALTIME_CALL_METHOD,
  filterRealtimeCallHeaders,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
  realtimeCallResponseSchema,
} from "@codexhost/shared-contracts";
import { loadedAssetNames, readCpaLiveVoiceHookConfig } from "./renderer-cpa-live-voice-hook.js";
import {
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
} from "./renderer-cpa-live-voice-preference.js";
import { RENDERER_NEW_THREAD_PREFERENCE_KEY } from "./renderer-new-thread-preference.js";

export const CLIENT_OWNED_VOICE_VERSION = "26.1016.62342";
export const CLIENT_OWNED_VOICE_INITIAL_ASSET = "app-initial-dddef47d6ef6.js";
export const CLIENT_OWNED_VOICE_SHARED_ASSET = "app-shared-fc3316d48427.js";
export const CLIENT_OWNED_VOICE_SERVICES = "ist";
export const CLIENT_OWNED_VOICE_OVERLAY_ASSET = "avatar-overlay-native-page-ef8332c6a2fb.js";
export const CLIENT_OWNED_VOICE_ASSETS = [
  {
    version: CLIENT_OWNED_VOICE_VERSION,
    initial: CLIENT_OWNED_VOICE_INITIAL_ASSET,
    shared: CLIENT_OWNED_VOICE_SHARED_ASSET,
    overlay: CLIENT_OWNED_VOICE_OVERLAY_ASSET,
  },
  {
    version: "26.1016.61520",
    initial: "app-initial-c95ddb62696e.js",
    shared: "app-shared-2eda13eb7044.js",
    overlay: "avatar-overlay-native-page-fcc17283519a.js",
  },
];
const SHARED_INIT = "Oit";
const SHARED_FETCH = "Eit";
const SHARED_BRIDGE = "AFt";
const SHARED_RESPONSE_ERROR = "Mit";
const HOOK_GLOBAL = "__codexhostClientOwnedVoiceV1";
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

export interface NativeVoiceBridge {
  dispatchMessage(type: string, message: RecordValue): void;
  subscribe(type: string, listener: (message: unknown) => void): () => void;
}

export function requestVoiceHost(
  bridge: NativeVoiceBridge,
  params: RecordValue,
  method: string = REALTIME_CALL_METHOD,
): Promise<unknown> {
  const id = `codexhost-voice:${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Voice gateway did not answer in time"));
    }, 30_000);
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    unsubscribe = bridge.subscribe("mcp-response", (event) => {
      if (
        !object(event) ||
        event.hostId !== "local" ||
        !object(event.message) ||
        event.message.id !== id
      )
        return;
      done();
      if (event.message.error) reject(new Error("Configured voice gateway request failed"));
      else resolve(event.message.result);
    });
    try {
      bridge.dispatchMessage("mcp-request", {
        hostId: "local",
        request: { id, method, params },
      });
    } catch {
      done();
      reject(new Error("Voice gateway Host connection is unavailable"));
    }
  });
}

interface NativeVoiceFetch {
  fetch(url: string, options?: RequestInit): Promise<Response>;
}

/** Desktop Chat/Work toggle persistence. Missing means Chat. */
export const HOME_COMPOSER_MODE_STORAGE_KEY = "home-composer-mode-v1";

function backendModelName(headers?: HeadersInit): string {
  const raw = new Headers(headers).get("x-codex-turn-metadata");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { backend_model_name?: unknown };
    return typeof parsed.backend_model_name === "string" ? parsed.backend_model_name : "";
  } catch {
    return "";
  }
}

/** Coding / Harness backend models. Speech `gpt-live*` is used by Chat and Work. */
function isWorkBackendModel(name: string): boolean {
  const model = name.toLowerCase();
  if (!model) return false;
  if (model.startsWith("codexhost/")) return true;
  return model.includes("codex") && !model.includes("gpt-live");
}

function visibleWorkComposer(owner: object): boolean {
  const document = (owner as { document?: Document }).document;
  if (!document?.querySelectorAll) return false;
  const work = [...document.querySelectorAll("[data-codex-composer-root]")].some((element) => {
    const box = element.getBoundingClientRect?.() ?? { width: 0 };
    return box.width > 0 && !element.closest?.("[hidden], [inert]");
  });
  return work && document.querySelectorAll("[data-chatgpt-composer]").length === 0;
}

function selectedWorkTab(owner: object): boolean {
  const document = (owner as { document?: Document }).document;
  if (!document?.querySelectorAll) return false;
  const controls = document.querySelectorAll("button, [role='tab'], a");
  let workSelected = false;
  let chatSelected = false;
  for (const element of controls) {
    const name = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    if (name !== "Chat" && name !== "Work") continue;
    const selected =
      element.getAttribute("aria-selected") === "true" ||
      element.getAttribute("aria-pressed") === "true" ||
      element.getAttribute("data-state") === "active" ||
      element.getAttribute("data-state") === "on";
    if (!selected) continue;
    if (name === "Work") workSelected = true;
    if (name === "Chat") chatSelected = true;
  }
  return workSelected && !chatSelected;
}

export function isWorkComposerSurface(owner: object = globalThis): boolean {
  const storage = (owner as { localStorage?: Storage }).localStorage;
  try {
    const raw = storage?.getItem(HOME_COMPOSER_MODE_STORAGE_KEY);
    if (raw != null && raw !== "") {
      let value: unknown = raw;
      if (raw.startsWith("{") || raw.startsWith('"') || raw.startsWith("[")) {
        try {
          value = JSON.parse(raw) as unknown;
        } catch {
          value = raw;
        }
      }
      if (value === "work") return true;
      if (value === "chat") return false;
    }
  } catch {
    /* Fall through to the visible Work/Chat control. */
  }
  return selectedWorkTab(owner) || visibleWorkComposer(owner);
}

function selectedComposerModel(owner: object): string {
  const routing = (
    owner as {
      __codexhostHostRoutingV1?: {
        forComposer(): { policy: { selectedModel(): string | undefined } } | undefined;
      };
    }
  ).__codexhostHostRoutingV1;
  try {
    const model = routing?.forComposer()?.policy.selectedModel();
    return typeof model === "string" ? model : "";
  } catch {
    return "";
  }
}

let lastVoiceProductExperience: string | undefined;

export function rememberVoiceProductExperience(request: unknown): void {
  const experience = object(request) ? request.productExperience : undefined;
  lastVoiceProductExperience =
    experience === "chat" || experience === "work" ? experience : undefined;
}

export function lastVoiceLaunchProductExperience(): string | undefined {
  return lastVoiceProductExperience;
}

export function isExternalHarnessComposer(owner: object = globalThis): boolean {
  if (lastVoiceProductExperience === "chat") return false;
  if (selectedComposerModel(owner).startsWith("codexhost/")) return true;
  if (lastVoiceProductExperience !== "work") return false;
  const storage = (owner as { localStorage?: Storage }).localStorage;
  if (!storage) return false;
  try {
    const parsed = JSON.parse(storage.getItem(RENDERER_NEW_THREAD_PREFERENCE_KEY) ?? "") as {
      lastAgent?: unknown;
    };
    return (
      typeof parsed.lastAgent === "string" &&
      parsed.lastAgent !== "" &&
      parsed.lastAgent !== "codex"
    );
  } catch {
    return false;
  }
}

/** Only the audited native WebFetch voice bootstrap is forwarded. Other native
 * requests retain their receiver, arguments, authentication and error behavior.
 */
export function wrapClientOwnedVoiceFetch(
  client: NativeVoiceFetch,
  bridge: NativeVoiceBridge,
  workOverride: () => boolean,
  responseError: (response: Response, url: string) => Promise<unknown>,
  chatOverride: () => boolean = () => false,
  workSurface: () => boolean = () => isWorkComposerSurface(),
  externalHarness: () => boolean = () => isExternalHarnessComposer(),
): () => void {
  const original = client.fetch;
  const wrapped: NativeVoiceFetch["fetch"] = async function (this: NativeVoiceFetch, url, options) {
    if (
      typeof url !== "string" ||
      url.split("?")[0] !== "/wham/realtime/calls" ||
      options?.method !== "POST"
    )
      return original.call(this, url, options);
    const experience = lastVoiceLaunchProductExperience();
    const chat = experience === "chat";
    const model = backendModelName(options.headers);
    // The overlay has no Composer; explicit launch ownership also covers Work
    // models without "codex" in their name and starts without model metadata.
    const work = !chat && (experience === "work" || isWorkBackendModel(model) || workSurface());
    // The avatar overlay has no primary Composer routing state. The native
    // request's explicit Harness model still owns its gateway bootstrap there.
    const external = !chat && (model.startsWith("codexhost/") || externalHarness());
    const gateway = external || (work ? workOverride() : chatOverride());
    chatVoiceDebug("wham-create", {
      work,
      external,
      route: gateway ? "gateway" : "desktop",
      productExperience: experience ?? "unset",
    });
    if (!gateway) {
      if (!external && !work)
        // Native Chat Instant Connect is Desktop's browser-voice stack
        // (fetchVoiceRequest → chatgpt.com/realtime/wm), not Codex /wham.
        chatVoiceDebug("chat-native-passthrough", {
          hasThreadId: new Headers(options.headers).has("Thread-Id"),
        });
      return original.call(this, url, options);
    }
    if (typeof options.body !== "string") throw new Error("Unsupported native voice call request");
    options.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void requestVoiceHost(bridge, { operation: "cancel", requestId }).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = realtimeCallResponseSchema.parse(
        await requestVoiceHost(bridge, {
          operation: "create",
          requestId,
          body: options.body,
          // Drop Desktop OAuth, ChatGPT account identity and cookies at the bridge
          // boundary; the Host allowlist repeats this check before sending.
          headers: filterRealtimeCallHeaders(Object.fromEntries(new Headers(options.headers))),
        }),
      );
      if (options.signal?.aborted) {
        const callId = realtimeCallIdFromLocation(result.headers.location ?? "");
        if (result.status >= 200 && result.status < 300 && isRealtimeCallId(callId))
          await requestVoiceHost(bridge, { operation: "hangup", callId });
        options.signal.throwIfAborted();
      }
      const response = new Response(result.status === 204 ? null : result.body, {
        status: result.status,
        headers: result.headers,
      });
      if (!response.ok) throw await responseError(response, url);
      return response;
    } catch (error) {
      cancel();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  };
  client.fetch = wrapped;
  return () => {
    if (client.fetch === wrapped) client.fetch = original;
  };
}

interface VoiceTarget {
  [key: string]: unknown;
  document?: ParentNode;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}
interface VoiceHook {
  status: "disabled" | "pending" | "active" | "unsupported";
  dispose(): void;
}

/** Desktop 26.1016 always creates calls in the Renderer. Its native WebFetch
 * singleton and message bridge are audited exports of the loaded shared module.
 */
export function installClientOwnedVoiceHook(
  options: {
    target?: VoiceTarget;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): VoiceHook {
  const target = options.target ?? (globalThis as unknown as VoiceTarget);
  const existing = target[HOOK_GLOBAL] as VoiceHook | undefined;
  if (existing) return existing;
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config) return { status: "disabled", dispose() {} };
  if (!supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, config.desktopVersion))
    return { status: "unsupported", dispose() {} };
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  const started = Date.now();
  const handle: VoiceHook = {
    status: "pending",
    dispose() {
      disposed = true;
      if (timer !== undefined) target.clearTimeout(timer);
      restore?.();
      if (target[HOOK_GLOBAL] === handle) Reflect.deleteProperty(target, HOOK_GLOBAL);
    },
  };
  target[HOOK_GLOBAL] = handle;
  const attempt = async (): Promise<void> => {
    if (disposed) return;
    const names = loadedAssetNames(target.document, target.performance);
    const assets = selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, names, config.desktopVersion);
    if (assets) {
      try {
        const module = await importModule(`app://-/assets/${assets.shared}`);
        if (disposed) return;
        // The shared chunk exports lazy bindings. Initialize WebFetch and its
        // message bridge before reading their singleton classes on document start.
        if (typeof module[SHARED_INIT] !== "function") throw new Error();
        (module[SHARED_INIT] as () => void)();
        const fetchClass = module[SHARED_FETCH];
        const bridgeClass = module[SHARED_BRIDGE];
        if (!object(fetchClass) && typeof fetchClass !== "function") throw new Error();
        if (!object(bridgeClass) && typeof bridgeClass !== "function") throw new Error();
        const client = Reflect.get(fetchClass, "getInstance").call(fetchClass);
        const bridge = Reflect.get(bridgeClass, "getInstance").call(bridgeClass);
        if (
          typeof client?.fetch !== "function" ||
          typeof bridge?.dispatchMessage !== "function" ||
          typeof bridge?.subscribe !== "function" ||
          typeof module[SHARED_RESPONSE_ERROR] !== "function"
        )
          throw new Error();
        restore = wrapClientOwnedVoiceFetch(
          client,
          bridge,
          () => cpaLiveVoicePreferenceAllowsInstall(target),
          module[SHARED_RESPONSE_ERROR] as (response: Response, url: string) => Promise<unknown>,
          () => chatLiveVoicePreferenceAllowsOverride(target),
          () => isWorkComposerSurface(target),
          () => isExternalHarnessComposer(target),
        );
        handle.status = "active";
      } catch {
        handle.status = "unsupported";
      }
      return;
    }
    if (Date.now() - started >= 60_000) {
      handle.status = "unsupported";
      return;
    }
    timer = target.setTimeout(() => void attempt(), 250);
  };
  void attempt();
  return handle;
}
