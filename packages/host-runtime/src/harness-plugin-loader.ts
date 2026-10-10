import { pathToFileURL } from "node:url";

import type { HarnessAdapter, HarnessError } from "@codexhost/harness-adapter";
import type {
  HarnessPluginContext,
  HarnessPluginModule,
  HarnessUsageStatisticsAdapter,
  HarnessUsageStatisticsPluginModule,
} from "@codexhost/harness-adapter/plugin";

import {
  HARNESS_PLUGIN_API_VERSION,
  HARNESS_PLUGIN_LIMIT,
  harnessPluginDescriptorSchema,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import {
  discoverHarnessPlugins,
  pluginResourcePath,
  readPluginIcon,
  type InstalledHarnessPlugin,
} from "@codexhost/harness-plugin-files";

import { HarnessPluginRegistry } from "./harness-plugin-registry.js";

export type HarnessPluginDiagnosticCode =
  | "invalidRoot"
  | "invalidConfiguration"
  | "invalidManifest"
  | "duplicateId"
  | "notFound"
  | "incompatibleVersion"
  | "loadFailed"
  | "loadTimeout"
  | "warmupFailed"
  | "cleanupFailed";

export interface HarnessPluginDiagnostic {
  code: HarnessPluginDiagnosticCode;
  id?: string;
}

export interface LoadHarnessPluginsOptions {
  /** Absolute trusted roots only. Each root grants execution through enabled.json. */
  roots: readonly string[];
  context: HarnessPluginContext;
  /** Local, persisted entrypoints; requested only for opted-in plugins. */
  launchCommandForPlugin?: (id: string) => Promise<string | undefined>;
  /** Prevent conflicts with explicitly injected Adapters, e.g. test fixtures. */
  reservedIds?: ReadonlySet<string>;
  /** Bound for one plugin's asynchronous import and factory. Defaults to 10s. */
  loadTimeoutMs?: number;
  /** Stop taking new candidates and cancel in-flight import/factory waits. */
  signal?: AbortSignal;
  /** Defaults to true. Disable only when the caller intentionally needs cold instances. */
  warmup?: boolean;
  /** Dedicated runtime owners (e.g. a Broker) may instantiate only their requested plugin. */
  onlyIds?: ReadonlySet<string>;
  /** A GUI proxy loads usage plugins only; the shared owner loads Session adapters. */
  sessionPlugins?: boolean;
  /** Load statistics-only plugins first and publish their settled registry before Session
   * plugins start. Ownership/cleanup remains with the returned registry.
   */
  onUsageAdaptersLoaded?: (adapters: ReadonlyMap<string, HarnessUsageStatisticsAdapter>) => void;
  diagnose?: (diagnostic: HarnessPluginDiagnostic) => void;
}

type Candidate = InstalledHarnessPlugin;
type PluginAdapter = HarnessAdapter | HarnessUsageStatisticsAdapter;

function hasValidSessionUsage(value: object): boolean {
  const capability: unknown = Reflect.get(value, "sessionUsage");
  return (
    capability === undefined ||
    (capability !== null &&
      typeof capability === "object" &&
      ["observe", "read"].every((key) => typeof Reflect.get(capability, key) === "function") &&
      ["requestOptions", "shouldForwardNotification", "reset"].every(
        (key) =>
          Reflect.get(capability, key) === undefined ||
          typeof Reflect.get(capability, key) === "function",
      ))
  );
}

function isAdapter(value: unknown): value is HarnessAdapter {
  if (!value || typeof value !== "object") return false;
  return (
    hasValidSessionUsage(value) &&
    ["inspect", "open", "close"].every((key) => typeof Reflect.get(value, key) === "function")
  );
}

function isUsageAdapter(value: unknown): value is HarnessUsageStatisticsAdapter {
  if (!value || typeof value !== "object" || typeof Reflect.get(value, "close") !== "function")
    return false;
  const capability: unknown = Reflect.get(value, "usageStatistics");
  return (
    hasValidSessionUsage(value) &&
    !!capability &&
    typeof capability === "object" &&
    ["listSources", "readSource"].every(
      (key) => typeof Reflect.get(capability, key) === "function",
    ) &&
    !("open" in value) &&
    !("inspect" in value)
  );
}

async function closeCandidate(value: unknown): Promise<void> {
  if (value && typeof value === "object") {
    const close: unknown = Reflect.get(value, "close");
    if (typeof close === "function") await Reflect.apply(close, value, []);
  }
}

function unavailableAdapter(
  descriptor: HarnessPluginDescriptor,
  code: HarnessPluginDiagnosticCode,
): PluginAdapter {
  const error: HarnessError = {
    code: "unavailable",
    message: `Harness plugin is unavailable (${code})`,
    retryable: false,
    stage: "pluginLoad",
  };
  if (descriptor.kind === "usage")
    return {
      harnessId: descriptor.id,
      usageStatistics: {
        listSources: async () => {
          throw new Error(error.message);
        },
        readSource: async () => {
          throw new Error(error.message);
        },
      },
      close: async () => undefined,
    };
  return {
    harnessId: descriptor.id,
    inspect: async () => ({ status: "unavailable", error }),
    open: async () => ({ ok: false, error }),
    close: async () => undefined,
  };
}

/** An asynchronous timeout cannot sandbox synchronous or process-wide plugin failures. */
async function loadAdapter(
  candidate: Candidate,
  context: HarnessPluginContext,
  timeoutMs: number,
  diagnose: (diagnostic: HarnessPluginDiagnostic) => void,
  warmup: boolean,
  signal?: AbortSignal,
): Promise<PluginAdapter> {
  const { manifest } = candidate;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const operation = (async () => {
    const entry = await pluginResourcePath(candidate.root, manifest.entry);
    if (!/\.(?:mjs|js)$/u.test(entry))
      throw new Error("Plugin entry must be an ESM JavaScript module");
    const module: unknown = await import(pathToFileURL(entry).href);
    if (expired) return undefined;
    const factory =
      manifest.kind === "usage" ? "createUsageStatisticsAdapter" : "createHarnessAdapter";
    if (
      !module ||
      typeof module !== "object" ||
      typeof Reflect.get(module, factory) !== "function"
    ) {
      throw new Error("Plugin entry has no Adapter factory");
    }
    const input = { ...context, environment: Object.freeze({ ...context.environment }) };
    const value =
      manifest.kind === "usage"
        ? await (module as HarnessUsageStatisticsPluginModule).createUsageStatisticsAdapter(input)
        : await (module as HarnessPluginModule).createHarnessAdapter(input);
    const valid = manifest.kind === "usage" ? isUsageAdapter(value) : isAdapter(value);
    if (expired || !valid || value.harnessId !== manifest.id) {
      await closeCandidate(value).catch(() => diagnose({ id: manifest.id, code: "cleanupFailed" }));
      throw new Error("Plugin Adapter is invalid or expired");
    }
    if (warmup && isAdapter(value)) {
      void Promise.resolve()
        .then(async () => {
          await (module as HarnessPluginModule).warmup?.(value);
        })
        .catch(() => diagnose({ id: manifest.id, code: "warmupFailed" }));
    }
    return value;
  })();
  try {
    const races: Array<Promise<PluginAdapter | undefined>> = [
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new PluginLoadTimeout());
        }, timeoutMs);
      }),
    ];
    if (signal) {
      races.push(
        new Promise((_, reject) => {
          onAbort = () => {
            expired = true;
            reject(new PluginLoadCancelled());
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    const adapter = await Promise.race(races);
    if (!adapter) throw new PluginLoadTimeout();
    return adapter;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

class PluginLoadTimeout extends Error {}
class PluginLoadCancelled extends Error {}

/** Discover all manifests before importing any module, so duplicate IDs never win a race. */
export async function loadHarnessPlugins(
  options: LoadHarnessPluginsOptions,
): Promise<HarnessPluginRegistry> {
  const timeoutMs = options.loadTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Plugin load timeout must be between 1 and 60000 milliseconds");
  }
  if (options.roots.length > 8) throw new Error("Too many Harness plugin roots");
  const registry = new HarnessPluginRegistry();
  // Diagnostics contain stable codes and public identity only, never module errors,
  // filesystem paths, configuration values, or credentials supplied by plugins.
  const diagnose = (diagnostic: HarnessPluginDiagnostic): void => {
    try {
      options.diagnose?.(diagnostic);
    } catch {
      /* Diagnostics cannot change loading. */
    }
  };
  const { plugins: candidates, enabledIds } = await discoverHarnessPlugins(options.roots, (code) =>
    diagnose({ code }),
  );
  const counts = new Map<string, number>();
  for (const { manifest } of candidates)
    counts.set(manifest.id, (counts.get(manifest.id) ?? 0) + 1);
  for (const id of enabledIds) {
    if (!counts.has(id)) diagnose({ id, code: "notFound" });
  }
  if (candidates.length > HARNESS_PLUGIN_LIMIT) {
    diagnose({ code: "invalidRoot" });
    return registry;
  }
  const conflicted = new Set<string>();
  const pending: Candidate[] = [];
  for (const candidate of candidates) {
    const { manifest } = candidate;
    if (!candidate.enabled || (options.onlyIds && !options.onlyIds.has(manifest.id))) continue;
    if (options.sessionPlugins === false && manifest.kind !== "usage") continue;
    if (counts.get(manifest.id) !== 1 || options.reservedIds?.has(manifest.id)) {
      if (!conflicted.has(manifest.id)) diagnose({ id: manifest.id, code: "duplicateId" });
      conflicted.add(manifest.id);
      continue;
    }
    pending.push(candidate);
  }
  // Each plugin gets a full import/factory budget. Four workers overlap a slow
  // neighbor without shrinking later plugins to whatever time remains.
  // Filesystem discovery and synchronous plugin execution are not preemptible.
  if (options.signal?.aborted) return registry;
  let next = 0;
  let batch = pending;
  const loaded = new Map<
    Candidate,
    { descriptor: HarnessPluginDescriptor; adapter: PluginAdapter }
  >();
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const candidate = batch[next++];
      if (!candidate) return;
      if (options.signal?.aborted) return;
      const { manifest } = candidate;
      const descriptor = harnessPluginDescriptorSchema.parse({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.kind ? { kind: manifest.kind } : {}),
        ...(manifest.launchCommand && !options.context.managedRemoteHost
          ? { launchCommand: true }
          : {}),
        ...(manifest.iconStyle ? { iconStyle: manifest.iconStyle } : {}),
        ...(manifest.links ? { links: manifest.links } : {}),
        ...(manifest.installation ? { installation: manifest.installation } : {}),
        ...(manifest.notice ? { notice: manifest.notice } : {}),
      });
      let adapter: PluginAdapter;
      let failure: HarnessPluginDiagnosticCode | undefined;
      if (manifest.adapterApiVersion !== HARNESS_PLUGIN_API_VERSION) {
        failure = "incompatibleVersion";
        adapter = unavailableAdapter(descriptor, failure);
      } else {
        try {
          if (manifest.icon) descriptor.icon = await readPluginIcon(candidate.root, manifest.icon);
          const launchCommand = descriptor.launchCommand
            ? await options.launchCommandForPlugin?.(manifest.id)
            : undefined;
          adapter = await loadAdapter(
            candidate,
            { ...options.context, ...(launchCommand ? { launchCommand } : {}) },
            timeoutMs,
            diagnose,
            options.warmup !== false,
            options.signal,
          );
          if (options.signal?.aborted) {
            await adapter.close().catch(() => diagnose({ id: manifest.id, code: "cleanupFailed" }));
            return;
          }
        } catch (error) {
          if (error instanceof PluginLoadCancelled) return;
          failure = error instanceof PluginLoadTimeout ? "loadTimeout" : "loadFailed";
          adapter = unavailableAdapter(descriptor, failure);
        }
      }
      if (failure) diagnose({ id: manifest.id, code: failure });
      loaded.set(candidate, { descriptor, adapter });
    }
  };
  const batches = options.onUsageAdaptersLoaded
    ? [
        pending.filter((c) => c.manifest.kind === "usage"),
        pending.filter((c) => c.manifest.kind !== "usage"),
      ]
    : [pending];
  for (const [index, candidates] of batches.entries()) {
    batch = candidates;
    next = 0;
    await Promise.all(Array.from({ length: Math.min(4, batch.length) }, () => worker()));
    for (const candidate of batch) {
      const entry = loaded.get(candidate);
      if (entry) await registry.register(entry.descriptor, entry.adapter);
    }
    if (index === 0) options.onUsageAdaptersLoaded?.(registry.usageAdapters);
  }
  return registry;
}
