/**
 * Per-activation `WebExtensionApi` factory and owned resource tracker.
 *
 * Tracks every mount container, DOM marker attribute, storage subscriber, custom contribution,
 * and registered disposer so deactivation leaves no leaked host-managed DOM or listeners behind.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import {
  WEB_EXTENSION_REGIONS,
  encodeWebExtensionResourcePath,
  type JsonObject,
  type JsonValue,
  type WebExtensionApi,
  type WebExtensionDispose,
  type WebExtensionMount,
  type WebExtensionRegion,
  type WebExtensionRuntimeEntry,
} from "@codexhost/shared-contracts";
import { ExtensionContributionRegistry } from "./contributions.ts";
import type { WebNativeExtensionRpcClient } from "./rpc.ts";

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

export interface ManagedWebExtensionResources {
  readonly api: WebExtensionApi;
  readonly signal: AbortSignal;
  readonly hasStorageListeners: () => boolean;
  notifyStorageChange(values: JsonObject): void;
  reclaim(activateDispose?: WebExtensionDispose): void;
}

export interface CreateWebExtensionApiOptions {
  readonly ctx: ClientContext;
  readonly document: Document;
  readonly entry: WebExtensionRuntimeEntry;
  readonly rpc: WebNativeExtensionRpcClient;
  readonly onSettingsRevisionObserved: (revision: string) => void;
}

/** Build one isolated `WebExtensionApi` instance bound to a single `(id, activationId, digest)`. */
export function createWebExtensionApi(
  options: CreateWebExtensionApiOptions,
): ManagedWebExtensionResources {
  const { ctx, document: doc, entry, rpc, onSettingsRevisionObserved } = options;
  const { id, activationId, assetBaseUrl } = entry;
  const controller = new AbortController();
  const contributions = new ExtensionContributionRegistry(ctx, id, controller.signal);

  const mounts = new Set<HTMLElement>();
  const marked = new Map<Element, Map<string, string | null>>();
  const storageListeners = new Set<(values: JsonObject) => void>();
  const trackedDisposers = new Set<WebExtensionDispose>();
  let stopping = false;

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
      return doc.querySelector<HTMLElement>(`[data-cx-region="${target}"]`) ?? undefined;
    }
    return isHtmlElement(target) ? target : undefined;
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
        return `${assetBaseUrl}${encodeWebExtensionResourcePath(path)}`;
      },
    },
    storage: {
      async get(): Promise<JsonObject> {
        guard();
        const result = await rpc.settingsGet(id, activationId, controller.signal);
        guard();
        onSettingsRevisionObserved(result.revision);
        return cloneJsonObject(result.values);
      },
      async set(values: JsonObject): Promise<JsonObject> {
        guard();
        const result = await rpc.settingsSet(id, activationId, values, controller.signal);
        guard();
        onSettingsRevisionObserved(result.revision);
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
        const result = await rpc.backendInvoke(id, activationId, method, params, controller.signal);
        guard();
        return result;
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
    notifyStorageChange: deliverStorageChange,
    reclaim,
  };
}
