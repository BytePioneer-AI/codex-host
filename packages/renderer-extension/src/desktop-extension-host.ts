import {
  resolveDesktopExtensionSlots,
  type DesktopExtensionDefine,
  type DesktopExtensionDefinitionV1,
  type DesktopExtensionDispose,
  type DesktopExtensionSettingField,
  type DesktopExtensionSlot,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import {
  cloneStorageValues,
  createDesktopExtensionApi,
  type DesktopExtensionAssetsApi,
  type DesktopExtensionBackendApi,
  type DesktopExtensionBridge,
  type DesktopExtensionRuntimeApiV1,
  type DesktopExtensionSettingsPageContribution,
  type DesktopExtensionStorageApi,
} from "./desktop-extension-api.js";

export interface DesktopExtensionEntry {
  id: string;
  hash: string;
  slots: DesktopExtensionSlot[];
  name?: string | { readonly en: string; readonly "zh-CN": string };
  settingsSchema?: readonly DesktopExtensionSettingField[];
  defineScript?: (define: DesktopExtensionDefine) => void;
  style?: string;
  error?: string;
}

export interface RegisteredDesktopExtensionSettingsPage {
  readonly extensionId: string;
  readonly kind: "custom" | "schema";
  readonly revision: number;
  readonly title?: string | { readonly en: string; readonly "zh-CN": string };
  readonly page?: DesktopExtensionSettingsPageContribution;
  readonly schema?: readonly DesktopExtensionSettingField[];
}

interface Instance {
  hash: string;
  revision: number;
  state: DesktopExtensionStatus["state"];
  error?: string;
  name?: string | { readonly en: string; readonly "zh-CN": string };
  settingsSchema?: readonly DesktopExtensionSettingField[];
  resources?: ReturnType<typeof createDesktopExtensionApi>;
  dispose?: DesktopExtensionDispose;
  removeStyle?: () => void;
}

export interface DesktopExtensionHost {
  readonly version: 1;
  reconcile(entries: DesktopExtensionEntry[]): Promise<void>;
  status(): Record<string, DesktopExtensionStatus>;
  disposeAll(): Promise<void>;
  bind(bridge: DesktopExtensionBridge): () => void;
  getRegisteredSettingsPages(): readonly RegisteredDesktopExtensionSettingsPage[];
  subscribeSettingsPages(listener: () => void): () => void;
  createExtensionServices(extensionId: string): {
    readonly assets: DesktopExtensionAssetsApi;
    readonly storage: DesktopExtensionStorageApi;
    readonly backend: DesktopExtensionBackendApi;
  };
  notifyStorageChange(extensionId: string, values: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __codexhostDesktopExtensionsV1?: DesktopExtensionHost;
  }
}

const ACTIVATE_TIMEOUT_MS = 5_000;
const DISPOSE_TIMEOUT_MS = 1_000;
const ERROR_WINDOW_MS = 30_000;
const ERROR_LIMIT = 5;

async function withTimeout<T>(
  operation: () => T | Promise<T>,
  timeout: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function installStyle(document: Document, css: string): () => void {
  const Sheet = document.defaultView?.CSSStyleSheet;
  if (!Sheet) throw new Error("Desktop extension stylesheet unavailable");
  const sheet = new Sheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet);
  };
}

