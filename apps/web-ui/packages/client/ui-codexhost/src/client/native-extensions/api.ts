/**
 * Per-activation `WebExtensionApi` factory and owned resource tracker.
 *
 * Tracks every mount container, DOM marker attribute, storage subscriber, custom contribution,
 * and registered disposer so deactivation leaves no leaked host-managed DOM or listeners behind.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import {
  WEB_EXTENSION_REGIONS,
  hostExtensionAssetUrl,
  type HostExtensionRuntimeEntry,
  type JsonObject,
  type JsonValue,
  type WebExtensionActiveSession,
  type WebExtensionApi,
  type WebExtensionDispose,
  type WebExtensionMount,
  type WebExtensionRegion,
} from "@codexhost/shared-contracts";
import { ExtensionContributionRegistry } from "./contributions.ts";
import type { WebNativeExtensionRpcClient } from "./rpc.ts";
import { createTabIconContribution } from "./tab-icon.ts";

interface ObservableStoreLike<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

interface SessionSummaryLike {
  readonly id: string;
  readonly displayTitle: string;
  readonly cwd?: string;
  readonly parentId?: string;
  readonly running: boolean;
  readonly blank: boolean;
  readonly retainedBy: Readonly<{ readonly mainView?: number }>;
  readonly projectionValues?: Readonly<{ readonly remoteHost?: unknown }>;
}

interface SessionListStateLike {
  readonly byId: Readonly<Record<string, SessionSummaryLike | undefined>>;
  readonly projectionsBySession?: Readonly<
    Record<string, { readonly values?: Readonly<{ readonly remoteHost?: unknown }> } | undefined>
  >;
}

interface SessionsServiceLike {
  readonly list: ObservableStoreLike<SessionListStateLike>;
  subagentAddress?(id: string): { readonly parentSessionId?: string } | undefined;
}

interface WorkspaceItemLike {
  readonly workspaceId: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
  readonly remote?: unknown;
}

interface WorkspacesServiceLike {
  readonly list: ObservableStoreLike<{ readonly items: readonly WorkspaceItemLike[] }>;
}

interface LayoutServiceLike {
  readonly panelInfo: ObservableStoreLike<{ readonly activePanelId: string | null }>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getSessionsService(ctx: ClientContext): SessionsServiceLike | undefined {
  const candidate = ctx.get("sessions" as never) as Partial<SessionsServiceLike> | undefined;
  return candidate?.list &&
    typeof candidate.list.getSnapshot === "function" &&
    typeof candidate.list.subscribe === "function"
    ? (candidate as SessionsServiceLike)
    : undefined;
}

function getWorkspacesService(ctx: ClientContext): WorkspacesServiceLike | undefined {
  const candidate = ctx.get("workspaces" as never) as Partial<WorkspacesServiceLike> | undefined;
  return candidate?.list &&
    typeof candidate.list.getSnapshot === "function" &&
    typeof candidate.list.subscribe === "function"
    ? (candidate as WorkspacesServiceLike)
    : undefined;
}

function getLayoutService(ctx: ClientContext): LayoutServiceLike | undefined {
  const candidate = ctx.get("layout" as never) as Partial<LayoutServiceLike> | undefined;
  return candidate?.panelInfo &&
    typeof candidate.panelInfo.getSnapshot === "function" &&
    typeof candidate.panelInfo.subscribe === "function"
    ? (candidate as LayoutServiceLike)
    : undefined;
}

function readActiveSessionSnapshot(ctx: ClientContext): WebExtensionActiveSession | null {
  const layout = getLayoutService(ctx);
  if (layout !== undefined && layout.panelInfo.getSnapshot().activePanelId !== null) {
    return null;
  }
  const sessions = getSessionsService(ctx);
  if (sessions === undefined) return null;
  const list = sessions.list.getSnapshot();
  const active = Object.values(list.byId).find(
    (item): item is SessionSummaryLike => item !== undefined && (item.retainedBy.mainView ?? 0) > 0,
  );
  if (active === undefined) return null;

  const workspaceItems = getWorkspacesService(ctx)?.list.getSnapshot().items ?? [];
  let workspace: WorkspaceItemLike | undefined;
  let inheritedCwd: string | null = null;
  let isRemote = false;
  const seen = new Set<string>();
  let cursor: string | undefined = active.id;

  while (cursor !== undefined && !seen.has(cursor)) {
    const currentId = cursor;
    seen.add(currentId);
    if (inheritedCwd === null) {
      inheritedCwd = nonEmptyString(list.byId[currentId]?.cwd);
    }
    const matchingWorkspace = workspaceItems.find((item) => item.sessionIds.includes(currentId));
    if (workspace === undefined && matchingWorkspace !== undefined) {
      workspace = matchingWorkspace;
    }
    if (
      currentId.startsWith("web-remote:") ||
      currentId.startsWith("remote-control:") ||
      list.byId[currentId]?.projectionValues?.remoteHost != null ||
      list.projectionsBySession?.[currentId]?.values?.remoteHost != null ||
      matchingWorkspace?.remote !== undefined
    ) {
      isRemote = true;
    }
    cursor =
      sessions.subagentAddress?.(currentId)?.parentSessionId ?? list.byId[currentId]?.parentId;
  }

  return {
    id: active.id,
    title: active.displayTitle,
    cwd: inheritedCwd ?? nonEmptyString(workspace?.path),
    workspaceId: workspace?.workspaceId ?? null,
    isBlank: Boolean(active.blank),
    isRemote,
    running: Boolean(active.running),
  };
}

function cloneActiveSession(
  session: WebExtensionActiveSession | null,
): WebExtensionActiveSession | null {
  return session === null ? null : { ...session };
}

function activeSessionEquals(
  left: WebExtensionActiveSession | null,
  right: WebExtensionActiveSession | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.cwd === right.cwd &&
    left.workspaceId === right.workspaceId &&
    left.isBlank === right.isBlank &&
    left.isRemote === right.isRemote &&
    left.running === right.running
  );
}

// IDs and marker names both permit "-", so guard per-element attribute ownership across extensions.
const markerOwners = new WeakMap<Element, Map<string, string>>();
const VALID_REGIONS: ReadonlySet<string> = new Set(WEB_EXTENSION_REGIONS);
const VALID_MARKER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function cloneJsonObject(values: JsonObject): JsonObject {
  try {
    return structuredClone(values);
  } catch {
    return JSON.parse(JSON.stringify(values)) as JsonObject;
  }
}

/**
 * Resolve a Host extension asset URL relative to the document's `<base href="./">` so sub-path
 * deployments and Relay proxies keep their base prefix; falls back to the raw asset path.
 */
