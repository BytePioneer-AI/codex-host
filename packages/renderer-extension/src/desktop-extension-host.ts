import {
  resolveDesktopExtensionSlots,
  type DesktopExtensionDefine,
  type DesktopExtensionDefinitionV1,
  type DesktopExtensionDispose,
  type DesktopExtensionSlot,
  type DesktopExtensionStatus,
} from "@codexhost/shared-contracts";
import { createDesktopExtensionApi, type DesktopExtensionBridge } from "./desktop-extension-api.js";

export interface DesktopExtensionEntry {
  id: string;
  hash: string;
  slots: DesktopExtensionSlot[];
  defineScript?: (define: DesktopExtensionDefine) => void;
  style?: string;
  error?: string;
}

interface Instance {
  hash: string;
  state: DesktopExtensionStatus["state"];
  error?: string;
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
  const serialize = (operation: () => Promise<void>) => {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  };
  const message = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).slice(0, 2048);

  async function reclaim(instance: Instance): Promise<string | undefined> {
    instance.resources?.stopDeliveries();
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
    }
    return error;
  }

  async function start(entry: DesktopExtensionEntry, currentBridge: DesktopExtensionBridge) {
    const instance: Instance = { hash: entry.hash, state: "waiting" };
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
        const cleanup = await reclaim(instance);
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
      const resources = createDesktopExtensionApi(entry.id, currentBridge, onError);
      instance.resources = resources;
      if (entry.style) instance.removeStyle = installStyle(document, entry.style);
      const activate = definition.activate;
      const dispose = await withTimeout(
        () => activate(resources.api),
        ACTIVATE_TIMEOUT_MS,
        "Activation",
      );
      if (typeof dispose === "function") instance.dispose = dispose;
      else if (dispose !== undefined) throw new Error("Invalid Desktop extension cleanup");
      if (instance.state !== "failed") instance.state = "running";
    } catch (error) {
      instance.error = message(error);
      instance.state = "failed";
      await reclaim(instance);
    }
  }

  async function apply(): Promise<void> {
    clearTimeout(pendingReady);
    const entries = desired;
    const available = new Map(entries.map((entry) => [entry.id, entry]));
    const { active, conflicts } = resolveDesktopExtensionSlots(
      entries.map((entry) => entry.id),
      entries,
    );
    const activeIds = new Set(active);
    for (const [id, instance] of instances) {
      if (activeIds.has(id) && available.get(id)?.hash === instance.hash) continue;
      const error = await reclaim(instance);
      instances.delete(id);
      if (error) reports.set(id, { state: "disabled", hash: instance.hash, error });
    }
    for (const [id, report] of reports) if (report.state === "conflict") reports.delete(id);
    for (const [id, owner] of conflicts)
      reports.set(id, { state: "conflict", hash: available.get(id)!.hash, conflictWith: owner });
    const current = bridge;
    for (const id of active) {
      if (instances.has(id)) continue;
      if (!current?.ready()) {
        pendingReady = setTimeout(() => {
          void serialize(apply);
        }, 150);
        return;
      }
      await start(available.get(id)!, current);
      if (entries !== desired || bridge !== current) return;
    }
  }

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
  };
}

export function installDesktopExtensionHost(ownerWindow: Window = window): DesktopExtensionHost {
  return (ownerWindow.__codexhostDesktopExtensionsV1 ??= createDesktopExtensionHost(
    ownerWindow.document,
  ));
}
