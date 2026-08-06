import settingsCss from "./shell.css";
import {
  RendererSettingsNavigationState,
  RendererSettingsPageScope,
  createRendererSettingsPageRegistry,
  type RendererSettingsPageDefinition,
  type RendererSettingsPageRegistry,
} from "./core.js";
import { createRendererSettingsBrandIcon, createRendererSettingsIcon } from "./icons.js";
import {
  DEFAULT_RENDERER_SETTINGS_MESSAGES,
  type RendererSettingsMessages,
} from "./localization.js";
import { createDefaultRendererSettingsRegistry } from "./pages.js";

export const SETTINGS_SHELL_ATTRIBUTE = "data-codexhost-settings-shell";

export interface RendererSettingsShell {
  readonly root: HTMLElement;
  readonly dialog: HTMLDialogElement;
  readonly registry: RendererSettingsPageRegistry;
  readonly supported: boolean;
  readonly activePageId: string;
  readonly open: boolean;
  openSettings(opener?: HTMLElement, pageId?: string): boolean;
  close(): void;
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostSettingsShellV1?: RendererSettingsShell;
  }
}

export function isRendererSettingsDialogSupported(
  dialog: Pick<HTMLDialogElement, "showModal" | "close">,
): boolean {
  return typeof dialog.showModal === "function" && typeof dialog.close === "function";
}

