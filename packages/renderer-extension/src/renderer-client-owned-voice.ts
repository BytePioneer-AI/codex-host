import {
  REALTIME_CALL_METHOD,
  filterRealtimeCallHeaders,
  isRealtimeCallId,
  realtimeCallIdFromLocation,
  realtimeCallResponseSchema,
} from "@codexhost/shared-contracts";
import {
  auditedAppInitialAssetPresent,
  loadedAssetNames,
  readCpaLiveVoiceHookConfig,
} from "./renderer-cpa-live-voice-hook.js";
import { cpaLiveVoicePreferenceAllowsInstall } from "./renderer-cpa-live-voice-preference.js";

export const CLIENT_OWNED_VOICE_VERSION = "26.1013.40934";
export const CLIENT_OWNED_VOICE_INITIAL_ASSET = "app-initial-90eb42395b7d.js";
export const CLIENT_OWNED_VOICE_SHARED_ASSET = "app-shared-52443cbe9ac4.js";
const HOOK_GLOBAL = "__codexhostClientOwnedVoiceV1";
type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object";
}

export interface NativeVoiceBridge {
  dispatchMessage(type: string, message: RecordValue): void;
  subscribe(type: string, listener: (message: unknown) => void): () => void;
}

function requestHost(bridge: NativeVoiceBridge, params: RecordValue): Promise<unknown> {
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
        request: { id, method: REALTIME_CALL_METHOD, params },
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

/** Only the audited native WebFetch voice bootstrap is forwarded. Other native
 * requests retain their receiver, arguments, authentication and error behavior.
 */
export function wrapClientOwnedVoiceFetch(
  client: NativeVoiceFetch,
  bridge: NativeVoiceBridge,
  enabled: () => boolean,
  responseError: (response: Response, url: string) => Promise<unknown>,
): () => void {
  const original = client.fetch;
  const wrapped: NativeVoiceFetch["fetch"] = async function (this: NativeVoiceFetch, url, options) {
    if (
      typeof url !== "string" ||
      url.split("?")[0] !== "/wham/realtime/calls" ||
      options?.method !== "POST" ||
      !enabled()
    )
      return original.call(this, url, options);
    if (typeof options.body !== "string") throw new Error("Unsupported native voice call request");
    options.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void requestHost(bridge, { operation: "cancel", requestId }).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = realtimeCallResponseSchema.parse(
        await requestHost(bridge, {
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
          await requestHost(bridge, { operation: "hangup", callId });
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

/** Desktop 26.1013 always creates calls in the Renderer. Its native WebFetch
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
  if (!config || !cpaLiveVoicePreferenceAllowsInstall(target))
    return { status: "disabled", dispose() {} };
  if (config.desktopVersion !== undefined && config.desktopVersion !== CLIENT_OWNED_VOICE_VERSION)
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
    if (
      auditedAppInitialAssetPresent(names, CLIENT_OWNED_VOICE_INITIAL_ASSET) &&
      auditedAppInitialAssetPresent(names, CLIENT_OWNED_VOICE_SHARED_ASSET)
    ) {
      try {
        const module = await importModule(`app://-/assets/${CLIENT_OWNED_VOICE_SHARED_ASSET}`);
        if (disposed) return;
        const fetchClass = module.urt;
        const bridgeClass = module.mPt;
        if (!object(fetchClass) && typeof fetchClass !== "function") throw new Error();
        if (!object(bridgeClass) && typeof bridgeClass !== "function") throw new Error();
        const client = Reflect.get(fetchClass, "getInstance").call(fetchClass);
        const bridge = Reflect.get(bridgeClass, "getInstance").call(bridgeClass);
        if (
          typeof client?.fetch !== "function" ||
          typeof bridge?.dispatchMessage !== "function" ||
          typeof bridge?.subscribe !== "function" ||
          typeof module.grt !== "function"
        )
          throw new Error();
        restore = wrapClientOwnedVoiceFetch(
          client,
          bridge,
          () => cpaLiveVoicePreferenceAllowsInstall(target),
          module.grt as (response: Response, url: string) => Promise<unknown>,
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
