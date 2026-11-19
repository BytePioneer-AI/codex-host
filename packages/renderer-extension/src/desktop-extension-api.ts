import type {
  DesktopExtensionApiV1,
  DesktopSidebarRow,
  ThreadTreeSnapshot,
} from "@codexhost/shared-contracts";
import type { SidebarAgentIconRow } from "./renderer-sidebar-agent-icons.js";

type ObservableSidebarRow = Pick<
  SidebarAgentIconRow,
  "hostId" | "threadId" | "draftId" | "isConnected"
> & { element: HTMLElement };

type ReceiveTree = (snapshot: ThreadTreeSnapshot) => void;
type WatchTree = (receive: ReceiveTree) => () => void;

// IDs and marker names both allow '-', so different extensions can spell the
// same attribute. Claim each attribute on each element before writing it.
const markerOwners = new WeakMap<Element, Map<string, string>>();

export interface DesktopExtensionBridge {
  ready(): boolean;
  sidebar: { rows(): readonly ObservableSidebarRow[]; observe(onChange: () => void): () => void };
  watchTree: WatchTree;
  describe(harnessId: string): { name: string; icon?: string } | undefined;
  openThread(id: string, signal: AbortSignal): Promise<void>;
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
) {
  const abort = new AbortController();
  const navigation = new AbortController();
  const teardowns = new Set<() => void>();
  const nodes = new Set<Element>();
  const marked = new Map<Element, Map<string, string | null>>();
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
  const api: DesktopExtensionApiV1 = {
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