export function createDesktopExtensionHost(document: Document): DesktopExtensionHost {
  let bridge: DesktopExtensionBridge | undefined;
  let desired: DesktopExtensionEntry[] = [];
  let queue = Promise.resolve();
  let pendingReady: ReturnType<typeof setTimeout> | undefined;
  const instances = new Map<string, Instance>();
  const reports = new Map<string, DesktopExtensionStatus>();
  const customSettingsPages = new Map<
    string,
    { readonly page: DesktopExtensionSettingsPageContribution; readonly revision: number }
  >();
  const settingsPageListeners = new Set<() => void>();
  const storageListeners = new Map<string, Set<(values: Record<string, unknown>) => void>>();
  let settingsPageRevision = 0;
  let settingsPageBatchDepth = 0;
  let settingsPagesDirty = false;

  const notifySettingsPages = (): void => {
    if (settingsPageBatchDepth > 0) {
      settingsPagesDirty = true;
      return;
    }
    for (const listener of [...settingsPageListeners]) {
      try {
        listener();
      } catch {
        // One subscriber failure cannot block others.
      }
    }
  };

  const subscribeStorage = (
    extensionId: string,
    listener: (values: Record<string, unknown>) => void,
  ): (() => void) => {
    let bucket = storageListeners.get(extensionId);
    if (!bucket) {
      bucket = new Set();
      storageListeners.set(extensionId, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = storageListeners.get(extensionId);
      current?.delete(listener);
      if (current && current.size === 0) storageListeners.delete(extensionId);
    };
  };

  const notifyStorageChange = (extensionId: string, values: Record<string, unknown>): void => {
    const bucket = storageListeners.get(extensionId);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      try {
        listener(cloneStorageValues(values));
      } catch {
        // Individual subscriber errors are isolated by the extension API wrapper.
      }
    }
  };

  const registerSettingsPage = (
    extensionId: string,
    page: DesktopExtensionSettingsPageContribution,
  ): (() => void) => {
    const record = { page, revision: ++settingsPageRevision };
    customSettingsPages.set(extensionId, record);
    notifySettingsPages();
    return () => {
      if (customSettingsPages.get(extensionId) !== record) return;
      customSettingsPages.delete(extensionId);
      notifySettingsPages();
    };
  };

  const serialize = (operation: () => Promise<void>) => {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  };
  const message = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).slice(0, 2048);

  async function reclaim(extensionId: string, instance: Instance): Promise<string | undefined> {
    instance.resources?.stopDeliveries();
    const hadSchemaPage = Boolean(instance.settingsSchema && instance.settingsSchema.length > 0);
    let error: string | undefined;
    try {
      if (instance.dispose) await withTimeout(instance.dispose, DISPOSE_TIMEOUT_MS, "Cleanup");
    } catch (cause) {
      error = message(cause);
    } finally {
      instance.resources?.reclaim();
      instance.removeStyle?.();
      delete instance.resources;
      delete instance.dispose;
      delete instance.removeStyle;
      if (instance.state !== "failed") instance.state = "disabled";
      const hadCustomPage = customSettingsPages.delete(extensionId);
      if (hadCustomPage || hadSchemaPage) notifySettingsPages();
    }
    return error;
  }

  async function start(entry: DesktopExtensionEntry, currentBridge: DesktopExtensionBridge) {
    const instance: Instance = {
      hash: entry.hash,
      revision: ++settingsPageRevision,
      state: "waiting",
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.settingsSchema !== undefined ? { settingsSchema: entry.settingsSchema } : {}),
    };
    instances.set(entry.id, instance);
    const errors: number[] = [];
    const onError = (cause: unknown) => {
      if (instances.get(entry.id) !== instance || instance.state === "failed") return;
      const now = Date.now();
      while (errors.length && (errors[0] ?? now) <= now - ERROR_WINDOW_MS) errors.shift();
      errors.push(now);
      if (errors.length < ERROR_LIMIT) return;
      instance.state = "failed";
      instance.error = message(cause);
      instance.resources?.stopDeliveries();
      void serialize(async () => {
        const cleanup = await reclaim(entry.id, instance);
        if (cleanup) instance.error = `${instance.error}; ${cleanup}`;
      });
    };
    try {
      if (entry.error) throw new Error(entry.error);
      if (!entry.defineScript) throw new Error("Missing Desktop extension script");
      let definition: DesktopExtensionDefinitionV1 | undefined;
      let calls = 0;
      let defining = true;
      try {
        entry.defineScript((value) => {
          if (!defining) return;
          calls++;
          definition = value;
        });
      } finally {
        defining = false;
      }
      if (calls !== 1 || !definition || typeof definition.activate !== "function")
        throw new Error("Desktop extension must call define exactly once with activate");
      const resources = createDesktopExtensionApi(entry.id, currentBridge, onError, {
        registerSettingsPage,
        subscribeStorage,
        notifyStorage: notifyStorageChange,
      });
      instance.resources = resources;
      if (entry.style) instance.removeStyle = installStyle(document, entry.style);
      const activate = definition.activate as (
        api: DesktopExtensionRuntimeApiV1,
      ) => DesktopExtensionDispose | undefined | Promise<DesktopExtensionDispose | undefined>;
      const dispose = await withTimeout(
        () => activate(resources.api),
        ACTIVATE_TIMEOUT_MS,
        "Activation",
      );
      if (typeof dispose === "function") instance.dispose = dispose;
      else if (dispose !== undefined) throw new Error("Invalid Desktop extension cleanup");
      if (instance.state !== "failed") {
        instance.state = "running";
        if (instance.settingsSchema && instance.settingsSchema.length > 0) {
          notifySettingsPages();
        }
      }
    } catch (error) {
      instance.error = message(error);
      instance.state = "failed";
      await reclaim(entry.id, instance);
    }
  }

  async function apply(): Promise<void> {
    clearTimeout(pendingReady);
    settingsPageBatchDepth += 1;
    try {
      const entries = desired;
      const available = new Map(entries.map((entry) => [entry.id, entry]));
      const { active, conflicts } = resolveDesktopExtensionSlots(
        entries.map((entry) => entry.id),
        entries,
      );
      const activeIds = new Set(active);
      for (const [id, instance] of instances) {
        if (activeIds.has(id) && available.get(id)?.hash === instance.hash) continue;
        const error = await reclaim(id, instance);
        instances.delete(id);
        if (error) reports.set(id, { state: "disabled", hash: instance.hash, error });
      }
      for (const [id, report] of reports) if (report.state === "conflict") reports.delete(id);
      for (const [id, owner] of conflicts) {
        const entry = available.get(id);
        if (entry) reports.set(id, { state: "conflict", hash: entry.hash, conflictWith: owner });
      }
      const current = bridge;
      for (const id of active) {
        if (instances.has(id)) continue;
        if (!current?.ready()) {
          pendingReady = setTimeout(() => {
            void serialize(apply);
          }, 150);
          return;
        }
        const entry = available.get(id);
        if (!entry) continue;
        await start(entry, current);
        if (entries !== desired || bridge !== current) return;
      }
    } finally {
      settingsPageBatchDepth -= 1;
      if (settingsPageBatchDepth === 0 && settingsPagesDirty) {
        settingsPagesDirty = false;
        notifySettingsPages();
      }
    }
  }

  const getRegisteredSettingsPages = (): readonly RegisteredDesktopExtensionSettingsPage[] => {
    const pages: RegisteredDesktopExtensionSettingsPage[] = [];
    const seen = new Set<string>();
    for (const [extensionId, record] of customSettingsPages) {
      const instance = instances.get(extensionId);
      const title = record.page.title ?? instance?.name;
      pages.push({
        extensionId,
        kind: "custom",
        revision: record.revision,
        ...(title !== undefined ? { title } : {}),
        page: record.page,
      });
      seen.add(extensionId);
    }
    for (const [extensionId, instance] of instances) {
      if (seen.has(extensionId)) continue;
      if (instance.state !== "running") continue;
      if (!instance.settingsSchema || instance.settingsSchema.length === 0) continue;
      pages.push({
        extensionId,
        kind: "schema",
        revision: instance.revision,
        ...(instance.name !== undefined ? { title: instance.name } : {}),
        schema: instance.settingsSchema,
      });
    }
    return pages;
  };

  const createExtensionServices = (extensionId: string) => {
    const assets: DesktopExtensionAssetsApi = {
      async readDataUrl(relativePath: string) {
        if (!bridge?.readAsset) {
          throw new Error("Desktop extension assets API is unavailable");
        }
        return bridge.readAsset(extensionId, relativePath);
      },
    };
    const storage: DesktopExtensionStorageApi = {
      async get() {
        if (!bridge?.getSettings) {
          throw new Error("Desktop extension storage API is unavailable");
        }
        return cloneStorageValues(await bridge.getSettings(extensionId));
      },
      async set(values: Record<string, unknown>) {
        if (!bridge?.setSettings) {
          throw new Error("Desktop extension storage API is unavailable");
        }
        const updated = await bridge.setSettings(extensionId, values);
        notifyStorageChange(extensionId, updated);
        return cloneStorageValues(updated);
      },
      onChange(listener) {
        return subscribeStorage(extensionId, listener);
      },
    };
    const backend: DesktopExtensionBackendApi = {
      async invoke(method: string, params?: unknown) {
        if (!bridge?.invokeBackend) {
          throw new Error("Desktop extension backend API is unavailable");
        }
        return bridge.invokeBackend(extensionId, method, params);
      },
    };
    return { assets, storage, backend };
  };

  return {
    version: 1,
    reconcile(entries) {
      const previous = new Map(desired.map((entry) => [entry.id, entry]));
      desired = entries.map((entry) => {
        const old = previous.get(entry.id);
        return old?.hash === entry.hash && !entry.defineScript && !entry.error ? old : entry;
      });
      return serialize(apply);
    },
    status() {
      const status = new Map(reports);
      for (const { id, hash } of desired)
        if (!status.has(id)) status.set(id, { state: "waiting", hash });
      for (const [id, { state, hash, error }] of instances) {
        const cleanup = reports.get(id)?.state === "disabled" ? reports.get(id)?.error : undefined;
        status.set(id, { state, hash, ...(error || cleanup ? { error: error ?? cleanup } : {}) });
      }
      return Object.fromEntries(status);
    },
    disposeAll() {
      desired = [];
      for (const instance of instances.values()) instance.resources?.stopDeliveries();
      return serialize(apply);
    },
    bind(next) {
      bridge = next;
      return () => {
        if (bridge !== next) return;
        bridge = undefined;
        void this.disposeAll();
      };
    },
    getRegisteredSettingsPages,
    subscribeSettingsPages(listener) {
      settingsPageListeners.add(listener);
      return () => {
        settingsPageListeners.delete(listener);
      };
    },
    createExtensionServices,
    notifyStorageChange,
  };
}

export function installDesktopExtensionHost(ownerWindow: Window = window): DesktopExtensionHost {
  return (ownerWindow.__codexhostDesktopExtensionsV1 ??= createDesktopExtensionHost(
    ownerWindow.document,
  ));
}
