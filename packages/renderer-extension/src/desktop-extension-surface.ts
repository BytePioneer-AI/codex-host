import {
  HOST_EXTENSION_PAGE_API_VERSION,
  HOST_EXTENSION_PAGE_CSS_VARIABLES as css,
  type DesktopExtensionDispose,
  type HostExtensionPageApi,
  type HostExtensionPageColorScheme,
  type HostExtensionPageModule,
  type HostExtensionRuntimeEntry,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { installDesktopExtensionHost } from "./desktop-extension-host.js";
import type { RendererModelClient } from "./renderer-model-client.js";

export type DesktopExtensionSurfaceClient = Pick<
  RendererModelClient,
  | "readHostExtensionAsset"
  | "getHostExtensionSettings"
  | "setHostExtensionSettings"
  | "invokeHostExtensionBackend"
>;

const BASE_CSS = `
:host {
  ${css.background}: var(--settings-bg, var(--color-background-default, Canvas));
  ${css.surface}: var(--settings-surface, var(--color-background-surface, light-dark(#f6f6f6, #262626)));
  ${css.text}: var(--settings-text, var(--color-text-primary, CanvasText));
  ${css.mutedText}: var(--settings-muted, var(--color-text-secondary, light-dark(#676767, #a1a1a1)));
  ${css.border}: var(--settings-border, var(--color-border-default, light-dark(#dedede, #454545)));
  ${css.accent}: var(--settings-focus, var(--color-text-info, light-dark(#0b75d1, #339cff)));
  ${css.danger}: var(--settings-danger, var(--color-text-danger, light-dark(#b42318, #f87171)));
  ${css.radius}: 12px;
  display: block;
  width: 100%;
  min-width: 0;
  color: var(${css.text});
  box-sizing: border-box;
  font: inherit;
}
*, *::before, *::after { box-sizing: border-box; }
.cx-page-mount { min-width: 0; width: 100%; }
`;

function shadowMount(container: HTMLElement, stylesheets: readonly string[]): HTMLElement {
  const doc = container.ownerDocument;
  const shadow = container.attachShadow?.({ mode: "open" });
  const root = shadow ?? container;
  const mount = doc.createElement("div");
  mount.className = "cx-page-mount";
  const Sheet = doc.defaultView?.CSSStyleSheet;
  let adopted = false;
  if (shadow && Sheet && "adoptedStyleSheets" in shadow) {
    try {
      shadow.adoptedStyleSheets = stylesheets.map((text) => {
        const sheet = new Sheet();
        sheet.replaceSync(text);
        return sheet;
      });
      adopted = true;
    } catch {
      // Constructable stylesheets are not available in every renderer environment.
    }
  }
  if (!adopted) {
    for (const text of stylesheets) {
      const style = doc.createElement("style");
      style.textContent = text;
      root.append(style);
    }
  }
  root.append(mount);
  return mount;
}

function runDisposer(disposer: DesktopExtensionDispose): void {
  try {
    void Promise.resolve(disposer()).catch(() => undefined);
  } catch {
    // Extension cleanup must not interrupt the host.
  }
}

function notify<T>(listeners: Set<(value: T) => void>, value: () => T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value());
    } catch {
      // Subscribers are extension code and may fail independently.
    }
  }
}

function clone(values: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(values)) as JsonObject;
}

function darkMedia(win: Window | null): MediaQueryList | undefined {
  try {
    return win?.matchMedia?.("(prefers-color-scheme: dark)");
  } catch {
    return undefined;
  }
}

function colorScheme(
  document: Document,
  media: MediaQueryList | undefined,
): HostExtensionPageColorScheme {
  const root = document.documentElement;
  const theme = root.getAttribute("data-theme");
  if (theme === "dark" || theme === "light") return theme;
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  const scheme = document.defaultView?.getComputedStyle?.(root).colorScheme;
  if (scheme === "dark" || scheme === "light") return scheme;
  return media?.matches ? "dark" : "light";
}

