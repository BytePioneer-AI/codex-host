import settingsCss from "./shell.css";
import {
  RendererSettingsNavigationState,
  RendererSettingsPageScope,
  createRendererSettingsPageRegistry,
  type RendererSettingsPageDefinition,
  type RendererSettingsPageRegistry,
} from "./core.js";
import { createRendererSettingsBrandIcon, createRendererSettingsIcon } from "./icons.js";
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

function rendererSettingsTheme(ownerDocument: Document): "light" | "dark" {
  const documentElement = ownerDocument.documentElement;
  const explicitTheme = documentElement.dataset.theme?.toLowerCase();
  const className = documentElement.className.toLowerCase();
  if (explicitTheme === "dark" || className.includes("electron-dark")) return "dark";
  if (explicitTheme === "light" || className.includes("electron-light")) return "light";
  const colorScheme = ownerDocument.defaultView
    ?.getComputedStyle(documentElement)
    .colorScheme.trim()
    .toLowerCase();
  if (colorScheme?.startsWith("dark")) return "dark";
  if (colorScheme?.startsWith("light")) return "light";
  return ownerDocument.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
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
  registry: RendererSettingsPageRegistry = createDefaultRendererSettingsRegistry(),
  ownerDocument: Document = document,
): RendererSettingsShell {
  if (!ownerDocument.body) throw new Error("Renderer document body is unavailable");
  if (ownerDocument.querySelector(`[${SETTINGS_SHELL_ATTRIBUTE}]`)) {
    throw new Error("A codexhost settings shell is already mounted");
  }

  const root = ownerDocument.createElement("div");
  root.setAttribute(SETTINGS_SHELL_ATTRIBUTE, "v1");
  const updateTheme = (): void => {
    root.dataset.theme = rendererSettingsTheme(ownerDocument);
  };
  const defaultView = ownerDocument.defaultView;
  const themeObserver = defaultView ? new defaultView.MutationObserver(updateTheme) : null;
  const themeMedia = defaultView?.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  updateTheme();
  themeObserver?.observe(ownerDocument.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  themeMedia?.addEventListener("change", updateTheme);
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
  brandMark.append(createRendererSettingsBrandIcon());
  const brandCopy = ownerDocument.createElement("span");
  brandCopy.className = "settings-brand__copy";
  const brandName = ownerDocument.createElement("span");
  brandName.className = "settings-brand__name";
  brandName.textContent = "codexhost";
  const brandTitle = ownerDocument.createElement("span");
  brandTitle.className = "settings-brand__title";
  brandTitle.textContent = "Settings";
  brandCopy.append(brandName, brandTitle);
  brand.append(brandMark, brandCopy);

  const closeButton = ownerDocument.createElement("button");
  closeButton.type = "button";
  closeButton.className = "settings-icon-button";
  closeButton.setAttribute("aria-label", "Close settings");
  closeButton.title = "Close settings";
  closeButton.append(createRendererSettingsIcon("close", 18));
  header.append(brand);

  const layout = ownerDocument.createElement("div");
  layout.className = "settings-layout";
  const sidebar = ownerDocument.createElement("aside");
  sidebar.className = "settings-sidebar";
  const searchControl = ownerDocument.createElement("div");
  searchControl.className = "settings-search";
  searchControl.append(createRendererSettingsIcon("search", 14));
  const searchInput = ownerDocument.createElement("input");
  searchInput.type = "search";
  searchInput.setAttribute("role", "searchbox");
  searchInput.setAttribute("aria-label", "Search settings");
  searchInput.placeholder = "Search settings...";
  searchControl.append(searchInput);
  const navigation = ownerDocument.createElement("nav");
  navigation.className = "settings-nav";
  navigation.setAttribute("aria-label", "Settings sections");
  const navigationGroup = ownerDocument.createElement("div");
  navigationGroup.className = "settings-nav__group";
  navigationGroup.textContent = "codexhost";
  const searchEmpty = ownerDocument.createElement("div");
  searchEmpty.className = "settings-nav__empty";
  searchEmpty.setAttribute("role", "status");
  searchEmpty.textContent = "No results found";
  searchEmpty.hidden = true;
  navigation.append(navigationGroup);
  const page = ownerDocument.createElement("main");
  page.className = "settings-page";
  const pageHeader = ownerDocument.createElement("div");
  pageHeader.className = "settings-page__header";
  const pageTitle = ownerDocument.createElement("h1");
  pageTitle.className = "settings-page__title";
  pageTitle.id = "codexhost-settings-page-title";
  pageHeader.append(pageTitle, closeButton);
  const pageContent = ownerDocument.createElement("div");
  pageContent.className = "settings-page__content";
  page.append(pageHeader, pageContent);
  sidebar.append(header, searchControl, navigation);
  layout.append(sidebar, page);
  frame.append(layout);
  dialog.append(frame);
  dialog.setAttribute("aria-labelledby", pageTitle.id);
  shadow.append(style, dialog);
  ownerDocument.body.append(root);

  const navigationState = new RendererSettingsNavigationState(registry);
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
    error.textContent = "Page unavailable";
    pageContent.append(error);
  };

  const activatePage = (pageId: string): void => {
    const definition = registry.getPage(pageId);
    if (!definition) throw new Error(`Unknown settings page: ${pageId}`);
    navigationState.select(pageId);
    disposeActivePage();
    setActiveNavigation(navigationButtons, pageId);
    pageTitle.textContent = definition.label;
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

  for (const definition of registry.pages) {
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
  navigation.append(searchEmpty);

  const onSearchInput = (): void => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    let visibleCount = 0;
    for (const definition of registry.pages) {
      const button = navigationButtons.get(definition.id);
      if (!button) continue;
      const visible = query.length === 0 || definition.label.toLocaleLowerCase().includes(query);
      button.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    searchEmpty.hidden = visibleCount !== 0;
  };
  searchInput.addEventListener("input", onSearchInput);

  const supported = isRendererSettingsDialogSupported(dialog);
  const focusActiveNavigation = (): void => {
    navigationButtons.get(navigationState.activePageId)?.focus();
  };
  const finishClose = (): void => {
    disposeActivePage();
    navigationState.reset();
    searchInput.value = "";
    onSearchInput();
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
    registry,
    supported,
    get activePageId() {
      return navigationState.activePageId;
    },
    get open() {
      return dialog.open;
    },
    openSettings(nextOpener, pageId = registry.defaultPageId) {
      if (disposed || !supported || !registry.getPage(pageId)) return false;
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
      themeObserver?.disconnect();
      themeMedia?.removeEventListener("change", updateTheme);
      navigation.removeEventListener("click", onNavigationClick);
      searchInput.removeEventListener("input", onSearchInput);
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
): RendererSettingsShell {
  const registry = definitions
    ? createRendererSettingsPageRegistry(
        definitions,
        definitions.some(({ id }) => id === "overview")
          ? "overview"
          : (definitions[0]?.id ?? "overview"),
      )
    : createDefaultRendererSettingsRegistry();
  window.__codexhostSettingsShellV1?.dispose();
  const shell = mountRendererSettingsShell(registry);
  window.__codexhostSettingsShellV1 = shell;
  const dispose = shell.dispose.bind(shell);
  shell.dispose = () => {
    dispose();
    if (window.__codexhostSettingsShellV1 === shell) delete window.__codexhostSettingsShellV1;
  };
  return shell;
}
