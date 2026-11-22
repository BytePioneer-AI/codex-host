import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import {
  HOST_EXTENSION_PAGE_API_VERSION,
  type DesktopExtensionDispose,
  type HostExtensionPageApi,
  type HostExtensionPageColorScheme,
  type HostExtensionPageModule,
  type HostExtensionRuntimeEntry,
  type JsonObject,
} from "@codexhost/shared-contracts";
import type { HostSettingsSource } from "../HostSettingsSection.tsx";
import { toExtensionLocale } from "../web-extensions-helpers.ts";
import { isHostExtensionRevisionConflictError } from "../web-native-extension-management-api.ts";
import { cloneJsonObject, resolveHostExtensionAssetUrl } from "./api.ts";
import { webNativeExtensionRpcClient, type WebNativeExtensionRpcClient } from "./rpc.ts";

interface SurfaceAppearance {
  readonly locale: HostSettingsSource<string>;
  readonly colorScheme: HostSettingsSource<HostExtensionPageColorScheme>;
}

export function webExtensionAppearance(ctx: ClientContext): SurfaceAppearance {
  return {
    locale: {
      get: () => ctx.locale.getLocale().active,
      subscribe: (listener) => ctx.locale.subscribe(listener),
    },
    colorScheme: {
      get: () => ctx.theme.getTheme().active.colorScheme,
      subscribe: (listener) => ctx.on("theme/change", listener),
    },
  };
}

