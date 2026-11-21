import { desktopExtensionPageModuleUrl } from "@codexhost/desktop-control/renderer-bindings";
import {
  HOST_EXTENSION_PAGE_API_VERSION,
  HOST_EXTENSION_PAGE_CSS_VARIABLES,
  resolveLocalizedExtensionText,
  type DesktopExtensionDispose,
  type HostExtensionListItem,
  type HostExtensionPageApi,
  type HostExtensionPageColorScheme,
  type HostExtensionPageModule,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
  type HOST_EXTENSIONS_RPC,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import {
  createEl,
  createExtensionIconElement,
  errorMessage,
  formatMessage,
  resolveInstalledExtensionIconUrl,
  type DesktopExtensionContentLocale,
  type HostExtensionValidItem,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface DesktopExtensionPageRpcClient {
  readHostExtensionAsset?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.asset>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.asset>>;
  getHostExtensionSettings?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.settingsGet>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.settingsGet>>;
  setHostExtensionSettings?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.settingsSet>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.settingsSet>>;
  invokeHostExtensionBackend?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.backendInvoke>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.backendInvoke>>;
}

export interface DesktopExtensionPageHostOptions {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  readonly messages: RendererSettingsMessages;
  readonly getClient: () => DesktopExtensionPageRpcClient | null;
  readonly getContentLocale?: (() => DesktopExtensionContentLocale) | undefined;
  readonly importModule?: ((url: string) => Promise<unknown>) | undefined;
  readonly onClose: () => void;
}

export interface DesktopExtensionPageHostController {
  readonly extensionId: string | null;
  readonly isOpen: boolean;
  open(item: HostExtensionValidItem, catalogIcon?: string): void;
  sync(extensions: readonly HostExtensionListItem[]): void;
  notifySettingsChanged(extensionId: string, values: JsonObject, revision: number): void;
  close(): void;
  dispose(): void;
}

const DESKTOP_PAGE_BASE_CSS = `
:host {
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.background}: var(--settings-bg, #ffffff);
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.surface}: var(--settings-surface, #f6f6f6);
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.text}: var(--settings-text, #0d0d0d);
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.mutedText}: var(--settings-muted, #676767);
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.border}: var(--settings-border, rgba(13, 13, 13, 0.09));
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.accent}: var(--settings-focus, #0b75d1);
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.danger}: var(--settings-danger, #b42318);
  ${HOST_EXTENSION_PAGE_CSS_VARIABLES.radius}: 12px;
  display: block;
  width: 100%;
  min-width: 0;
  color: var(${HOST_EXTENSION_PAGE_CSS_VARIABLES.text});
  background: var(${HOST_EXTENSION_PAGE_CSS_VARIABLES.background});
  box-sizing: border-box;
  font: inherit;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.cx-page-mount {
  min-width: 0;
  width: 100%;
}
`;

function defaultImportModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function cloneJsonObject(values: JsonObject): JsonObject {
  try {
    return structuredClone(values);
  } catch {
    return JSON.parse(JSON.stringify(values)) as JsonObject;
  }
}

function detectColorScheme(ownerWindow: Window | null): HostExtensionPageColorScheme {
  try {
    return ownerWindow?.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function isRevisionConflictError(error: unknown): boolean {
  const text = errorMessage(error);
  return /revision|conflict|stale/iu.test(text);
}

function applyShadowStyles(
  doc: Document,
  shadowRoot: ShadowRoot,
  stylesheets: readonly string[],
): void {
  const Ctor = doc.defaultView?.CSSStyleSheet ?? globalThis.CSSStyleSheet;
  if (typeof Ctor === "function" && "adoptedStyleSheets" in shadowRoot) {
    try {
      const sheets = stylesheets.map((cssText) => {
        const sheet = new Ctor();
        sheet.replaceSync(cssText);
        return sheet;
      });
      shadowRoot.adoptedStyleSheets = sheets;
      return;
    } catch {
      // Fall back to <style> elements if constructable stylesheets are unavailable.
    }
  }
  for (const cssText of stylesheets) {
    const styleEl = doc.createElement("style");
    styleEl.textContent = cssText;
    shadowRoot.append(styleEl);
  }
}

export function createDesktopExtensionPageHost(
  options: DesktopExtensionPageHostOptions,
): DesktopExtensionPageHostController {
  const {
    document: doc,
    host,
    signal: parentSignal,
    messages,
    getClient,
    getContentLocale = () => messages.locale,
    importModule = defaultImportModule,
    onClose,
  } = options;
  const copy = messages.desktopExtensions;
  const ownerWindow = doc.defaultView;

  let activeItem: HostExtensionValidItem | null = null;
  let activeCatalogIcon: string | undefined;
  let containerEl: HTMLElement | null = null;
  let pageAbort: AbortController | null = null;
  let activeDisposer: DesktopExtensionDispose | null = null;
  let settingsRevision: number | null = null;
  let storageListeners = new Set<(values: JsonObject) => void>();
  let localeListeners = new Set<(locale: string) => void>();
  let colorSchemeListeners = new Set<(scheme: HostExtensionPageColorScheme) => void>();
  let removeColorSchemeMediaListener: (() => void) | null = null;
  let mountToken = 0;

  const runDisposerSafely = (disposer: DesktopExtensionDispose | null): void => {
    if (typeof disposer !== "function") return;
    try {
      void Promise.resolve(disposer()).catch(() => undefined);
    } catch {
      // Isolate page cleanup errors.
    }
  };

  const teardownInstance = (): void => {
    mountToken += 1;
    const abort = pageAbort;
    pageAbort = null;
    if (abort && !abort.signal.aborted) {
      abort.abort();
    }
    removeColorSchemeMediaListener?.();
    removeColorSchemeMediaListener = null;
    storageListeners.clear();
    localeListeners.clear();
    colorSchemeListeners.clear();
    const disposer = activeDisposer;
    activeDisposer = null;
    runDisposerSafely(disposer);
    settingsRevision = null;
  };

  const closeInternal = (notifyOwner: boolean): void => {
    const wasOpen = activeItem !== null || containerEl !== null;
    teardownInstance();
    activeItem = null;
    activeCatalogIcon = undefined;
    if (containerEl) {
      containerEl.remove();
      containerEl = null;
    }
    if (wasOpen && notifyOwner) {
      onClose();
    }
  };

  const mountActivePage = (): void => {
    const item = activeItem;
    if (!item || !item.manifest.page || parentSignal.aborted) return;

    teardownInstance();
    const token = ++mountToken;
    const pageSpec = item.manifest.page;
    const controller = new AbortController();
    pageAbort = controller;

    const locale = getContentLocale();
    const pageTitle = pageSpec.title
      ? resolveLocalizedExtensionText(pageSpec.title, locale)
      : resolveLocalizedExtensionText(item.manifest.name, locale);
    const version = item.manifest.version.replace(/^v/u, "");

    const panel = createEl(doc, "section", "settings-extensions-page-view");
    panel.dataset.extensionId = item.id;
    panel.dataset.activationId = item.activationId;
    panel.dataset.digest = item.digest;

    const header = createEl(doc, "header", "settings-extensions-page-view__header");
    const headerLeft = createEl(doc, "div", "settings-extensions-page-view__header-left");

    const backButton = createEl(
      doc,
      "button",
      "settings-command-button settings-command-button--secondary settings-extensions-page-view__back",
    );
    backButton.type = "button";
    backButton.dataset.action = "page-back";
    backButton.append(
      createRendererSettingsIcon("chevron-left", 14),
      createEl(doc, "span", "", copy.pageBack),
    );
    backButton.addEventListener("click", () => closeInternal(true));

    const identity = createEl(doc, "div", "settings-extensions-page-view__identity");
    identity.append(
      createExtensionIconElement({
        document: doc,
        iconUrl: resolveInstalledExtensionIconUrl(item, activeCatalogIcon),
        categories: item.manifest.categories,
        size: "card",
        alt: pageTitle,
      }),
    );
    const titleWrap = createEl(doc, "div", "settings-extensions-page-view__title-wrap");
    const titleEl = createEl(doc, "h2", "settings-extensions-page-view__title", pageTitle);
    const versionEl = createEl(
      doc,
      "span",
      "settings-extensions-page-view__version",
      `v${version}`,
    );
    titleWrap.append(titleEl, versionEl);
    identity.append(titleWrap);
    headerLeft.append(backButton, identity);

    const headerActions = createEl(doc, "div", "settings-extensions-page-view__actions");
    const reloadButton = createEl(
      doc,
      "button",
      "settings-icon-button settings-extensions-page-view__reload",
    );
    reloadButton.type = "button";
    reloadButton.dataset.action = "page-reload";
    reloadButton.title = copy.pageReload;
    reloadButton.setAttribute("aria-label", copy.pageReload);
    reloadButton.append(createRendererSettingsIcon("refresh", 15));
    reloadButton.addEventListener("click", () => {
      if (activeItem) mountActivePage();
    });
    headerActions.append(reloadButton);

    header.append(headerLeft, headerActions);

    const stage = createEl(doc, "div", "settings-extensions-page-view__stage");
    const loadingEl = createEl(doc, "p", "settings-remote__loading");
    loadingEl.setAttribute("role", "status");
    loadingEl.append(createEl(doc, "span", "settings-remote-spinner"), copy.pageLoading);
    stage.append(loadingEl);

    panel.append(header, stage);

    if (containerEl) containerEl.remove();
    containerEl = panel;
    host.replaceChildren(panel);

    const renderPageError = (cause: unknown): void => {
      if (token !== mountToken || controller.signal.aborted || parentSignal.aborted) return;
      const errorBox = createEl(
        doc,
        "div",
        "settings-remote__empty settings-extensions__empty settings-extensions-page-view__error",
      );
      errorBox.setAttribute("role", "alert");
      const copyBox = createEl(doc, "div");
      copyBox.append(
        createEl(doc, "strong", "", copy.pageLoadFailedTitle),
        createEl(
          doc,
          "span",
          "",
          formatMessage(copy.pageLoadFailed, { message: errorMessage(cause) }),
        ),
      );
      const retryBtn = createEl(
        doc,
        "button",
        "settings-command-button settings-command-button--secondary",
        copy.retry,
      );
      retryBtn.type = "button";
      retryBtn.addEventListener("click", () => {
        if (activeItem) mountActivePage();
      });
      errorBox.append(copyBox, retryBtn);
      stage.replaceChildren(errorBox);
    };

    const guard = (): void => {
      if (token !== mountToken || parentSignal.aborted) {
        throw new Error(`Extension page "${item.id}" is closed`);
      }
      controller.signal.throwIfAborted();
    };

    let currentColorScheme: HostExtensionPageColorScheme = detectColorScheme(ownerWindow);
    try {
      const mql = ownerWindow?.matchMedia?.("(prefers-color-scheme: dark)");
      if (mql && typeof mql.addEventListener === "function") {
        const onSchemeChange = (event: MediaQueryListEvent) => {
          const next: HostExtensionPageColorScheme = event.matches ? "dark" : "light";
          if (next === currentColorScheme) return;
          currentColorScheme = next;
          for (const listener of [...colorSchemeListeners]) {
            try {
              listener(next);
            } catch {
              // Isolate listener errors.
            }
          }
        };
        mql.addEventListener("change", onSchemeChange);
        removeColorSchemeMediaListener = () => mql.removeEventListener("change", onSchemeChange);
      }
    } catch {
      // Ignore environments without matchMedia events.
    }

    const notifyStorageListeners = (values: JsonObject): void => {
      if (token !== mountToken || controller.signal.aborted) return;
      for (const listener of [...storageListeners]) {
        try {
          listener(cloneJsonObject(values));
        } catch {
          // Isolate subscriber errors.
        }
      }
    };

    const pageApi: HostExtensionPageApi = {
      id: item.id,
      apiVersion: HOST_EXTENSION_PAGE_API_VERSION,
      hostTarget: "desktop",
      get locale() {
        return getContentLocale();
      },
      onLocaleChange(listener) {
        guard();
        localeListeners.add(listener);
        return () => {
          localeListeners.delete(listener);
        };
      },
      get colorScheme() {
        return currentColorScheme;
      },
      onColorSchemeChange(listener) {
        guard();
        colorSchemeListeners.add(listener);
        return () => {
          colorSchemeListeners.delete(listener);
        };
      },
      signal: controller.signal,
      assets: {
        async url(relativePath: string): Promise<string> {
          guard();
          const reader = getClient()?.readHostExtensionAsset;
          if (!reader) throw new Error("Host extension asset RPC is unavailable");
          const asset = await reader({
            id: item.id,
            activationId: item.activationId,
            digest: item.digest,
            path: relativePath,
          });
          guard();
          return `data:${asset.mimeType};base64,${asset.base64}`;
        },
      },
      storage: {
        async get(): Promise<JsonObject> {
          guard();
          const getter = getClient()?.getHostExtensionSettings;
          if (!getter) throw new Error("Host extension settings RPC is unavailable");
          const result = await getter({ id: item.id, activationId: item.activationId });
          guard();
          settingsRevision = result.settingsRevision;
          return cloneJsonObject(result.values);
        },
        async set(values: JsonObject): Promise<JsonObject> {
          guard();
          const client = getClient();
          const setter = client?.setHostExtensionSettings;
          const getter = client?.getHostExtensionSettings;
          if (!setter) throw new Error("Host extension settings RPC is unavailable");
          if (settingsRevision === null) {
            if (!getter) throw new Error("Host extension settings RPC is unavailable");
            const current = await getter({ id: item.id, activationId: item.activationId });
            guard();
            settingsRevision = current.settingsRevision;
          }
          const writeOnce = async (expectedSettingsRevision: number) =>
            setter({
              id: item.id,
              activationId: item.activationId,
              expectedSettingsRevision,
              values: cloneJsonObject(values),
            });
          let saved;
          try {
            saved = await writeOnce(settingsRevision);
          } catch (cause) {
            if (!isRevisionConflictError(cause) || !getter) throw cause;
            guard();
            const latest = await getter({ id: item.id, activationId: item.activationId });
            guard();
            settingsRevision = latest.settingsRevision;
            saved = await writeOnce(settingsRevision);
          }
          guard();
          settingsRevision = saved.settingsRevision;
          notifyStorageListeners(saved.values);
          return cloneJsonObject(saved.values);
        },
        onChange(listener) {
          guard();
          storageListeners.add(listener);
          return () => {
            storageListeners.delete(listener);
          };
        },
      },
      backend: {
        async invoke(method: string, params?: JsonValue): Promise<JsonValue> {
          guard();
          if (!item.manifest.backend) {
            throw new Error(formatMessage(copy.pageNoBackend, { id: item.id }));
          }
          const invoker = getClient()?.invokeHostExtensionBackend;
          if (!invoker) throw new Error("Host extension backend RPC is unavailable");
          const reply = await invoker({
            id: item.id,
            activationId: item.activationId,
            method,
            ...(params !== undefined ? { params } : {}),
          });
          guard();
          return reply.result;
        },
      },
    };

    void (async () => {
      try {
        let styleSource: string | null = null;
        if (pageSpec.style) {
          const reader = getClient()?.readHostExtensionAsset;
          if (!reader) {
            throw new Error("Host extension asset RPC is unavailable");
          }
          const styleAsset = await reader({
            id: item.id,
            activationId: item.activationId,
            digest: item.digest,
            path: pageSpec.style,
          });
          if (token !== mountToken || controller.signal.aborted || parentSignal.aborted) return;
          styleSource = decodeBase64Utf8(styleAsset.base64);
        }

        const shadowHost = createEl(doc, "div", "settings-extensions-page-view__shadow-host");
        shadowHost.dataset.extensionPageHost = item.id;

        let mountRoot: HTMLElement;
        if (typeof shadowHost.attachShadow === "function") {
          const shadowRoot = shadowHost.attachShadow({ mode: "open" });
          const sheets = styleSource
            ? [DESKTOP_PAGE_BASE_CSS, styleSource]
            : [DESKTOP_PAGE_BASE_CSS];
          applyShadowStyles(doc, shadowRoot, sheets);
          mountRoot = createEl(doc, "div", "cx-page-mount");
          shadowRoot.append(mountRoot);
        } else {
          // Minimal fake-DOM fallback when attachShadow is absent in unit tests.
          mountRoot = createEl(doc, "div", "cx-page-mount");
          mountRoot.setAttribute("data-cx-page-fallback", "true");
          if (styleSource) {
            const styleEl = createEl(doc, "style");
            styleEl.textContent = styleSource;
            shadowHost.append(styleEl);
          }
          shadowHost.append(mountRoot);
        }

        const entryUrl = desktopExtensionPageModuleUrl({
          id: item.id,
          activationId: item.activationId,
          digest: item.digest,
        });
        const mod = (await importModule(entryUrl)) as
          Partial<HostExtensionPageModule> | null | undefined;

        if (token !== mountToken || controller.signal.aborted || parentSignal.aborted) return;

        if (!mod || typeof mod.mount !== "function") {
          throw new Error(`Extension page "${item.id}" must export a mount(root, api) function`);
        }

        stage.replaceChildren(shadowHost);
        const maybeDispose = await mod.mount(mountRoot, pageApi);
        if (token !== mountToken || controller.signal.aborted || parentSignal.aborted) {
          if (typeof maybeDispose === "function") {
            runDisposerSafely(maybeDispose);
          }
          return;
        }
        if (typeof maybeDispose === "function") {
          activeDisposer = maybeDispose;
        } else if (maybeDispose !== undefined) {
          throw new Error(`Extension page "${item.id}" mount() returned an invalid disposer`);
        }
      } catch (cause) {
        renderPageError(cause);
      }
    })();
  };

  const onParentAbort = (): void => {
    closeInternal(false);
  };
  parentSignal.addEventListener("abort", onParentAbort, { once: true });

  return {
    get extensionId() {
      return activeItem?.id ?? null;
    },
    get isOpen() {
      return activeItem !== null;
    },
    open(item, catalogIcon) {
      if (parentSignal.aborted || !item.enabled || !item.manifest.page) return;
      activeItem = item;
      activeCatalogIcon = catalogIcon;
      mountActivePage();
    },
    sync(extensions) {
      if (!activeItem) return;
      const latest = extensions.find((entry) => entry.id === activeItem?.id);
      if (!latest || latest.state !== "valid" || !latest.enabled || !latest.manifest.page) {
        closeInternal(true);
        return;
      }
      if (latest.activationId !== activeItem.activationId || latest.digest !== activeItem.digest) {
        activeItem = latest;
        mountActivePage();
      }
    },
    notifySettingsChanged(extensionId, values, revision) {
      if (!activeItem || activeItem.id !== extensionId) return;
      settingsRevision = revision;
      if (pageAbort?.signal.aborted) return;
      for (const listener of [...storageListeners]) {
        try {
          listener(cloneJsonObject(values));
        } catch {
          // Isolate subscriber errors.
        }
      }
    },
    close() {
      closeInternal(true);
    },
    dispose() {
      parentSignal.removeEventListener("abort", onParentAbort);
      closeInternal(false);
    },
  };
}