export function resolveHostExtensionAssetUrl(
  input: Parameters<typeof hostExtensionAssetUrl>[0],
  doc?: Pick<Document, "baseURI"> | null,
): string {
  const rawPath = hostExtensionAssetUrl(input);
  const baseUri = doc?.baseURI;
  if (typeof baseUri === "string" && baseUri.length > 0) {
    try {
      return new URL(rawPath.replace(/^\/+/u, ""), baseUri).href;
    } catch {
      // Fall back to the root-relative path if baseURI is invalid or non-hierarchical.
    }
  }
  return rawPath;
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    (value as Node).nodeType === 1 &&
    "append" in value &&
    "prepend" in value
  );
}

function isElement(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    (value as Node).nodeType === 1 &&
    "setAttribute" in value &&
    "removeAttribute" in value
  );
}

function isRevisionConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /revision|conflict|stale/iu.test(message);
}

export interface ManagedWebExtensionResources {
  readonly api: WebExtensionApi;
  readonly signal: AbortSignal;
  readonly hasStorageListeners: () => boolean;
  updateSettingsRevision(revision: number): void;
  notifyStorageChange(values: JsonObject): void;
  reclaim(activateDispose?: WebExtensionDispose): void;
}

export interface CreateWebExtensionApiOptions {
  readonly ctx: ClientContext;
  readonly document: Document;
  readonly entry: HostExtensionRuntimeEntry;
  readonly rpc: WebNativeExtensionRpcClient;
  readonly onSettingsRevisionObserved: (revision: number) => void;
}