export function createDesktopExtensionSurface({
  container,
  item,
  spec,
  kind,
  getClient,
  getLocale,
  onRetired,
  noBackendMessage = `Extension "${item.id}" does not declare a backend`,
}: {
  container: HTMLElement;
  item: Pick<HostExtensionRuntimeEntry, "id" | "activationId" | "digest" | "manifest"> & {
    settingsRevision?: number;
  };
  spec: NonNullable<HostExtensionRuntimeEntry["manifest"]["widget"]>;
  kind: "page" | "widget";
  getClient: () => DesktopExtensionSurfaceClient | null;
  getLocale: () => string;
  onRetired?: () => void;
  noBackendMessage?: string;
}) {
  const { id, activationId, digest } = item;
  const activation = { id, activationId };
  const identity = { ...activation, digest };
  const controller = new AbortController();
  const { signal } = controller;
  const guard = () => signal.throwIfAborted();
  const doc = container.ownerDocument;
  const media = darkMedia(doc.defaultView);
  let locale = getLocale();
  let scheme: HostExtensionPageColorScheme = "light";
  let disposer: DesktopExtensionDispose | undefined;
  let notifiedRevision = item.settingsRevision ?? -1;
  let settingsRevision = item.settingsRevision ?? -1;
  let readingSettings = false;
  const storageListeners = new Set<(values: JsonObject) => void>();
  const localeListeners = new Set<(value: string) => void>();
  const schemeListeners = new Set<(value: HostExtensionPageColorScheme) => void>();

  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => {
    guard();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const syncLocale = () => {
    if (signal.aborted) return;
    const next = getLocale();
    if (next === locale) return;
    locale = next;
    container.setAttribute("lang", locale);
    notify(localeListeners, () => locale);
  };
  const syncScheme = () => {
    if (signal.aborted) return;
    const next = colorScheme(doc, media);
    if (next === scheme) return;
    scheme = next;
    container.style.colorScheme = scheme;
    notify(schemeListeners, () => scheme);
  };
  const themeObserver = doc.defaultView?.MutationObserver
    ? new doc.defaultView.MutationObserver(syncScheme)
    : undefined;

  const readAsset = async (path: string) => {
    guard();
    const client = getClient();
    if (!client?.readHostExtensionAsset) throw new Error("Host extension asset RPC is unavailable");
    const result = await client.readHostExtensionAsset({ ...identity, path });
    guard();
    return result;
  };
  const readSettings = async (client = getClient()) => {
    guard();
    if (!client?.getHostExtensionSettings)
      throw new Error("Host extension settings RPC is unavailable");
    const result = await client.getHostExtensionSettings(activation);
    guard();
    settingsRevision = Math.max(settingsRevision, result.settingsRevision);
    return result;
  };
  const notifySettings = (values: JsonObject, revision: number) => {
    if (signal.aborted || revision <= notifiedRevision) return;
    settingsRevision = Math.max(settingsRevision, revision);
    notifiedRevision = revision;
    notify(storageListeners, () => clone(values));
  };

  const api: HostExtensionPageApi = {
    id,
    apiVersion: HOST_EXTENSION_PAGE_API_VERSION,
    hostTarget: "desktop",
    get locale() {
      return getLocale();
    },
    onLocaleChange: (listener) => subscribe(localeListeners, listener),
    get colorScheme() {
      return scheme;
    },
    onColorSchemeChange: (listener) => subscribe(schemeListeners, listener),
    signal,
    assets: {
      async url(path) {
        const asset = await readAsset(path);
        return `data:${asset.mimeType};base64,${asset.base64}`;
      },
    },
    storage: {
      async get() {
        return clone((await readSettings()).values);
      },
      async set(values) {
        guard();
        const client = getClient();
        const setter = client?.setHostExtensionSettings;
        if (!setter) throw new Error("Host extension settings RPC is unavailable");
        const write = () =>
          setter.call(client, {
            ...activation,
            expectedSettingsRevision: settingsRevision,
            values: clone(values),
          });
        if (settingsRevision < 0) await readSettings(client);
        let saved;
        try {
          saved = await write();
        } catch (error) {
          if (!/revision|conflict|stale/iu.test(String(error)) || !client?.getHostExtensionSettings)
            throw error;
          await readSettings(client);
          saved = await write();
        }
        guard();
        notifySettings(saved.values, saved.settingsRevision);
        return clone(saved.values);
      },
      onChange: (listener) => subscribe(storageListeners, listener),
    },
    backend: {
      async invoke(method, params) {
        guard();
        if (!item.manifest.backend) throw new Error(noBackendMessage);
        const client = getClient();
        if (!client?.invokeHostExtensionBackend)
          throw new Error("Host extension backend RPC is unavailable");
        const reply = await client.invokeHostExtensionBackend({
          ...activation,
          method,
          ...(params !== undefined ? { params } : {}),
        });
        guard();
        return reply.result;
      },
    },
  };

  const dispose = () => {
    if (signal.aborted) return;
    controller.abort();
    themeObserver?.disconnect();
    media?.removeEventListener?.("change", syncScheme);
    storageListeners.clear();
    localeListeners.clear();
    schemeListeners.clear();
    if (disposer) runDisposer(disposer);
    disposer = undefined;
    container.remove();
  };

  return {
    signal,
    async mount(attach: () => void) {
      const window = doc.defaultView;
      if (!window) throw new Error("Desktop extension module host is unavailable");
      const module = await installDesktopExtensionHost(window).modules.waitFor(
        { ...identity, kind, path: spec.entry },
        signal,
      );
      guard();
      if (module.signal.aborted) {
        dispose();
        onRetired?.();
        return;
      }
      module.signal.addEventListener(
        "abort",
        () => {
          dispose();
          onRetired?.();
        },
        { once: true, signal },
      );
      try {
        await mountModule(attach, module);
        module.report({});
      } catch (cause) {
        if (!signal.aborted)
          module.report({ error: cause instanceof Error ? cause.message : String(cause) });
        throw cause;
      }
    },
    syncLocale,
    notifySettings,
    async refreshSettings(revision: number) {
      if (signal.aborted || readingSettings || revision <= notifiedRevision) return;
      readingSettings = true;
      try {
        const latest = await readSettings();
        if (latest.settingsRevision >= revision)
          notifySettings(latest.values, latest.settingsRevision);
      } finally {
        readingSettings = false;
      }
    },
    dispose,
  };

  async function mountModule(
    attach: () => void,
    module: { load(): Promise<{ namespace: unknown }> },
  ) {
    const sheets = [BASE_CSS];
    if (kind === "page") sheets.push(`:host { background: var(${css.background}); }`);
    if (spec.style) {
      const asset = await readAsset(spec.style);
      sheets.push(
        new TextDecoder().decode(Uint8Array.from(atob(asset.base64), (char) => char.charCodeAt(0))),
      );
    }
    guard();
    const mount = shadowMount(container, sheets);
    const { namespace } = await module.load();
    const mod = namespace as Partial<HostExtensionPageModule> | null | undefined;
    guard();
    if (typeof mod?.mount !== "function")
      throw new Error(`Extension ${kind} "${id}" must export a mount(root, api) function`);
    scheme = colorScheme(doc, media);
    container.style.colorScheme = scheme;
    locale = getLocale();
    container.setAttribute("lang", locale);
    themeObserver?.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    media?.addEventListener?.("change", syncScheme);
    attach();
    const cleanup = await mod.mount(mount, api);
    if (typeof cleanup === "function") {
      if (signal.aborted) runDisposer(cleanup);
      else disposer = cleanup;
    } else if (cleanup !== undefined)
      throw new Error(`Extension ${kind} "${id}" mount() returned an invalid disposer`);
  }
}
