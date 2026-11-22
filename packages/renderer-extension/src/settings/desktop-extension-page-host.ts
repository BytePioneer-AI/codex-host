import {
  resolveLocalizedExtensionText,
  type HostExtensionListItem,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  createDesktopExtensionSurface,
  type DesktopExtensionSurfaceClient,
} from "../desktop-extension-surface.js";
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

export interface DesktopExtensionPageHostOptions {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  readonly messages: RendererSettingsMessages;
  readonly getClient: () => DesktopExtensionSurfaceClient | null;
  readonly getContentLocale?: (() => DesktopExtensionContentLocale) | undefined;
  /** Inline hosts provide a back action; sidebar pages use shell navigation instead. */
  readonly onClose?: () => void;
}

export interface DesktopExtensionPageHostController {
  readonly extensionId: string | null;
  readonly isOpen: boolean;
  open(item: HostExtensionValidItem, catalogIcon?: string): void;
  sync(extensions: readonly HostExtensionListItem[]): void;
  syncLocale(): void;
  notifySettingsChanged(extensionId: string, values: JsonObject, revision: number): void;
  close(): void;
  dispose(): void;
}

export function desktopExtensionPageTitle(
  item: HostExtensionValidItem,
  locale: DesktopExtensionContentLocale,
): string {
  const title = item.manifest.page?.title;
  return (
    (title && resolveLocalizedExtensionText(title, locale).trim()) ||
    resolveLocalizedExtensionText(item.manifest.name, locale)
  );
}

export function createDesktopExtensionPageHost({
  document: doc,
  host,
  signal: parentSignal,
  messages,
  getClient,
  getContentLocale = () => messages.locale,
  onClose,
}: DesktopExtensionPageHostOptions): DesktopExtensionPageHostController {
  const copy = messages.desktopExtensions;
  let activeItem: HostExtensionValidItem | null = null;
  let activeCatalogIcon: string | undefined;
  let panel: HTMLElement | undefined;
  let surface: ReturnType<typeof createDesktopExtensionSurface> | undefined;

  const closeInternal = (notifyOwner: boolean): void => {
    const wasOpen = activeItem !== null;
    activeItem = null;
    activeCatalogIcon = undefined;
    surface?.dispose();
    surface = undefined;
    panel?.remove();
    panel = undefined;
    if (wasOpen && notifyOwner) onClose?.();
  };

  const mountActivePage = (): void => {
    const item = activeItem;
    const pageSpec = item?.manifest.page;
    if (!item || !pageSpec || parentSignal.aborted) return;
    surface?.dispose();

    const locale = getContentLocale();
    const pageTitle = desktopExtensionPageTitle(item, locale);
    const version = item.manifest.version.replace(/^v/u, "");

    panel = createEl(doc, "section", "settings-extensions-page-view");
    panel.dataset.extensionId = item.id;
    panel.dataset.activationId = item.activationId;
    panel.dataset.digest = item.digest;

    const header = createEl(doc, "header", "settings-extensions-page-view__header");
    const headerLeft = createEl(doc, "div", "settings-extensions-page-view__header-left");

    if (onClose) {
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
      headerLeft.append(backButton);
    }

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
    const titleEl = createEl(
      doc,
      onClose ? "h2" : "h1",
      "settings-extensions-page-view__title",
      pageTitle,
    );
    const versionEl = createEl(
      doc,
      "span",
      "settings-extensions-page-view__version",
      `v${version}`,
    );
    titleWrap.append(titleEl, versionEl);
    identity.append(titleWrap);
    headerLeft.append(identity);

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
    reloadButton.addEventListener("click", mountActivePage);
    headerActions.append(reloadButton);
    header.append(headerLeft, headerActions);

    const stage = createEl(doc, "div", "settings-extensions-page-view__stage");
    const loadingEl = createEl(doc, "p", "settings-remote__loading");
    loadingEl.setAttribute("role", "status");
    loadingEl.append(createEl(doc, "span", "settings-remote-spinner"), copy.pageLoading);
    stage.append(loadingEl);
    panel.append(header, stage);
    host.replaceChildren(panel);

    const container = createEl(doc, "div", "settings-extensions-page-view__shadow-host");
    container.dataset.extensionPageHost = item.id;
    const instance = createDesktopExtensionSurface({
      container,
      item,
      spec: pageSpec,
      kind: "page",
      getClient,
      getLocale: getContentLocale,
      onRetired: () => {
        queueMicrotask(() => {
          if (surface === instance) mountActivePage();
        });
      },
      noBackendMessage: formatMessage(copy.pageNoBackend, { id: item.id }),
    });
    surface = instance;
    void instance
      .mount(() => stage.replaceChildren(container))
      .catch((cause: unknown) => {
        if (instance.signal.aborted) return;
        instance.dispose();
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
        retryBtn.addEventListener("click", mountActivePage);
        errorBox.append(copyBox, retryBtn);
        stage.replaceChildren(errorBox);
      });
  };

  const onParentAbort = () => closeInternal(false);
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
      if (latest?.state !== "valid" || !latest.enabled || !latest.manifest.page) {
        closeInternal(true);
      } else if (
        latest.activationId !== activeItem.activationId ||
        latest.digest !== activeItem.digest
      ) {
        activeItem = latest;
        mountActivePage();
      }
    },
    syncLocale() {
      surface?.syncLocale();
    },
    notifySettingsChanged(extensionId, values, revision) {
      if (activeItem?.id === extensionId) surface?.notifySettings(values, revision);
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
