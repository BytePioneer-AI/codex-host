import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";
import { VOICE_GATEWAY_STATUS_METHOD } from "@codexhost/shared-contracts";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  CLIENT_OWNED_VOICE_SERVICES,
  CLIENT_OWNED_VOICE_VERSION,
  rememberVoiceProductExperience,
  requestVoiceHost,
  type NativeVoiceBridge,
} from "./renderer-client-owned-voice.js";
import { bindVoiceCapabilitySubscriptions } from "./renderer-voice-capability.js";
import {
  auditedAppInitialAssetPresent,
  loadedAssetNames,
  readCpaLiveVoiceHookConfig,
} from "./renderer-cpa-live-voice-hook.js";
import { cpaLiveVoicePreferenceAllowsInstall } from "./renderer-cpa-live-voice-preference.js";
import { isAvatarOverlayHref } from "./renderer-overlay-thread-isolation.js";

const GLOBAL = "__codexhostVoiceStartCapabilityV1";
export const VOICE_START_OVERLAY_ASSET = "avatar-overlay-native-page-fcc17283519a.js";
type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object";
type Start = (...args: unknown[]) => unknown;
type Binding = { dispose(): void; current(): boolean };
type Attempt = { binding?: Binding };

/** Only explicit local Work starts own the overlay's gateway qualification. */
export function gatewayVoiceStartRequest(request: unknown, workGateway: boolean): boolean {
  if (!record(request) || request.productExperience !== "work") return false;
  if (request.source === "composer_button_existing_thread") {
    if (!record(request.locator) || request.locator.hostId !== "local") return false;
  } else if (
    request.source !== "composer_button_new_thread" ||
    (request.hostId ?? "local") !== "local"
  )
    return false;
  const mode = request.activeCollaborationMode;
  const settings = record(mode) ? mode.settings : undefined;
  const model = record(settings) ? settings.model : undefined;
  return workGateway || (typeof model === "string" && model.startsWith("codexhost/"));
}

export function wrapGatewayVoiceStarter(
  start: Start,
  options: {
    qualifies(request: unknown): boolean;
    ready(): Promise<boolean>;
    prepare(allowed: () => boolean): Promise<Binding>;
    committed(binding: Binding): Promise<void>;
  },
) {
  let active: Attempt | undefined;
  return {
    async start(...args: unknown[]) {
      if (!options.qualifies(args[0])) return start(...args);
      if (active) throw new Error("Voice gateway start is already pending");
      const attempt: Attempt = {};
      active = attempt;
      const allowed = () => active === attempt && options.qualifies(args[0]);
      try {
        if (!(await options.ready())) throw new Error("Voice gateway is not ready");
        if (!allowed()) throw new Error("Voice gateway start was cancelled");
        attempt.binding = await options.prepare(allowed);
        await options.committed(attempt.binding);
        if (!allowed()) throw new Error("Voice gateway start was cancelled");
        if (!attempt.binding.current()) throw new Error("Voice starter subscription changed");
        // Desktop's useEffectEvent now sees the committed capability snapshot.
        // Its workspace, media, busy, treatment and account checks remain native.
        rememberVoiceProductExperience(args[0]);
        return await start(...args);
      } finally {
        attempt.binding?.dispose();
        if (active === attempt) active = undefined;
      }
    },
    cancel() {
      active?.binding?.dispose();
      active = undefined;
    },
  };
}

interface Target {
  [key: string]: unknown;
  location?: { href: string };
  document?: Document;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** Native overlay ancestors below the exported page, with exactly one starter
 * capability subscription. Composer and unrelated AppScope owners are excluded.
 */
export function overlayVoiceStarterFibers(document: Document, page: unknown): Set<RecordValue> {
  const fibers = new Set<RecordValue>();
  for (const element of document.querySelectorAll("[data-avatar-overlay-native-surface-id]")) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    const ancestors = committedReactAncestors(
      key && Object.getOwnPropertyDescriptor(element, key)?.value,
    );
    const boundary = ancestors.findIndex((fiber) => record(fiber) && fiber.type === page);
    if (boundary < 0) continue;
    for (const fiber of ancestors.slice(0, boundary)) if (record(fiber)) fibers.add(fiber);
  }
  return fibers;
}

/** The overlay registers a native callback through an immutable RPC stub. Wrap
 * that service reference, preserving registration arguments and cancellation.
 */
