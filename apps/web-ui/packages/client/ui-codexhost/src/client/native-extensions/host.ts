/**
 * Browser runtime host for Web native extensions.
 *
 * Polls `codexhost/webExtensions/snapshot` serially every 2 seconds (and immediately on reconnect
 * or when the page becomes visible), reconciles extensions by `(id, activationId, digest)`,
 * refreshes same-generation settings changes without remounting UI, and isolates every failure.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {
  WebExtensionDispose,
  WebExtensionModule,
  WebExtensionRuntimeEntry,
  WebExtensionRuntimeSnapshot,
} from "@codexhost/shared-contracts";
import { createWebExtensionApi, type ManagedWebExtensionResources } from "./api.ts";
import { webNativeExtensionRpcClient, type WebNativeExtensionRpcClient } from "./rpc.ts";

const POLL_INTERVAL_MS = 2_000;

export interface WebNativeExtensionHostHandle {
  /** Trigger an immediate snapshot fetch and reconciliation. */
  syncNow(): void;
  /** Stop polling and reclaim every active extension instance. */
  dispose(): void;
}

export interface StartWebNativeExtensionHostOptions {
  /** Booted root Cordis context (provides `slots`, `locale`, `connection`, ...). */
  readonly ctx: ClientContext;
  /** Document that hosts `<link>` styles and `data-cx-region` anchors. */
  readonly document: Document;
  /** Optional RPC transport override (defaults to same-origin `WEB_EXTENSIONS_RPC`). */
  readonly rpc?: WebNativeExtensionRpcClient;
  /** Optional dynamic ESM importer override for testing. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Optional poll interval override in milliseconds (defaults to 2000ms). */
  readonly pollIntervalMs?: number;
}

interface ActiveInstance {
  readonly id: string;
  readonly activationId: string;
  readonly digest: string;
  settingsRevision: string;
  disposed: boolean;
  styleLink: HTMLLinkElement | undefined;
  resources: ManagedWebExtensionResources | undefined;
  activateDispose: WebExtensionDispose | undefined;
  settingsSyncToken: number;
}

function defaultImportModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

function installStyleLink(doc: Document, id: string, styleUrl: string): HTMLLinkElement {
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.setAttribute("data-cx-web-ext", id);
  link.href = styleUrl;
  (doc.head ?? doc.documentElement).append(link);
  return link;
}

function removeStyleLink(instance: ActiveInstance): void {
  if (instance.styleLink === undefined) return;
  instance.styleLink.remove();
  instance.styleLink = undefined;
}

/**
 * Start the Web native extension host after the built-in UI has mounted.
 * Safe to dispose at any point, including while initial fetches or async activations are in flight.
 */
