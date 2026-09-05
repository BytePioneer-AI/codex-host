import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { HarnessAdapter, HarnessError } from "@codexhost/harness-adapter";
import type { HarnessPluginContext, HarnessPluginModule } from "@codexhost/harness-adapter/plugin";
import {
  HARNESS_PLUGIN_API_VERSION,
  HARNESS_PLUGIN_LIMIT,
  HARNESS_PLUGIN_MANIFEST_MAX_BYTES,
  harnessPluginDescriptorSchema,
  harnessPluginManifestSchema,
  type HarnessPluginDescriptor,
  type HarnessPluginManifest,
} from "@codexhost/shared-contracts";

import { HarnessPluginRegistry } from "./harness-plugin-registry.js";
import {
  pluginResourcePath,
  readPluginConfiguration,
  readPluginFile,
  readPluginIcon,
} from "./plugin-files.js";

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
  /** Prevent conflicts with explicitly injected Adapters, e.g. test fixtures. */
  reservedIds?: ReadonlySet<string>;
  loadTimeoutMs?: number;
  /** Defaults to true. Disable only when the caller intentionally needs cold instances. */
  warmup?: boolean;
  /** Dedicated runtime owners (e.g. a Broker) may instantiate only their requested plugin. */
  onlyIds?: ReadonlySet<string>;
  diagnose?: (diagnostic: HarnessPluginDiagnostic) => void;
}

interface Candidate {
  root: string;
  manifest: HarnessPluginManifest;
  enabled: boolean;
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAdapter(value: unknown): value is HarnessAdapter {
  if (!value || typeof value !== "object") return false;
  return ["inspect", "open", "close"].every((key) => typeof Reflect.get(value, key) === "function");
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
): HarnessAdapter {
  const error: HarnessError = {
    code: "unavailable",
    message: `Harness plugin is unavailable (${code})`,
    retryable: false,
    stage: "pluginLoad",
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
): Promise<HarnessAdapter> {
  const { manifest } = candidate;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const entry = await pluginResourcePath(candidate.root, manifest.entry);
    if (!/\.(?:mjs|js)$/u.test(entry))
      throw new Error("Plugin entry must be an ESM JavaScript module");
    const module: unknown = await import(pathToFileURL(entry).href);
    if (expired) return undefined;
    if (
      !module ||
      typeof module !== "object" ||
      typeof Reflect.get(module, "createHarnessAdapter") !== "function"
    ) {
      throw new Error("Plugin entry has no Adapter factory");
    }
    const value: unknown = await (module as HarnessPluginModule).createHarnessAdapter({
      ...context,
      environment: Object.freeze({ ...context.environment }),
    });
    if (expired || !isAdapter(value) || value.harnessId !== manifest.id) {
      await closeCandidate(value).catch(() => diagnose({ id: manifest.id, code: "cleanupFailed" }));
      throw new Error("Plugin Adapter is invalid or expired");
    }
    if (warmup) {
      void Promise.resolve()
        .then(async () => {
          await (module as HarnessPluginModule).warmup?.(value);
        })
        .catch(() => diagnose({ id: manifest.id, code: "warmupFailed" }));
    }
    return value;
  })();
  try {
    const adapter = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new PluginLoadTimeout());
        }, timeoutMs);
      }),
    ]);
    if (!adapter) throw new PluginLoadTimeout();
    return adapter;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class PluginLoadTimeout extends Error {}

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
  const candidates: Candidate[] = [];
  const enabledIds = new Set<string>();
  const roots = new Set<string>();
  for (const configuredRoot of options.roots) {
    if (!path.isAbsolute(configuredRoot)) {
      diagnose({ code: "invalidRoot" });
      continue;
    }
    let root: string;
    try {
      root = await realpath(configuredRoot);
      if (roots.has(root)) continue;
      roots.add(root);
    } catch (error) {
      if (!missingFile(error)) diagnose({ code: "invalidRoot" });
      continue;
    }
    let enabled: Set<string>;
    try {
      enabled = new Set((await readPluginConfiguration(root)).enabled);
    } catch (error) {
      if (!missingFile(error)) diagnose({ code: "invalidConfiguration" });
      continue;
    }
    for (const id of enabled) enabledIds.add(id);
    try {
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name));
      if (directories.length > HARNESS_PLUGIN_LIMIT) {
        diagnose({ code: "invalidRoot" });
        continue;
      }
      for (const directory of directories) {
        try {
          const file = await pluginResourcePath(root, `${directory.name}/manifest.json`);
          const pluginRoot = await realpath(path.join(root, directory.name));
          // A manifest symlink into another plugin is not the owning plugin's manifest.
          await pluginResourcePath(pluginRoot, "manifest.json");
          const manifest = harnessPluginManifestSchema.parse(
            JSON.parse(
              (await readPluginFile(file, HARNESS_PLUGIN_MANIFEST_MAX_BYTES)).toString("utf8"),
            ),
          );
          candidates.push({ root: pluginRoot, manifest, enabled: enabled.has(manifest.id) });
        } catch {
          diagnose({ code: "invalidManifest" });
        }
      }
    } catch {
      diagnose({ code: "invalidRoot" });
    }
  }
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
    if (counts.get(manifest.id) !== 1 || options.reservedIds?.has(manifest.id)) {
      if (!conflicted.has(manifest.id)) diagnose({ id: manifest.id, code: "duplicateId" });
      conflicted.add(manifest.id);
      continue;
    }
    pending.push(candidate);
  }
  // Imports/factories share a deadline rather than N serial timeout windows.
  // Four workers let healthy plugins finish beside a slow asynchronous import.
  // Filesystem discovery and synchronous plugin execution are not preemptible.
  const deadline = Date.now() + timeoutMs;
  let next = 0;
  const loaded = new Map<
    Candidate,
    { descriptor: HarnessPluginDescriptor; adapter: HarnessAdapter }
  >();
  const worker = async (): Promise<void> => {
    for (;;) {
      const candidate = pending[next++];
      if (!candidate) return;
      const { manifest } = candidate;
      const descriptor = harnessPluginDescriptorSchema.parse({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.links ? { links: manifest.links } : {}),
      });
      let adapter: HarnessAdapter;
      let failure: HarnessPluginDiagnosticCode | undefined;
      if (manifest.adapterApiVersion !== HARNESS_PLUGIN_API_VERSION) {
        failure = "incompatibleVersion";
        adapter = unavailableAdapter(descriptor, failure);
      } else {
        try {
          if (manifest.icon) descriptor.icon = await readPluginIcon(candidate.root, manifest.icon);
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new PluginLoadTimeout();
          adapter = await loadAdapter(
            candidate,
            options.context,
            remaining,
            diagnose,
            options.warmup !== false,
          );
        } catch (error) {
          failure = error instanceof PluginLoadTimeout ? "loadTimeout" : "loadFailed";
          adapter = unavailableAdapter(descriptor, failure);
        }
      }
      if (failure) diagnose({ id: manifest.id, code: failure });
      loaded.set(candidate, { descriptor, adapter });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
  for (const candidate of pending) {
    const entry = loaded.get(candidate);
    if (entry) registry.register(entry.descriptor, entry.adapter);
  }
  return registry;
}
