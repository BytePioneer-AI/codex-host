import type {
  DesktopExtensionApiV1,
  DesktopSidebarRow,
  ThreadTreeSnapshot,
} from "@codexhost/shared-contracts";
import type { SidebarAgentIconRow } from "./renderer-sidebar-agent-icons.js";
import type { RendererSettingsIconName } from "./settings/icons.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

type ObservableSidebarRow = Pick<
  SidebarAgentIconRow,
  "hostId" | "threadId" | "draftId" | "isConnected"
> & { element: HTMLElement };

type ReceiveTree = (snapshot: ThreadTreeSnapshot) => void;
type WatchTree = (receive: ReceiveTree) => () => void;

// IDs and marker names both allow '-', so different extensions can spell the
// same attribute. Claim each attribute on each element before writing it.
const markerOwners = new WeakMap<Element, Map<string, string>>();

export interface DesktopExtensionAssetsApi {
  readDataUrl(relativePath: string): Promise<{ mimeType: string; dataUrl: string }>;
}

export interface DesktopExtensionStorageApi {
  get(): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  onChange(listener: (values: Record<string, unknown>) => void): () => void;
}

export interface DesktopExtensionBackendApi {
  invoke(method: string, params?: unknown): Promise<unknown>;
}

export interface DesktopExtensionSettingsPageContext {
  readonly locale: RendererSettingsLocale;
  readonly storage: DesktopExtensionStorageApi;
  readonly assets: DesktopExtensionAssetsApi;
  readonly backend: DesktopExtensionBackendApi;
}

export interface DesktopExtensionSettingsPageContribution {
  readonly title?: string | { readonly en: string; readonly "zh-CN": string };
  readonly icon?: RendererSettingsIconName;
  mount(
    container: HTMLElement,
    context: DesktopExtensionSettingsPageContext,
  ): (() => void) | undefined;
}

export interface DesktopExtensionSettingsApi {
  registerPage(page: DesktopExtensionSettingsPageContribution): () => void;
}

export interface DesktopExtensionRuntimeApiV1 extends DesktopExtensionApiV1 {
  readonly assets: DesktopExtensionAssetsApi;
  readonly storage: DesktopExtensionStorageApi;
  readonly backend: DesktopExtensionBackendApi;
  readonly settings: DesktopExtensionSettingsApi;
}

export interface DesktopExtensionBridge {
  ready(): boolean;
  sidebar: { rows(): readonly ObservableSidebarRow[]; observe(onChange: () => void): () => void };
  watchTree: WatchTree;
  describe(harnessId: string): { name: string; icon?: string } | undefined;
  openThread(id: string, signal: AbortSignal): Promise<void>;
  readAsset?(id: string, relativePath: string): Promise<{ mimeType: string; dataUrl: string }>;
  getSettings?(id: string): Promise<Record<string, unknown>>;
  setSettings?(id: string, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  invokeBackend?(id: string, method: string, params?: unknown): Promise<unknown>;
}

export interface DesktopExtensionApiHostHooks {
  registerSettingsPage?(id: string, page: DesktopExtensionSettingsPageContribution): () => void;
  subscribeStorage?(id: string, listener: (values: Record<string, unknown>) => void): () => void;
  notifyStorage?(id: string, values: Record<string, unknown>): void;
}

export function cloneStorageValues(values: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(values);
  } catch {
    return { ...values };
  }
}

/** Renderer-page relay: there is one Host subscription for all enabled extensions. */
export function createDesktopTreeRelay(watch: WatchTree) {
  const subscribers = new Set<ReceiveTree>();
  let close: (() => void) | undefined;
  let latest: ThreadTreeSnapshot | undefined;
  let generation = 0;
  const connect = () => {
    const current = ++generation;
    close = watch((snapshot) => {
      if (current !== generation) return;
      latest = snapshot;
      for (const receive of subscribers) receive(structuredClone(snapshot));
    });
  };
  const disconnect = () => {
    generation++;
    close?.();
    close = undefined;
    latest = undefined;
  };
  return {
    subscribe(receive: ReceiveTree): () => void {
      subscribers.add(receive);
      try {
        if (subscribers.size === 1) connect();
        else if (latest) receive(structuredClone(latest));
      } catch (error) {
        subscribers.delete(receive);
        throw error;
      }
      return () => {
        subscribers.delete(receive);
        if (!subscribers.size) disconnect();
      };
    },
    reconnect() {
      disconnect();
      if (subscribers.size) connect();
    },
  };
}