/** Build one isolated `WebExtensionApi` instance bound to a single `(id, activationId, digest)`. */
export function createWebExtensionApi(
  options: CreateWebExtensionApiOptions,
): ManagedWebExtensionResources {
  const { ctx, document: doc, entry, rpc, onSettingsRevisionObserved } = options;
  const { id, activationId, digest } = entry;
  const hasBackend = Boolean(entry.manifest.backend);
  const controller = new AbortController();
  const contributions = new ExtensionContributionRegistry(ctx, id, controller.signal);

  const mounts = new Set<HTMLElement>();
  const marked = new Map<Element, Map<string, string | null>>();
  const storageListeners = new Set<(values: JsonObject) => void>();
  const sessionListeners = new Set<(session: WebExtensionActiveSession | null) => void>();
  const trackedDisposers = new Set<WebExtensionDispose>();
  const tabIcon = createTabIconContribution(doc);
  trackedDisposers.add(() => tabIcon.dispose());
  let currentSettingsRevision = entry.settingsRevision;
  let stopping = false;
  let lastSessionSnapshot: WebExtensionActiveSession | null = null;
  let detachSessionStores: (() => void) | undefined;

  const guard = (): void => {
    if (stopping) throw new Error(`Web extension "${id}" is unloading`);
    controller.signal.throwIfAborted();
  };

  const markerAttribute = (name: string): string => {
    if (typeof name !== "string" || !VALID_MARKER_NAME.test(name)) {
      throw new Error(
        `Web extension "${id}" marker name must use lowercase letters, digits, or hyphens`,
      );
    }
    return `data-cx-ext-${id}-${name}`;
  };

  const removeMark = (target: Element, attr: string): void => {
    const names = marked.get(target);
    if (!names?.has(attr)) return;
    const previous = names.get(attr) ?? null;
    if (previous === null) target.removeAttribute(attr);
    else target.setAttribute(attr, previous);
    names.delete(attr);
    if (names.size === 0) marked.delete(target);
    const owners = markerOwners.get(target);
    if (owners?.get(attr) === id) {
      owners.delete(attr);
      if (owners.size === 0) markerOwners.delete(target);
    }
  };

  const resolveMountParent = (
    target: HTMLElement | WebExtensionRegion,
  ): HTMLElement | undefined => {
    if (typeof target === "string") {
      if (!VALID_REGIONS.has(target)) return undefined;
      if (target === "composer-dock") {
        const conversation = doc.querySelector<HTMLElement>('[data-cx-region="conversation"]');
        if (conversation !== null) {
          return (
            conversation.querySelector<HTMLElement>('[data-cx-region="composer-dock"]') ?? undefined
          );
        }
        // When the full app shell is mounted without a main conversation (e.g. Plugins or other
        // global main panels), avoid mounting into an embedded sidebar composer dock.
        if (doc.querySelector('[data-cx-region="app"]') !== null) return undefined;
      }
      return doc.querySelector<HTMLElement>(`[data-cx-region="${target}"]`) ?? undefined;
    }
    return isHtmlElement(target) ? target : undefined;
  };

  const detachSessionWatchers = (): void => {
    const detach = detachSessionStores;
    detachSessionStores = undefined;
    detach?.();
  };

  const deliverSessionChange = (next: WebExtensionActiveSession | null): void => {
    if (stopping || controller.signal.aborted) return;
    for (const listener of [...sessionListeners]) {
      if (stopping || controller.signal.aborted) break;
      try {
        void Promise.resolve(listener(cloneActiveSession(next))).catch((error: unknown) => {
          console.error(`[web-native-extensions] session.onChange failed (${id})`, error);
        });
      } catch (error) {
        console.error(`[web-native-extensions] session.onChange failed (${id})`, error);
      }
    }
  };

  const syncActiveSession = (): void => {
    if (stopping || controller.signal.aborted || sessionListeners.size === 0) return;
    const next = readActiveSessionSnapshot(ctx);
    if (activeSessionEquals(lastSessionSnapshot, next)) return;
    lastSessionSnapshot = next;
    deliverSessionChange(next);
  };

  const ensureSessionWatchers = (): void => {
    if (detachSessionStores !== undefined) return;
    lastSessionSnapshot = readActiveSessionSnapshot(ctx);
    const unsubscribers: Array<() => void> = [];
    const sessions = getSessionsService(ctx);
    if (sessions !== undefined) {
      unsubscribers.push(sessions.list.subscribe(syncActiveSession));
    }
    const workspaces = getWorkspacesService(ctx);
    if (workspaces !== undefined) {
      unsubscribers.push(workspaces.list.subscribe(syncActiveSession));
    }
    const layout = getLayoutService(ctx);
    if (layout !== undefined) {
      unsubscribers.push(layout.panelInfo.subscribe(syncActiveSession));
    }
    detachSessionStores = () => {
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch (error) {
          console.error(`[web-native-extensions] session unsubscribe failed (${id})`, error);
        }
      }
    };
  };

  const deliverStorageChange = (values: JsonObject): void => {
    if (stopping || controller.signal.aborted) return;
    for (const listener of [...storageListeners]) {
      if (stopping || controller.signal.aborted) break;
      try {
        void Promise.resolve(listener(cloneJsonObject(values))).catch((error: unknown) => {
          console.error(`[web-native-extensions] storage.onChange failed (${id})`, error);
        });
      } catch (error) {
        console.error(`[web-native-extensions] storage.onChange failed (${id})`, error);
      }
    }
  };

  const runDisposer = (disposer: WebExtensionDispose, label: string): void => {
    try {
      void Promise.resolve(disposer()).catch((error: unknown) => {
        console.error(`[web-native-extensions] ${label} failed (${id})`, error);
      });
    } catch (error) {
      console.error(`[web-native-extensions] ${label} failed (${id})`, error);
    }
  };

  const api: WebExtensionApi = {
    id,
    apiVersion: 1,
    signal: controller.signal,
    tabIcon: {
      set: (value) => {
        guard();
        tabIcon.set(value);
      },
    },
    dom: {
      mount(
        target: HTMLElement | WebExtensionRegion,
        position: "append" | "prepend" = "append",
      ): WebExtensionMount | undefined {
        guard();
        const parent = resolveMountParent(target);
        if (parent === undefined) return undefined;
        const container = doc.createElement("div");
        container.setAttribute("data-cx-web-ext-mount", id);
        if (position === "prepend") parent.prepend(container);
        else parent.append(container);
        mounts.add(container);
        let disposed = false;
        return {
          container,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            mounts.delete(container);
            container.remove();
          },
        };
      },
      mark(target: Element, name: string): void {
        guard();
        if (!isElement(target)) {
          throw new Error(`Web extension "${id}" dom.mark requires a DOM Element`);
        }
        const attr = markerAttribute(name);
        const owners = markerOwners.get(target) ?? new Map<string, string>();
        const owner = owners.get(attr);
        if (owner !== undefined && owner !== id) {
          throw new Error(`Web extension marker "${attr}" is already owned by "${owner}"`);
        }
        const names = marked.get(target) ?? new Map<string, string | null>();
        if (!names.has(attr)) {
          names.set(attr, target.getAttribute(attr));
        }
        target.setAttribute(attr, "");
        owners.set(attr, id);
        markerOwners.set(target, owners);
        marked.set(target, names);
      },
      unmark(target: Element, name: string): void {
        controller.signal.throwIfAborted();
        if (!isElement(target)) return;
        removeMark(target, markerAttribute(name));
      },
    },
    track(dispose: WebExtensionDispose): void {
      guard();
      if (typeof dispose !== "function") {
        throw new Error(`Web extension "${id}" track() requires a function`);
      }
      trackedDisposers.add(dispose);
    },
    assets: {
      url(path: string): string {
        guard();
        return resolveHostExtensionAssetUrl({ id, activationId, digest, path }, doc);
      },
    },
    storage: {
      async get(): Promise<JsonObject> {
        guard();
        const result = await rpc.settingsGet(id, activationId, controller.signal);
        guard();
        currentSettingsRevision = result.settingsRevision;
        onSettingsRevisionObserved(result.settingsRevision);
        return cloneJsonObject(result.values);
      },
      async set(values: JsonObject): Promise<JsonObject> {
        guard();
        let result;
        try {
          result = await rpc.settingsSet(
            id,
            activationId,
            currentSettingsRevision,
            values,
            controller.signal,
          );
        } catch (error) {
          if (!isRevisionConflictError(error)) throw error;
          guard();
          const latest = await rpc.settingsGet(id, activationId, controller.signal);
          guard();
          currentSettingsRevision = latest.settingsRevision;
          result = await rpc.settingsSet(
            id,
            activationId,
            currentSettingsRevision,
            values,
            controller.signal,
          );
        }
        guard();
        currentSettingsRevision = result.settingsRevision;
        onSettingsRevisionObserved(result.settingsRevision);
        deliverStorageChange(result.values);
        return cloneJsonObject(result.values);
      },
      onChange(listener: (values: JsonObject) => void): () => void {
        guard();
        if (typeof listener !== "function") {
          throw new Error(`Web extension "${id}" storage.onChange requires a function`);
        }
        storageListeners.add(listener);
        return () => {
          storageListeners.delete(listener);
        };
      },
    },
    backend: {
      async invoke(method: string, params?: JsonValue): Promise<JsonValue> {
        guard();
        if (!hasBackend) {
          throw new Error(`Extension "${id}" does not declare a backend`);
        }
        const result = await rpc.backendInvoke(id, activationId, method, params, controller.signal);
        guard();
        return result;
      },
    },
    session: {
      getActive(): WebExtensionActiveSession | null {
        guard();
        return cloneActiveSession(readActiveSessionSnapshot(ctx));
      },
      onChange(listener: (session: WebExtensionActiveSession | null) => void): () => void {
        guard();
        if (typeof listener !== "function") {
          throw new Error(`Web extension "${id}" session.onChange requires a function`);
        }
        ensureSessionWatchers();
        sessionListeners.add(listener);
        return () => {
          sessionListeners.delete(listener);
          if (sessionListeners.size === 0) {
            detachSessionWatchers();
          }
        };
      },
    },
    settings: {
      registerPage(page) {
        guard();
        return contributions.registerSettingsPage(page);
      },
    },
    panels: {
      register(panel) {
        guard();
        return contributions.registerPanel(panel);
      },
    },
  };

  const reclaim = (activateDispose?: WebExtensionDispose): void => {
    stopping = true;
    // Always abort first so listeners, async work, and contribution signals stop immediately.
    if (!controller.signal.aborted) controller.abort();
    contributions.abortAll();

    // Drop subscriptions before invoking user cleanup.
    storageListeners.clear();
    sessionListeners.clear();
    detachSessionWatchers();

    // Unregister custom settings pages and panels.
    contributions.disposeAll();

    // Run activate() disposer and tracked disposers (LIFO) with full isolation.
    if (typeof activateDispose === "function") {
      runDisposer(activateDispose, "activate disposer");
    }
    const disposers = [...trackedDisposers].reverse();
    trackedDisposers.clear();
    for (const disposer of disposers) {
      runDisposer(disposer, "tracked disposer");
    }

    // Remove all host-owned mount containers.
    for (const container of mounts) {
      container.remove();
    }
    mounts.clear();

    // Restore all marked attributes.
    for (const [target, names] of [...marked.entries()]) {
      for (const attr of [...names.keys()]) {
        removeMark(target, attr);
      }
    }
    marked.clear();
  };

  return {
    api,
    signal: controller.signal,
    hasStorageListeners: () => storageListeners.size > 0,
    updateSettingsRevision(revision: number) {
      currentSettingsRevision = revision;
    },
    notifyStorageChange: deliverStorageChange,
    reclaim,
  };
}