/** One generation of a `page` or `widget`, with shared API and lifetime. */
export function createWebExtensionSurface({
  container,
  identity,
  spec,
  kind,
  appearance,
  hasBackend,
  settingsRevision: initialSettingsRevision,
  rpc = webNativeExtensionRpcClient,
  importModule = (url) => import(/* @vite-ignore */ url),
  noBackendMessage = () => `Extension "${identity.id}" does not declare a backend`,
}: {
  container: HTMLElement;
  identity: Pick<HostExtensionRuntimeEntry, "id" | "activationId" | "digest">;
  spec: NonNullable<HostExtensionRuntimeEntry["manifest"]["widget"]>;
  kind: "page" | "widget";
  appearance: SurfaceAppearance;
  hasBackend: boolean;
  settingsRevision?: number;
  rpc?: WebNativeExtensionRpcClient;
  importModule?: (url: string) => Promise<unknown>;
  noBackendMessage?: () => string;
}) {
  const { id, activationId } = identity;
  const doc = container.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  const guard = () => signal.throwIfAborted();
  const { locale, colorScheme } = appearance;
  const resolveAsset = (path: string) => resolveHostExtensionAssetUrl({ ...identity, path }, doc);
  const localeListeners = new Set<(value: string) => void>();
  const schemeListeners = new Set<(value: HostExtensionPageColorScheme) => void>();
  const storageListeners = new Set<(values: JsonObject) => void>();
  let settingsRevision = initialSettingsRevision ?? -1;
  let notifiedRevision = settingsRevision;
  let disposer: DesktopExtensionDispose | undefined;
  let styleLink: HTMLLinkElement | undefined;
  const unsubscribers: Array<() => void> = [];

  const report = (label: string, error: unknown) =>
    console.error(`[host-extension-${kind}] ${label} failed (${id})`, error);
  const safely = (label: string, callback: () => void | Promise<void>) => {
    try {
      void Promise.resolve(callback()).catch((error: unknown) => report(label, error));
    } catch (error) {
      report(label, error);
    }
  };
  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => {
    guard();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const notify = <T>(label: string, listeners: Set<(value: T) => void>, value: () => T) => {
    for (const listener of [...listeners]) {
      if (signal.aborted) break;
      safely(label, () => listener(value()));
    }
  };
  const watchAppearance = <T>(
    source: HostSettingsSource<T>,
    listeners: Set<(value: T) => void>,
    apply: (value: T) => void,
    label: string,
  ) => {
    let current = source.get();
    apply(current);
    unsubscribers.push(
      source.subscribe(() => {
        if (signal.aborted) return;
        const next = source.get();
        if (next === current) return;
        current = next;
        apply(next);
        notify(label, listeners, () => next);
      }),
    );
  };
  const readSettings = async () => {
    guard();
    const result = await rpc.settingsGet(id, activationId, signal);
    guard();
    settingsRevision = Math.max(settingsRevision, result.settingsRevision);
    return result;
  };
  const notifySettings = (values: JsonObject, revision: number) => {
    if (signal.aborted || revision < settingsRevision || revision <= notifiedRevision) return;
    settingsRevision = notifiedRevision = revision;
    notify("storage.onChange", storageListeners, () => cloneJsonObject(values));
  };

  const api: HostExtensionPageApi = {
    id,
    apiVersion: HOST_EXTENSION_PAGE_API_VERSION,
    hostTarget: "web",
    get locale() {
      return toExtensionLocale(locale.get());
    },
    onLocaleChange: (listener) => subscribe(localeListeners, listener),
    get colorScheme() {
      return colorScheme.get();
    },
    onColorSchemeChange: (listener) => subscribe(schemeListeners, listener),
    signal,
    assets: {
      async url(path) {
        guard();
        return resolveAsset(path);
      },
    },
    storage: {
      async get() {
        return cloneJsonObject((await readSettings()).values);
      },
      async set(values) {
        guard();
        const copy = cloneJsonObject(values);
        const write = () => rpc.settingsSet(id, activationId, settingsRevision, copy, signal);
        if (settingsRevision < 0) await readSettings();
        let saved;
        try {
          saved = await write();
        } catch (error) {
          if (!isHostExtensionRevisionConflictError(error)) throw error;
          await readSettings();
          saved = await write();
        }
        guard();
        notifySettings(saved.values, saved.settingsRevision);
        return cloneJsonObject(saved.values);
      },
      onChange: (listener) => subscribe(storageListeners, listener),
    },
    backend: {
      async invoke(method, params) {
        guard();
        if (!hasBackend) throw new Error(noBackendMessage());
        const result = await rpc.backendInvoke(id, activationId, method, params, signal);
        guard();
        return result;
      },
    },
  };

  return {
    async mount() {
      guard();
      const shadow = kind === "widget" ? container.attachShadow({ mode: "open" }) : undefined;
      const mountRoot = shadow ? doc.createElement("div") : container;
      if (shadow) {
        mountRoot.className = "cx-page-mount";
        shadow.append(mountRoot);
      }
      if (spec.style !== undefined) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = resolveAsset(spec.style);
        if (!shadow) link.dataset.cxPageStyle = id;
        styleLink = link;
        (shadow ?? doc.head ?? doc.documentElement).prepend(link);
      }
      watchAppearance(
        { ...locale, get: () => api.locale },
        localeListeners,
        (value) => {
          container.lang = value;
        },
        "onLocaleChange",
      );
      watchAppearance(
        colorScheme,
        schemeListeners,
        (value) => {
          container.style.colorScheme = value;
        },
        "onColorSchemeChange",
      );

      const mod = (await importModule(
        resolveAsset(spec.entry),
      )) as Partial<HostExtensionPageModule> | null;
      guard();
      if (typeof mod?.mount !== "function") {
        throw new Error(`Extension ${kind} "${id}" must export a mount(root, api) function`);
      }
      const cleanup = await mod.mount(mountRoot, api);
      if (typeof cleanup === "function") {
        if (signal.aborted) safely("disposer", cleanup);
        else disposer = cleanup;
      } else if (cleanup !== undefined) {
        throw new Error(`Extension ${kind} "${id}" mount() returned an invalid disposer`);
      }
      guard();
    },
    async refreshSettings(revision?: number) {
      if (signal.aborted || (revision !== undefined && revision <= notifiedRevision)) return;
      if (revision !== undefined) settingsRevision = Math.max(settingsRevision, revision);
      if (storageListeners.size === 0) return;
      try {
        const latest = await readSettings();
        notifySettings(latest.values, latest.settingsRevision);
      } catch (error) {
        if (!signal.aborted) report("settings refresh", error);
      }
    },
    dispose() {
      if (signal.aborted) return;
      controller.abort();
      for (const unsubscribe of unsubscribers) unsubscribe();
      localeListeners.clear();
      schemeListeners.clear();
      storageListeners.clear();
      if (disposer) safely("disposer", disposer);
      disposer = undefined;
      styleLink?.remove();
      if (kind === "widget") container.remove();
      else container.replaceChildren();
    },
  };
}