export function startWebNativeExtensionHost(
  options: StartWebNativeExtensionHostOptions,
): WebNativeExtensionHostHandle {
  const {
    ctx,
    document: doc,
    rpc = webNativeExtensionRpcClient,
    importModule = defaultImportModule,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = options;

  const instances = new Map<string, ActiveInstance>();
  let lastSnapshotRevision: string | undefined;
  let stopped = false;
  let syncing = false;
  let pendingSync = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotAbort: AbortController | undefined;

  const destroyInstance = (instance: ActiveInstance): void => {
    instance.disposed = true;
    instance.settingsSyncToken += 1;
    const activateDispose = instance.activateDispose;
    instance.activateDispose = undefined;
    if (instance.resources !== undefined) {
      instance.resources.reclaim(activateDispose);
    } else if (typeof activateDispose === "function") {
      try {
        void Promise.resolve(activateDispose()).catch((error: unknown) => {
          console.error(`[web-native-extensions] activate disposer failed (${instance.id})`, error);
        });
      } catch (error) {
        console.error(`[web-native-extensions] activate disposer failed (${instance.id})`, error);
      }
    }
    removeStyleLink(instance);
  };

  const refreshSameGenerationSettings = (instance: ActiveInstance, nextRevision: string): void => {
    instance.settingsRevision = nextRevision;
    const resources = instance.resources;
    if (instance.disposed || resources === undefined || !resources.hasStorageListeners()) {
      return;
    }
    const token = ++instance.settingsSyncToken;
    void rpc
      .settingsGet(instance.id, instance.activationId, resources.signal)
      .then((result) => {
        if (
          stopped ||
          instance.disposed ||
          instances.get(instance.id) !== instance ||
          instance.settingsSyncToken !== token
        ) {
          return;
        }
        instance.settingsRevision = result.revision;
        resources.notifyStorageChange(result.values);
      })
      .catch((error: unknown) => {
        if (stopped || instance.disposed || resources.signal.aborted) return;
        console.error(`[web-native-extensions] failed to reload settings (${instance.id})`, error);
      });
  };

  const activateEntry = (entry: WebExtensionRuntimeEntry): void => {
    const instance: ActiveInstance = {
      id: entry.id,
      activationId: entry.activationId,
      digest: entry.digest,
      settingsRevision: entry.settingsRevision,
      disposed: false,
      styleLink: undefined,
      resources: undefined,
      activateDispose: undefined,
      settingsSyncToken: 0,
    };
    instances.set(entry.id, instance);

    try {
      if (entry.styleUrl !== undefined) {
        instance.styleLink = installStyleLink(doc, entry.id, entry.styleUrl);
      }
    } catch (error) {
      console.error(`[web-native-extensions] failed to mount style (${entry.id})`, error);
      destroyInstance(instance);
      return;
    }

    // Pure CSS extensions do not require a JS module.
    if (entry.entryUrl === undefined) {
      return;
    }

    const resources = createWebExtensionApi({
      ctx,
      document: doc,
      entry,
      rpc,
      onSettingsRevisionObserved: (revision) => {
        if (!instance.disposed && instances.get(entry.id) === instance) {
          instance.settingsRevision = revision;
        }
      },
    });
    instance.resources = resources;

    const entryUrl = entry.entryUrl;
    void (async () => {
      try {
        const mod = (await importModule(entryUrl)) as
          Partial<WebExtensionModule> | null | undefined;
        if (stopped || instance.disposed || instances.get(entry.id) !== instance) {
          // Stale async import must never activate a retired generation.
          destroyInstance(instance);
          return;
        }
        if (mod === null || mod === undefined || typeof mod.activate !== "function") {
          throw new Error(`Web extension "${entry.id}" must export an activate(api) function`);
        }
        const maybeDispose = await mod.activate(resources.api);
        if (stopped || instance.disposed || instances.get(entry.id) !== instance) {
          // Prevent a stale async activate() from leaving mounts, markers, or disposers alive.
          if (typeof maybeDispose === "function") {
            instance.activateDispose = maybeDispose;
          }
          destroyInstance(instance);
          return;
        }
        if (typeof maybeDispose === "function") {
          instance.activateDispose = maybeDispose;
        } else if (maybeDispose !== undefined) {
          throw new Error(`Web extension "${entry.id}" activate() returned an invalid disposer`);
        }
      } catch (error) {
        console.error(`[web-native-extensions] activation failed (${entry.id})`, error);
        // Reclaim partial resources; keep the failed generation marker in `instances` so
        // identical `(id, activationId, digest)` snapshots do not spam retries every 2s.
        destroyInstance(instance);
      }
    })();
  };

  const reconcile = (snapshot: WebExtensionRuntimeSnapshot): void => {
    if (stopped) return;
    if (snapshot.revision === lastSnapshotRevision) return;
    lastSnapshotRevision = snapshot.revision;

    const desiredById = new Map(snapshot.extensions.map((entry) => [entry.id, entry]));

    // 1. Destroy removed or superseded generations first.
    for (const [id, current] of [...instances.entries()]) {
      const next = desiredById.get(id);
      if (
        next === undefined ||
        next.activationId !== current.activationId ||
        next.digest !== current.digest
      ) {
        instances.delete(id);
        destroyInstance(current);
      }
    }

    // 2. Reconcile same-generation settings updates and activate new generations.
    for (const entry of snapshot.extensions) {
      const current = instances.get(entry.id);
      if (current !== undefined) {
        if (current.settingsRevision !== entry.settingsRevision) {
          refreshSameGenerationSettings(current, entry.settingsRevision);
        }
        continue;
      }
      activateEntry(entry);
    }
  };

  const clearPollTimer = (): void => {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const scheduleNextPoll = (): void => {
    clearPollTimer();
    if (stopped || doc.visibilityState === "hidden") return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      triggerSync();
    }, pollIntervalMs);
  };

  const runSyncLoop = async (): Promise<void> => {
    if (stopped || syncing) return;
    syncing = true;
    clearPollTimer();
    try {
      do {
        pendingSync = false;
        const requestAbort = new AbortController();
        snapshotAbort = requestAbort;
        try {
          const snapshot = await rpc.snapshot(requestAbort.signal);
          if (!stopped && !requestAbort.signal.aborted) {
            reconcile(snapshot);
          }
        } catch (error) {
          if (!stopped && !requestAbort.signal.aborted) {
            console.debug("[web-native-extensions] snapshot sync skipped", error);
          }
        } finally {
          if (snapshotAbort === requestAbort) {
            snapshotAbort = undefined;
          }
        }
      } while (!stopped && pendingSync);
    } finally {
      syncing = false;
      scheduleNextPoll();
    }
  };

  const triggerSync = (): void => {
    if (stopped) return;
    if (syncing) {
      pendingSync = true;
      return;
    }
    void runSyncLoop();
  };

  // Immediate sync when returning to the tab; pause background polling while hidden.
  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (doc.visibilityState === "hidden") {
      clearPollTimer();
      return;
    }
    triggerSync();
  };
  doc.addEventListener("visibilitychange", onVisibilityChange);

  // Immediate sync on transport reconnect or new connection generation.
  const connectionSubscriptions: Array<() => void> = [];
  const connection = ctx.get("connection") as ConnectionHandle | undefined;
  if (connection !== undefined) {
    let previousState = connection.state.getSnapshot();
    connectionSubscriptions.push(
      connection.state.subscribe(() => {
        const nextState = connection.state.getSnapshot();
        const reconnected = nextState === "connected" && previousState !== "connected";
        previousState = nextState;
        if (reconnected) triggerSync();
      }),
    );
    let previousGeneration = connection.generation.getSnapshot()?.id;
    connectionSubscriptions.push(
      connection.generation.subscribe(() => {
        const nextGeneration = connection.generation.getSnapshot()?.id;
        if (nextGeneration !== undefined && nextGeneration !== previousGeneration) {
          previousGeneration = nextGeneration;
          triggerSync();
        }
      }),
    );
  }

  // Kick off the initial snapshot fetch immediately after built-in UI mount.
  triggerSync();

  return {
    syncNow: triggerSync,
    dispose: () => {
      if (stopped) return;
      stopped = true;
      pendingSync = false;
      clearPollTimer();
      snapshotAbort?.abort();
      snapshotAbort = undefined;
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      for (const unsubscribe of connectionSubscriptions.splice(0)) {
        unsubscribe();
      }
      for (const instance of [...instances.values()]) {
        destroyInstance(instance);
      }
      instances.clear();
    },
  };
}
