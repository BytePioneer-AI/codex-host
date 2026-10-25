import { selectVoiceAssets, supportsVoiceVersion } from "./renderer-voice-assets.js";
import { startNativeChatVoiceForRequest } from "./renderer-native-chat-voice.js";
import {
  CLIENT_OWNED_VOICE_ASSETS,
  rememberVoiceProductExperience,
} from "./renderer-client-owned-voice.js";
import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  loadedAssetNames,
  readCpaLiveVoiceHookConfig,
} from "./renderer-cpa-live-voice-hook.js";

const HOOK_GLOBAL = "__codexhostExternalVoiceLaunchV1";
const SHARED_ASSET = "app-shared-8bd9d0399038.js";
const LAUNCH_ASSETS = [
  ...CLIENT_OWNED_VOICE_ASSETS,
  {
    version: AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
    initial: AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
    shared: SHARED_ASSET,
    services: "fN",
  },
];
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The native overlay creates its Thread from collaborationMode.settings.model.
 * Capture the primary Composer's explicit selection before crossing that boundary.
 */
export function routeExternalVoiceLaunch(request: unknown, routing?: RendererHostRouting): unknown {
  rememberVoiceProductExperience(request);
  if (!routing || !isRecord(request) || request.source !== "composer_button_new_thread")
    return request;
  if (request.productExperience === "chat") return request;
  const hostId = request.hostId ?? "local";
  if (typeof hostId !== "string" || !hostId) return request;
  const route = routing.forComposer();
  if (!route || route.hostId !== hostId || routing.forHost(hostId) !== route) return request;
  const model = route.policy.selectedModel();
  if (!model?.startsWith("codexhost/")) return request;
  const mode = request.activeCollaborationMode;
  if (mode !== undefined && mode !== null && !isRecord(mode)) return request;
  const settings = isRecord(mode) ? mode.settings : undefined;
  if (settings !== undefined && settings !== null && !isRecord(settings)) return request;
  return {
    ...request,
    activeCollaborationMode: {
      ...(isRecord(mode) ? mode : { mode: "default" }),
      settings: {
        reasoning_effort: null,
        developer_instructions: null,
        ...(isRecord(settings) ? settings : {}),
        model,
      },
    },
  };
}

interface LaunchHook {
  status: "pending" | "active" | "unsupported" | "disabled";
  dispose(): void;
}

interface LaunchTarget {
  [key: string]: unknown;
  document?: ParentNode;
  performance?: Pick<Performance, "getEntriesByType">;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  __codexhostHostRoutingV1?: RendererHostRouting;
}

interface InstallOptions {
  target?: LaunchTarget;
  importModule?: (url: string) => Promise<RecordValue>;
}

/** Audited browser module export fN is the native services record. Individual
 * service RPC stubs reject mutation; replace only the voice service reference
 * with a forwarding Proxy. No Node/Electron APIs or RPC wire interception.
 */
export function installExternalVoiceLaunchHook(options: InstallOptions = {}): LaunchHook {
  const target = options.target ?? (globalThis as unknown as LaunchTarget);
  const existing = target[HOOK_GLOBAL] as LaunchHook | undefined;
  if (existing) return existing;
  const config = readCpaLiveVoiceHookConfig(target);
  if (!config) return { status: "disabled", dispose() {} };
  if (
    config.auditedDesktopVersion !== AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION ||
    config.auditedAppInitialAsset !== AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET ||
    (config.desktopVersion !== undefined &&
      config.desktopVersion !== config.auditedDesktopVersion &&
      !supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, config.desktopVersion))
  )
    return { status: "unsupported", dispose() {} };
  const importModule: (url: string) => Promise<RecordValue> =
    options.importModule ?? ((url: string) => import(url));
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  let module: RecordValue | undefined;
  const started = Date.now();
  const handle: LaunchHook = {
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
    try {
      const names = loadedAssetNames(target.document, target.performance);
      const assets = selectVoiceAssets(LAUNCH_ASSETS, names, config.desktopVersion);
      if (assets) {
        module ??= await importModule(`app://-/assets/${assets.shared}`);
        if (disposed) return;
        const services = module?.[assets.services];
        if (isRecord(services)) {
          const original = services.realtimeVoiceRuntime;
          if (typeof original === "function" || isRecord(original)) {
            const start: unknown = Reflect.get(original, "requestRealtimeStart");
            if (typeof start !== "function") {
              handle.status = "unsupported";
              return;
            }
            const launch = (...args: unknown[]): unknown => {
              let request = args[0];
              const chatStart = startNativeChatVoiceForRequest(request, target);
              if (chatStart) return chatStart;
              try {
                request = routeExternalVoiceLaunch(request, target.__codexhostHostRoutingV1);
              } catch {
                // Retired or disconnected owners cannot claim native traffic.
              }
              return Reflect.apply(start, original, [request, ...args.slice(1)]);
            };
            const wrapped = new Proxy(original, {
              get(service, key, receiver) {
                return key === "requestRealtimeStart"
                  ? launch
                  : Reflect.get(service, key, receiver);
              },
            });
            if (!Reflect.set(services, "realtimeVoiceRuntime", wrapped)) {
              handle.status = "unsupported";
              return;
            }
            restore = () => {
              if (services.realtimeVoiceRuntime === wrapped)
                services.realtimeVoiceRuntime = original;
            };
            handle.status = "active";
            return;
          }
        }
      }
    } catch {
      handle.status = "unsupported";
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
