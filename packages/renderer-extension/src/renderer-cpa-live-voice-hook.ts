import { cpaLiveVoicePreferenceAllowsInstall } from "./renderer-cpa-live-voice-preference.js";

/**
 * Runtime equivalent of durable-only `clientOwnsCall` for Codex Desktop
 * 26.1007.30912. Default on. Does not rewrite ASAR or copy Desktop source.
 *
 * Native: hostId === "durable" OR (app-server supports threadRealtimeExistingCall
 * AND Statsig gate 206132468). The capability is a version comparison, so the
 * hook forces that gate to false; the gate has no other reader in this build.
 */
export const CPA_LIVE_VOICE_HOOK_GLOBAL = "__codexhostCpaLiveVoiceHookV1";
export const AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION = "26.1007.30912";
export const AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET = "app-initial-6350d04672d0.js";
export const THREAD_REALTIME_EXISTING_CALL_GATE = "206132468";

type RecordValue = Record<string, unknown>;

export interface CpaLiveVoiceHookConfig {
  enabled: boolean;
  auditedDesktopVersion: string;
  auditedAppInitialAsset: string;
  desktopVersion?: string;
}

export type CpaLiveVoiceHookStatus = "disabled" | "pending" | "active" | "unsupported";

export interface CpaLiveVoiceStatsigClient {
  checkGate(name: string, ...rest: unknown[]): unknown;
}

export interface CpaLiveVoiceHookHandle {
  status: CpaLiveVoiceHookStatus;
  dispose(): void;
}

export interface InstallCpaLiveVoiceHookOptions {
  config?: CpaLiveVoiceHookConfig | null;
  resourceNames?: readonly string[];
  globalThis?: object;
  document?: ParentNode;
}

const originalCheckGate = new WeakMap<object, CpaLiveVoiceStatsigClient["checkGate"]>();
const DISCOVERY_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

export function readCpaLiveVoiceHookConfig(globalObject: object): CpaLiveVoiceHookConfig | null {
  const value = (globalObject as Record<string, unknown>)[CPA_LIVE_VOICE_HOOK_GLOBAL];
  if (!isRecord(value) || value.enabled !== true) return null;
  if (
    typeof value.auditedDesktopVersion !== "string" ||
    typeof value.auditedAppInitialAsset !== "string"
  ) {
    return null;
  }
  return {
    enabled: true,
    auditedDesktopVersion: value.auditedDesktopVersion,
    auditedAppInitialAsset: value.auditedAppInitialAsset,
    ...(typeof value.desktopVersion === "string" ? { desktopVersion: value.desktopVersion } : {}),
  };
}

export function auditedAppInitialAssetPresent(
  resourceNames: readonly string[],
  asset: string,
): boolean {
  return resourceNames.some((name) => {
    try {
      const url = new URL(name, "app://-/");
      return url.protocol === "app:" && url.hostname === "-" && url.pathname === `/assets/${asset}`;
    } catch {
      return false;
    }
  });
}

function resourceNamesFromPerformance(
  source: Pick<Performance, "getEntriesByType"> | undefined,
): string[] {
  const target = source ?? (typeof performance === "undefined" ? undefined : performance);
  if (!target || typeof target.getEntriesByType !== "function") return [];
  return target
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === "string");
}

/** Every loaded asset name this page exposes: resource timing plus script/link tags. */
export function loadedAssetNames(
  root: ParentNode | undefined,
  performanceSource?: Pick<Performance, "getEntriesByType">,
): string[] {
  const names = resourceNamesFromPerformance(performanceSource);
  if (!root || !("querySelectorAll" in root)) return names;
  for (const element of root.querySelectorAll("script[src], link[href]")) {
    const value = element.getAttribute("src") ?? element.getAttribute("href");
    if (value) names.push(value);
  }
  return names;
}

/** Statsig JS clients register on `__STATSIG__` (`instances` by SDK key, plus `firstInstance`). */
export function statsigClients(globalObject: object): CpaLiveVoiceStatsigClient[] {
  const registry = (globalObject as Record<string, unknown>).__STATSIG__;
  if (!isRecord(registry)) return [];
  const clients = new Set<unknown>(
    isRecord(registry.instances) ? Object.values(registry.instances) : [],
  );
  if (registry.firstInstance) clients.add(registry.firstInstance);
  return [...clients].filter(
    (client): client is CpaLiveVoiceStatsigClient =>
      isRecord(client) && typeof client.checkGate === "function",
  );
}

export function wrapCheckGate(client: CpaLiveVoiceStatsigClient): boolean {
  if (originalCheckGate.has(client)) return false;
  const original = client.checkGate;
  originalCheckGate.set(client, original);
  client.checkGate = function (this: unknown, name: string, ...rest: unknown[]) {
    return name === THREAD_REALTIME_EXISTING_CALL_GATE ? false : original.call(this, name, ...rest);
  };
  return true;
}

function restoreCheckGate(client: CpaLiveVoiceStatsigClient): void {
  const original = originalCheckGate.get(client);
  if (!original) return;
  client.checkGate = original;
  originalCheckGate.delete(client);
}

function configAllowsInstall(
  config: CpaLiveVoiceHookConfig,
  resourceNames: readonly string[],
): boolean {
  if (
    config.desktopVersion !== undefined &&
    config.desktopVersion !== config.auditedDesktopVersion
  ) {
    return false;
  }
  if (config.auditedDesktopVersion !== AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION) return false;
  if (config.auditedAppInitialAsset !== AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET) return false;
  return auditedAppInitialAssetPresent(resourceNames, config.auditedAppInitialAsset);
}

export function installCpaLiveVoiceHook(
  options: InstallCpaLiveVoiceHookOptions = {},
): CpaLiveVoiceHookHandle {
  const globalObject = options.globalThis ?? globalThis;
  const config =
    options.config === undefined ? readCpaLiveVoiceHookConfig(globalObject) : options.config;
  if (!config?.enabled || !cpaLiveVoicePreferenceAllowsInstall(globalObject)) {
    return { status: "disabled", dispose() {} };
  }
  const root = options.document ?? (globalObject as { document?: ParentNode }).document;
  const wrapped: CpaLiveVoiceStatsigClient[] = [];
  let disposed = false;
  let auditedAssetFound = false;
  const handle: CpaLiveVoiceHookHandle = {
    status: "pending",
    dispose() {
      disposed = true;
      for (const client of wrapped) restoreCheckGate(client);
      wrapped.length = 0;
    },
  };
  const attempt = (): boolean => {
    if (!auditedAssetFound) {
      const resourceNames = options.resourceNames ?? loadedAssetNames(root);
      auditedAssetFound = configAllowsInstall(config, resourceNames);
      if (!auditedAssetFound) return false;
    }
    for (const client of statsigClients(globalObject)) {
      if (wrapCheckGate(client)) wrapped.push(client);
    }
    if (wrapped.length === 0) return false;
    handle.status = "active";
    return true;
  };
  if (attempt()) return handle;
  if (options.resourceNames && !configAllowsInstall(config, options.resourceNames)) {
    handle.status = "unsupported";
    return handle;
  }
  // Document-start injection runs before the bundle constructs its Statsig client.
  const started = Date.now();
  const tick = (): void => {
    if (disposed || attempt()) return;
    if (Date.now() - started > DISCOVERY_TIMEOUT_MS) {
      handle.status = "unsupported";
      return;
    }
    globalThis.setTimeout(tick, 250);
  };
  globalThis.setTimeout(tick, 250);
  return handle;
}