export async function openLocalExtensionThread(
  id: string,
  signal: AbortSignal,
  rows: readonly ObservableSidebarRow[],
  exists: (id: string) => Promise<boolean>,
  navigate: (id: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const matches = rows.filter((row) => row.threadId() === id);
  if (
    !id.trim() ||
    (matches.length && !matches.some((row) => row.hostId() === "local")) ||
    !(await exists(id))
  )
    throw new Error("Unknown local Desktop Thread");
  signal.throwIfAborted();
  await navigate(id, signal);
}

export function createDesktopExtensionApi(
  id: string,
  bridge: DesktopExtensionBridge,
  onError: (error: unknown) => void,
  hooks: DesktopExtensionApiHostHooks = {},
) {
  const abort = new AbortController();
  const navigation = new AbortController();
  const teardowns = new Set<() => void>();
  const nodes = new Set<Element>();
  const marked = new Map<Element, Map<string, string | null>>();
  const localStorageListeners = new Set<(values: Record<string, unknown>) => void>();
  let unregisterSettingsPage: (() => void) | null = null;
  const removeMark = (target: Element, key: string) => {
    const names = marked.get(target);
    if (!names?.has(key)) return;
    const previous = names.get(key) ?? null;
    if (previous === null) target.removeAttribute(key);
    else target.setAttribute(key, previous);
    names.delete(key);
    if (!names.size) marked.delete(target);
    markerOwners.get(target)?.delete(key);
  };
  let stopping = false;
  const guard = () => {
    if (stopping) throw new Error("Desktop extension is unloading");
    abort.signal.throwIfAborted();
  };
  const delivery = <T>(callback: (value: T) => void, value: T) => {
    if (stopping) return;
    try {
      void Promise.resolve(callback(value)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  const track = (teardown: () => void) => {
    guard();
    teardowns.add(teardown);
    return () => {
      if (teardowns.delete(teardown)) teardown();
    };
  };
  const attribute = (name: string) => {
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name))
      throw new Error("Invalid Desktop extension marker name");
    return `data-cx-${id}-${name}`;
  };
  const api: DesktopExtensionRuntimeApiV1 = {
    id,
    apiVersion: 1,
    signal: abort.signal,
    sidebar: {
      observeRows(callback) {
        guard();
        let previous: readonly DesktopSidebarRow[] | undefined;
        const publish = () => {
          if (stopping) return;
          const rows = bridge.sidebar.rows().map((row): DesktopSidebarRow => {
            const hostId = row.hostId();
            return Object.freeze({
              element: row.element,
              hostId,
              isLocal: hostId === "local",
              threadId: row.threadId(),
              draftId: row.draftId(),
              isConnected: () => row.isConnected(),
            });
          });
          if (
            previous?.length === rows.length &&
            rows.every((row, index) => {
              const prior = previous?.[index];
              return (
                row.element === prior?.element &&
                row.hostId === prior.hostId &&
                row.threadId === prior.threadId &&
                row.draftId === prior.draftId
              );
            })
          )
            return;
          previous = rows;
          delivery(callback, rows);
        };
        const stop = track(bridge.sidebar.observe(publish));
        publish();
        return stop;
      },
    },
    threads: {
      watchTree(callback) {
        guard();
        return track(bridge.watchTree((snapshot) => delivery(callback, snapshot)));
      },
    },
    navigate: {
      async openThread(threadId) {
        guard();
        await bridge.openThread(threadId, navigation.signal);
      },
    },
    harnesses: {
      describe(harnessId) {
        guard();
        return bridge.describe(harnessId);
      },
    },
    dom: {
      mount(node, parent, position = "append") {
        guard();
        if (node.isConnected && !nodes.has(node))
          throw new Error("Use mount only for extension-owned DOM");
        nodes.add(node);
        parent[position](node);
      },
      mark(target, name) {
        guard();
        const key = attribute(name);
        const owners = markerOwners.get(target) ?? new Map<string, string>();
        const owner = owners.get(key);
        if (owner !== undefined && owner !== id)
          throw new Error("Desktop extension marker already owned");
        const names = marked.get(target) ?? new Map<string, string | null>();
        if (!names.has(key)) names.set(key, target.getAttribute(key));
        target.setAttribute(key, "");
        owners.set(key, id);
        markerOwners.set(target, owners);
        marked.set(target, names);
      },
      unmark(target, name) {
        abort.signal.throwIfAborted();
        removeMark(target, attribute(name));
      },
    },
    assets: {
      async readDataUrl(relativePath: string) {
        guard();
        if (!bridge.readAsset) {
          throw new Error("Desktop extension assets API is unavailable");
        }
        const result = await bridge.readAsset(id, relativePath);
        guard();
        return result;
      },
    },
    storage: {
      async get() {
        guard();
        if (!bridge.getSettings) {
          throw new Error("Desktop extension storage API is unavailable");
        }
        const values = await bridge.getSettings(id);
        guard();
        return cloneStorageValues(values);
      },
      async set(values: Record<string, unknown>) {
        guard();
        if (!bridge.setSettings) {
          throw new Error("Desktop extension storage API is unavailable");
        }
        const updated = await bridge.setSettings(id, values);
        guard();
        if (hooks.notifyStorage) {
          hooks.notifyStorage(id, updated);
        } else {
          for (const listener of [...localStorageListeners]) {
            delivery(listener, cloneStorageValues(updated));
          }
        }
        return cloneStorageValues(updated);
      },
      onChange(listener: (values: Record<string, unknown>) => void) {
        guard();
        if (hooks.subscribeStorage) {
          return track(
            hooks.subscribeStorage(id, (values) => delivery(listener, cloneStorageValues(values))),
          );
        }
        localStorageListeners.add(listener);
        return track(() => {
          localStorageListeners.delete(listener);
        });
      },
    },
    backend: {
      async invoke(method: string, params?: unknown) {
        guard();
        if (!bridge.invokeBackend) {
          throw new Error("Desktop extension backend API is unavailable");
        }
        const result = await bridge.invokeBackend(id, method, params);
        guard();
        return result;
      },
    },
    settings: {
      registerPage(page: DesktopExtensionSettingsPageContribution) {
        guard();
        if (!page || typeof page.mount !== "function") {
          throw new Error("Desktop extension settings page must provide a mount function");
        }
        unregisterSettingsPage?.();
        unregisterSettingsPage = null;
        if (!hooks.registerSettingsPage) {
          return () => undefined;
        }
        const removeFromHost = hooks.registerSettingsPage(id, page);
        const disposePage = track(() => {
          if (unregisterSettingsPage === disposePage) unregisterSettingsPage = null;
          removeFromHost();
        });
        unregisterSettingsPage = disposePage;
        return disposePage;
      },
    },
    track(teardown) {
      track(teardown);
    },
  };
  return {
    api,
    stopDeliveries() {
      stopping = true;
      navigation.abort();
    },
    reclaim() {
      stopping = true;
      navigation.abort();
      abort.abort();
      unregisterSettingsPage = null;
      localStorageListeners.clear();
      for (const teardown of teardowns) {
        try {
          void Promise.resolve(teardown()).catch(onError);
        } catch (error) {
          onError(error);
        }
      }
      teardowns.clear();
      for (const node of nodes) node.remove();
      nodes.clear();
      for (const [target, names] of marked)
        for (const name of names.keys()) removeMark(target, name);
      marked.clear();
    },
  };
}