function setActiveNavigation(
  buttons: ReadonlyMap<string, HTMLButtonElement>,
  activePageId: string,
): void {
  for (const [pageId, button] of buttons) {
    if (pageId === activePageId) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

export function mountRendererSettingsShell(
  registry?: RendererSettingsPageRegistry,
  ownerDocument: Document = document,
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
): RendererSettingsShell {
  const resolvedRegistry = registry ?? createDefaultRendererSettingsRegistry(messages);
  if (!ownerDocument.body) throw new Error("Renderer document body is unavailable");
  if (ownerDocument.querySelector(`[${SETTINGS_SHELL_ATTRIBUTE}]`)) {
    throw new Error("A codexhost settings shell is already mounted");
  }

  const root = ownerDocument.createElement("div");
  root.setAttribute(SETTINGS_SHELL_ATTRIBUTE, "v1");
  root.lang = messages.locale;
  root.dataset.theme = "dark";
  const shadow = root.attachShadow({ mode: "open" });
  const style = ownerDocument.createElement("style");
  style.textContent = settingsCss;

  const dialog = ownerDocument.createElement("dialog");
  dialog.className = "codexhost-settings-dialog";
  const frame = ownerDocument.createElement("div");
  frame.className = "settings-frame";

  const header = ownerDocument.createElement("header");
  header.className = "settings-header";
  const brand = ownerDocument.createElement("div");
  brand.className = "settings-brand";
  const brandMark = ownerDocument.createElement("span");
  brandMark.className = "settings-brand__mark";
  brandMark.append(createRendererSettingsBrandIcon(32));
  const brandCopy = ownerDocument.createElement("span");
  brandCopy.className = "settings-brand__copy";
  const brandName = ownerDocument.createElement("span");
  brandName.className = "settings-brand__name";
  brandName.textContent = "Codex Host";
  const brandTitle = ownerDocument.createElement("span");
  brandTitle.className = "settings-brand__title";
  brandTitle.id = "codexhost-settings-dialog-title";
  brandTitle.textContent = messages.title;
  brandCopy.append(brandName, brandTitle);
  brand.append(brandMark, brandCopy);

  const closeButton = ownerDocument.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-icon-button";
  closeButton.setAttribute("aria-label", messages.close);
  closeButton.title = messages.close;
  closeButton.append(createRendererSettingsIcon("close", 18));
  header.append(brand, closeButton);

  const layout = ownerDocument.createElement("div");
  layout.className = "settings-layout";
  const sidebar = ownerDocument.createElement("aside");
  sidebar.className = "settings-sidebar";

  const navigation = ownerDocument.createElement("nav");
  navigation.className = "settings-nav";
  navigation.setAttribute("aria-label", messages.sectionsLabel);
  const page = ownerDocument.createElement("main");
  page.className = "settings-page";
  const pageContent = ownerDocument.createElement("div");
  pageContent.className = "settings-page__content";
  page.append(pageContent);
  sidebar.append(navigation);
  layout.append(sidebar, page);
  frame.append(header, layout);
  dialog.append(frame);
  dialog.setAttribute("aria-labelledby", brandTitle.id);
  shadow.append(style, dialog);
  ownerDocument.body.append(root);

  const navigationState = new RendererSettingsNavigationState(resolvedRegistry);
  const navigationButtons = new Map<string, HTMLButtonElement>();
  let activeScope: RendererSettingsPageScope | null = null;
  let activeCleanup: (() => void) | null = null;
  let opener: HTMLElement | null = null;
  let lifecycleGeneration = 0;
  let disposed = false;

  const disposeActivePage = (): void => {
    activeScope?.dispose();
    activeScope = null;
    const cleanup = activeCleanup;
    activeCleanup = null;
    try {
      cleanup?.();
    } catch {
      // A contributed page cannot block shell navigation or disposal.
    }
  };

  const renderMountFailure = (): void => {
    pageContent.replaceChildren();
    const error = ownerDocument.createElement("div");
    error.className = "settings-page-error";
    error.textContent = messages.pageUnavailable;
    pageContent.append(error);
  };

  const activatePage = (pageId: string): void => {
    const definition = resolvedRegistry.getPage(pageId);
    if (!definition) throw new Error(`Unknown settings page: ${pageId}`);
    navigationState.select(pageId);
    disposeActivePage();
    setActiveNavigation(navigationButtons, pageId);
    pageContent.replaceChildren();
    const scope = new RendererSettingsPageScope();
    activeScope = scope;
    try {
      activeCleanup =
        definition.mount({
          content: pageContent,
          signal: scope.signal,
          runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
        }) ?? null;
    } catch {
      scope.dispose();
      activeScope = null;
      renderMountFailure();
    }
  };

  for (const definition of resolvedRegistry.pages) {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = "settings-nav-button";
    button.dataset.pageId = definition.id;
    button.append(createRendererSettingsIcon(definition.icon, 17));
    const label = ownerDocument.createElement("span");
    label.textContent = definition.label;
    button.append(label);
    navigationButtons.set(definition.id, button);
    navigation.append(button);
  }
  const supported = isRendererSettingsDialogSupported(dialog);
  const focusActiveNavigation = (): void => {
    navigationButtons.get(navigationState.activePageId)?.focus();
  };
  const finishClose = (): void => {
    disposeActivePage();
    navigationState.reset();
    const focusTarget = opener;
    opener = null;
    const closeGeneration = ++lifecycleGeneration;
    const restoreFocus = (): void => {
      if (
        !disposed &&
        closeGeneration === lifecycleGeneration &&
        !dialog.open &&
        focusTarget?.isConnected
      ) {
        focusTarget.focus();
      }
    };
    ownerDocument.defaultView?.setTimeout(restoreFocus, 0);
  };
  const onNavigationClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-page-id]")
        : null;
    const pageId = target?.dataset.pageId;
    if (!pageId || pageId === navigationState.activePageId) return;
    activatePage(pageId);
    target.focus();
  };
  const onCloseClick = (): void => api.close();
  const onDialogClick = (event: MouseEvent): void => {
    if (event.target === dialog) api.close();
  };
  const onDialogClose = (): void => finishClose();
  navigation.addEventListener("click", onNavigationClick);
  closeButton.addEventListener("click", onCloseClick);
  dialog.addEventListener("click", onDialogClick);
  dialog.addEventListener("close", onDialogClose);

  const api: RendererSettingsShell = {
    root,
    dialog,
    registry: resolvedRegistry,
    supported,
    get activePageId() {
      return navigationState.activePageId;
    },
    get open() {
      return dialog.open;
    },
    openSettings(nextOpener, pageId = resolvedRegistry.defaultPageId) {
      if (disposed || !supported || !resolvedRegistry.getPage(pageId)) return false;
      lifecycleGeneration += 1;
      opener = nextOpener?.isConnected ? nextOpener : null;
      activatePage(pageId);
      try {
        if (!dialog.open) dialog.showModal();
      } catch {
        disposeActivePage();
        opener = null;
        return false;
      }
      queueMicrotask(focusActiveNavigation);
      return true;
    },
    close() {
      if (!disposed && dialog.open) dialog.close();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      opener = null;
      navigation.removeEventListener("click", onNavigationClick);
      closeButton.removeEventListener("click", onCloseClick);
      dialog.removeEventListener("click", onDialogClick);
      dialog.removeEventListener("close", onDialogClose);
      if (dialog.open) dialog.close();
      disposeActivePage();
      root.remove();
    },
  };
  return api;
}

export function installRendererSettingsShell(
  definitions?: readonly RendererSettingsPageDefinition[],
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
  ownerDocument: Document = document,
): RendererSettingsShell {
  const registry = definitions
    ? createRendererSettingsPageRegistry(definitions)
    : createDefaultRendererSettingsRegistry(messages);
  const ownerWindow = ownerDocument.defaultView ?? window;
  ownerWindow.__codexhostSettingsShellV1?.dispose();
  const shell = mountRendererSettingsShell(registry, ownerDocument, messages);
  ownerWindow.__codexhostSettingsShellV1 = shell;
  const dispose = shell.dispose.bind(shell);
  shell.dispose = () => {
    dispose();
    if (ownerWindow.__codexhostSettingsShellV1 === shell) {
      delete ownerWindow.__codexhostSettingsShellV1;
    }
  };
  return shell;
}