export function installVoiceStartCapabilityHook(
  options: {
    target?: Target;
    importModule?: (url: string) => Promise<RecordValue>;
  } = {},
): { status: string; dispose(): void } {
  const target = options.target ?? (globalThis as unknown as Target);
  if (target[GLOBAL]) return target[GLOBAL] as { status: string; dispose(): void };
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config || !isAvatarOverlayHref(target.location?.href ?? ""))
    return { status: "disabled", dispose() {} };
  if (config.desktopVersion !== undefined && config.desktopVersion !== CLIENT_OWNED_VOICE_VERSION)
    return { status: "unsupported", dispose() {} };
  const importModule = options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  let restore: (() => void) | undefined;
  const wrappers = new Set<ReturnType<typeof wrapGatewayVoiceStarter>>();
  const started = Date.now();
  const handle = {
    status: "pending",
    dispose() {
      disposed = true;
      target.clearTimeout(timer);
      for (const wrapper of wrappers) wrapper.cancel();
      restore?.();
      if (target[GLOBAL] === handle) Reflect.deleteProperty(target, GLOBAL);
    },
  };
  target[GLOBAL] = handle;
  const attempt = async () => {
    if (disposed) return;
    try {
      const names = loadedAssetNames(target.document, target.performance);
      if (
        [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET].every((asset) =>
          auditedAppInitialAssetPresent(names, asset),
        )
      ) {
        const shared = await importModule(`app://-/assets/${CLIENT_OWNED_VOICE_SHARED_ASSET}`);
        if (typeof shared.Oit !== "function") throw new Error("Voice bridge unavailable");
        shared.Oit();
        const services = shared[CLIENT_OWNED_VOICE_SERVICES];
        if (
          record(services) &&
          (record(services.realtimeVoiceRuntime) ||
            typeof services.realtimeVoiceRuntime === "function")
        ) {
          const original = services.realtimeVoiceRuntime;
          const register = Reflect.get(original, "registerRealtimeStarter");
          if (typeof register !== "function") throw new Error("Voice starter unavailable");
          const wrapped = new Proxy(original, {
            get(service, key, receiver) {
              if (key === "registerRealtimeStarter")
                return (start: Start, cancel: Start, ...rest: unknown[]) => {
                  if (typeof start !== "function" || typeof cancel !== "function")
                    throw new Error("Voice starter callback unavailable");
                  const wrapper = wrapGatewayVoiceStarter(start, {
                    qualifies: (request) =>
                      !disposed &&
                      !!readCpaLiveVoiceHookConfig(target) &&
                      gatewayVoiceStartRequest(
                        request,
                        cpaLiveVoicePreferenceAllowsInstall(target),
                      ),
                    ready: async () => {
                      const hook = target.__codexhostClientOwnedVoiceV1;
                      if (!record(hook) || hook.status !== "active") return false;
                      const bridgeClass = shared.AFt as { getInstance(): NativeVoiceBridge };
                      const result = await requestVoiceHost(
                        bridgeClass.getInstance(),
                        {},
                        VOICE_GATEWAY_STATUS_METHOD,
                      );
                      return result === true;
                    },
                    prepare: async (allowed) => {
                      const names = loadedAssetNames(target.document, target.performance);
                      if (!auditedAppInitialAssetPresent(names, VOICE_START_OVERLAY_ASSET))
                        throw new Error("Unaudited voice starter");
                      const [initial, overlay] = await Promise.all([
                        importModule(`app://-/assets/${CLIENT_OWNED_VOICE_INITIAL_ASSET}`),
                        importModule(`app://-/assets/${VOICE_START_OVERLAY_ASSET}`),
                      ]);
                      if (
                        typeof initial.njr !== "function" ||
                        typeof overlay.AvatarOverlayNativePage !== "function" ||
                        !target.document
                      )
                        throw new Error("Voice starter owner unavailable");
                      const document = target.document;
                      initial.njr();
                      return bindVoiceCapabilitySubscriptions(
                        () => overlayVoiceStarterFibers(document, overlay.AvatarOverlayNativePage),
                        initial.tjr as Parameters<typeof bindVoiceCapabilitySubscriptions>[1],
                        initial.uBr as Parameters<typeof bindVoiceCapabilitySubscriptions>[2],
                        allowed,
                        true,
                      );
                    },
                    // Wait for React's committed snapshot, including when the
                    // persistent overlay is hidden. A stale closure fails closed.
                    committed: async (binding) => {
                      for (let i = 0; i < 40 && !disposed && !binding.current(); i += 1)
                        await new Promise((resolve) => target.setTimeout(resolve, 50));
                    },
                  });
                  wrappers.add(wrapper);
                  return Reflect.apply(register, original, [
                    wrapper.start,
                    (...args: unknown[]) => {
                      wrapper.cancel();
                      return cancel(...args);
                    },
                    ...rest,
                  ]);
                };
              if (key === "unregisterRealtimeStarter")
                return (...args: unknown[]) => {
                  for (const wrapper of wrappers) wrapper.cancel();
                  wrappers.clear();
                  return Reflect.apply(Reflect.get(service, key), service, args);
                };
              return Reflect.get(service, key, receiver);
            },
          });
          if (disposed) return;
          if (!Reflect.set(services, "realtimeVoiceRuntime", wrapped))
            throw new Error("Voice service is not writable");
          restore = () => {
            if (services.realtimeVoiceRuntime === wrapped) services.realtimeVoiceRuntime = original;
          };
          handle.status = "active";
          return;
        }
      }
      if (Date.now() - started >= 60_000) {
        handle.status = "unsupported";
        return;
      }
      timer = target.setTimeout(() => void attempt(), 25);
    } catch {
      handle.status = "unsupported";
    }
  };
  void attempt();
  return handle;
}
