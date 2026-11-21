import {
  type DesktopExtensionCatalogEntry,
  type DesktopExtensionCategory,
  type DesktopExtensionMutationResult,
  type DesktopExtensionSelectionParams,
  type DesktopExtensionsCatalogParams,
  type DesktopExtensionsCatalogResult,
  type DesktopExtensionsInstallParams,
  type DesktopExtensionsInstallResult,
  type DesktopExtensionsListResult,
  type DesktopExtensionsRecoveryParams,
  type DesktopExtensionsUninstallParams,
  type DesktopExtensionsUninstallResult,
} from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { renderDesktopExtensionCard } from "./desktop-extensions-card.js";
import type { RendererSettingsPluginPagesSource } from "./desktop-extension-settings-pages.js";
import { createDesktopExtensionDetailModal } from "./desktop-extensions-detail-modal.js";
import { createDesktopExtensionCreateModal } from "./desktop-extensions-create-modal.js";
import { createDesktopExtensionImportModal } from "./desktop-extensions-import-modal.js";
import {
  renderDesktopExtensionsMarketplaceGrid,
  renderMarketplaceFallbackNotice,
} from "./desktop-extensions-marketplace-view.js";
import {
  CATEGORY_ORDER,
  blockedToggleReason,
  catalogDisplayName,
  contentLocaleMessages,
  createEl,
  describeOtherExtension,
  errorMessage,
  extensionDescription,
  extensionDisplayName,
  extensionGroupOf,
  formatMessage,
  formatSlotLabel,
  hasCatalogUpdate,
  isToggleBlocked,
  isWithinElement,
  matchesCatalogSearchQuery,
  matchesInstalledSearchQuery,
  overlappingSlots,
  resolveAttentionDetail,
  resolveInstalledExtensionIconUrl,
  type DesktopExtensionContentLocale,
  type DesktopExtensionContentLocalePreference,
  type DesktopExtensionFeedback,
  type DesktopExtensionItem,
  type DesktopExtensionMutationAction,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

const POLL_INTERVAL_MS = 5_000;
const EXTENSIONS_ROOT_DISPLAY = "$CODEXHOST_DATA_DIR/desktop-extensions/";
const CONTENT_LOCALE_STORAGE_KEY = "codexhost.desktopExtensions.contentLocale";

type ActiveTab = "installed" | "marketplace";

function readContentLocalePreference(
  ownerWindow: Window | null,
): DesktopExtensionContentLocalePreference {
  try {
    const storage =
      ownerWindow?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    const stored = storage?.getItem(CONTENT_LOCALE_STORAGE_KEY);
    if (stored === "system" || stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // Ignore restricted storage environments.
  }
  return "system";
}

function writeContentLocalePreference(
  ownerWindow: Window | null,
  preference: DesktopExtensionContentLocalePreference,
): void {
  try {
    const storage =
      ownerWindow?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    storage?.setItem(CONTENT_LOCALE_STORAGE_KEY, preference);
  } catch {
    // Ignore restricted storage environments.
  }
}

export interface RendererDesktopExtensionsClient {
  listDesktopExtensions?(): Promise<DesktopExtensionsListResult>;
  listDesktopExtensionCatalog?(
    input?: DesktopExtensionsCatalogParams,
  ): Promise<DesktopExtensionsCatalogResult>;
  installDesktopExtension?(
    input: DesktopExtensionsInstallParams,
  ): Promise<DesktopExtensionsInstallResult>;
  uninstallDesktopExtension?(
    input: DesktopExtensionsUninstallParams,
  ): Promise<DesktopExtensionsUninstallResult>;
  enableDesktopExtension?(
    input: DesktopExtensionSelectionParams,
  ): Promise<DesktopExtensionMutationResult>;
  disableDesktopExtension?(
    input: DesktopExtensionSelectionParams,
  ): Promise<DesktopExtensionMutationResult>;
  disableAllDesktopExtensionsAndReload?(
    input?: DesktopExtensionsRecoveryParams,
  ): Promise<DesktopExtensionMutationResult>;
  readDesktopExtensionAsset?(input: {
    id: string;
    path: string;
  }): Promise<{ mimeType: string; dataUrl: string }>;
  getDesktopExtensionSettings?(input: { id: string }): Promise<{ values: Record<string, unknown> }>;
  setDesktopExtensionSettings?(input: {
    id: string;
    values: Record<string, unknown>;
  }): Promise<{ values: Record<string, unknown> }>;
  invokeDesktopExtensionBackend?(input: {
    id: string;
    method: string;
    params?: unknown;
  }): Promise<{ result: unknown }>;
}

function resolveAvailableClient(
  getClient: () => RendererDesktopExtensionsClient | null,
): RendererDesktopExtensionsClient | null {
  const client = getClient();
  return client && typeof client.listDesktopExtensions === "function" ? client : null;
}

export function createDesktopExtensionsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererDesktopExtensionsClient | null = () => null,
  pluginPages?: RendererSettingsPluginPagesSource,
): RendererSettingsPageDefinition {
  const copy = messages.desktopExtensions;
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "desktop-extensions",
    label: messages.pageLabels["desktop-extensions"],
    icon: "extensions",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      const root = createEl(document, "div", "settings-extensions");

      // Header: title + lightweight Desktop connection indicator on left;
      // compact Import + Refresh + More ("...") menu on right.
      const header = createEl(
        document,
        "div",
        "settings-remote__header settings-extensions__header",
      );
      const headerLeft = createEl(document, "div", "settings-extensions__header-left");
      const title = createEl(
        document,
        "h1",
        "settings-section-label",
        messages.pageLabels["desktop-extensions"],
      );
      const connectionBadge = createEl(document, "span", "settings-extensions__connection");
      connectionBadge.hidden = true;
      headerLeft.append(title, connectionBadge);

      const toolbar = createEl(document, "div", "settings-remote__toolbar");

      const localeWrap = createEl(document, "div", "settings-extensions__locale");
      const localeButton = createEl(
        document,
        "button",
        "settings-command-button settings-command-button--secondary settings-extensions__locale-button",
      );
      localeButton.type = "button";
      localeButton.dataset.action = "content-locale-menu";
      localeButton.title = copy.contentLocaleLabel;
      localeButton.setAttribute("aria-label", copy.contentLocaleLabel);
      localeButton.setAttribute("aria-haspopup", "menu");
      localeButton.setAttribute("aria-expanded", "false");
      const localeShortLabel = createEl(document, "span", "settings-extensions__locale-label");
      localeButton.append(
        createRendererSettingsIcon("globe", 13),
        localeShortLabel,
        createRendererSettingsIcon("chevron-down", 12),
      );

      const localeMenu = createEl(
        document,
        "div",
        "settings-extensions-menu settings-extensions-menu--compact",
      );
      localeMenu.dataset.menu = "content-locale";
      localeMenu.setAttribute("role", "menu");
      localeMenu.setAttribute("aria-label", copy.contentLocaleLabel);
      localeMenu.hidden = true;

      const localeOptions: readonly {
        readonly value: DesktopExtensionContentLocalePreference;
        readonly label: string;
      }[] = [
        { value: "system", label: copy.contentLocaleFollowSystem },
        { value: "zh-CN", label: copy.contentLocaleZh },
        { value: "en", label: copy.contentLocaleEn },
      ];
      const localeOptionButtons = new Map<
        DesktopExtensionContentLocalePreference,
        { readonly button: HTMLButtonElement; readonly checkSlot: HTMLSpanElement }
      >();
      for (const option of localeOptions) {
        const itemButton = createEl(
          document,
          "button",
          "settings-extensions-menu__item settings-extensions-menu__item--radio",
        );
        itemButton.type = "button";
        itemButton.setAttribute("role", "menuitemradio");
        itemButton.dataset.contentLocale = option.value;
        const labelSpan = createEl(
          document,
          "span",
          "settings-extensions-menu__item-label",
          option.label,
        );
        const checkSlot = createEl(document, "span", "settings-extensions-menu__check");
        checkSlot.append(createRendererSettingsIcon("check", 13));
        itemButton.append(labelSpan, checkSlot);
        localeMenu.append(itemButton);
        localeOptionButtons.set(option.value, { button: itemButton, checkSlot });
      }
      localeWrap.append(localeButton, localeMenu);

      const createButton = createEl(
        document,
        "button",
        "settings-command-button settings-command-button--secondary settings-extensions__create-button",
      );
      createButton.type = "button";
      createButton.dataset.action = "open-create";
      createButton.append(
        createRendererSettingsIcon("sparkles", 14),
        createEl(document, "span", "", copy.createButton),
      );

      const importButton = createEl(
        document,
        "button",
        "settings-command-button settings-command-button--secondary settings-extensions__import-button",
      );
      importButton.type = "button";
      importButton.dataset.action = "open-import";
      importButton.append(
        createRendererSettingsIcon("upload", 14),
        createEl(document, "span", "", copy.importButton),
      );

      const refreshButton = createEl(
        document,
        "button",
        "settings-icon-button settings-remote__refresh",
      );
      refreshButton.type = "button";
      refreshButton.title = copy.refresh;
      refreshButton.setAttribute("aria-label", copy.refresh);
      refreshButton.append(createRendererSettingsIcon("refresh", 16));

      const moreWrap = createEl(document, "div", "settings-extensions__more");
      const moreButton = createEl(
        document,
        "button",
        "settings-icon-button settings-extensions__more-button",
      );
      moreButton.type = "button";
      moreButton.dataset.action = "more-menu";
      moreButton.title = copy.moreActions;
      moreButton.setAttribute("aria-label", copy.moreActions);
      moreButton.setAttribute("aria-haspopup", "menu");
      moreButton.setAttribute("aria-expanded", "false");
      moreButton.append(createRendererSettingsIcon("ellipsis", 16));

      const moreMenu = createEl(document, "div", "settings-extensions-menu");
      moreMenu.dataset.menu = "more";
      moreMenu.setAttribute("role", "menu");
      moreMenu.hidden = true;

      const copyDirectoryMenuItem = createEl(document, "button", "settings-extensions-menu__item");
      copyDirectoryMenuItem.type = "button";
      copyDirectoryMenuItem.setAttribute("role", "menuitem");
      copyDirectoryMenuItem.dataset.action = "copy-directory";
      const copyDirectoryText = createEl(document, "span", "settings-extensions-menu__item-copy");
      copyDirectoryText.append(
        createEl(
          document,
          "span",
          "settings-extensions-menu__item-label",
          copy.copyDirectoryMenuItem,
        ),
        createEl(document, "code", "settings-extensions-menu__item-sub", EXTENSIONS_ROOT_DISPLAY),
      );
      copyDirectoryMenuItem.append(createRendererSettingsIcon("copy", 14), copyDirectoryText);

      const menuDivider = createEl(document, "div", "settings-extensions-menu__divider");
      menuDivider.setAttribute("role", "separator");

      const recoveryMenuItem = createEl(
        document,
        "button",
        "settings-extensions-menu__item settings-extensions-menu__item--danger",
      );
      recoveryMenuItem.type = "button";
      recoveryMenuItem.setAttribute("role", "menuitem");
      recoveryMenuItem.dataset.action = "open-recovery";
      recoveryMenuItem.append(
        createRendererSettingsIcon("undo", 14),
        createEl(document, "span", "settings-extensions-menu__item-label", copy.recoveryMenuItem),
      );

      moreMenu.append(copyDirectoryMenuItem, menuDivider, recoveryMenuItem);
      moreWrap.append(moreButton, moreMenu);

      toolbar.append(localeWrap, createButton, importButton, refreshButton, moreWrap);
      header.append(headerLeft, toolbar);

      // Persistent top navigation row: segmented tabs (Installed / Marketplace) + search input.
      const controlsBar = createEl(document, "div", "settings-extensions__toolbar");
      controlsBar.hidden = true;

      const tabList = createEl(document, "div", "settings-extensions-segmented");
      tabList.setAttribute("role", "tablist");
      tabList.setAttribute("aria-label", copy.tabListLabel);

      const installedTabButton = createEl(document, "button", "settings-extensions-segmented__tab");
      installedTabButton.type = "button";
      installedTabButton.dataset.tab = "installed";
      installedTabButton.setAttribute("role", "tab");
      installedTabButton.setAttribute("aria-selected", "true");
      installedTabButton.textContent = formatMessage(copy.tabInstalled, { count: "0" });

      const marketplaceTabButton = createEl(
        document,
        "button",
        "settings-extensions-segmented__tab",
      );
      marketplaceTabButton.type = "button";
      marketplaceTabButton.dataset.tab = "marketplace";
      marketplaceTabButton.setAttribute("role", "tab");
      marketplaceTabButton.setAttribute("aria-selected", "false");
      marketplaceTabButton.textContent = formatMessage(copy.tabMarketplace, { count: "0" });

      tabList.append(installedTabButton, marketplaceTabButton);

      const searchBox = createEl(document, "div", "settings-extensions__search");
      const searchIcon = createEl(document, "span", "settings-extensions__search-icon");
      searchIcon.append(createRendererSettingsIcon("search", 13));
      const searchInput = createEl(document, "input", "settings-extensions__search-input");
      searchInput.type = "search";
      searchInput.placeholder = copy.searchPlaceholder;
      searchInput.setAttribute("aria-label", copy.searchLabel);
      const clearSearchButton = createEl(document, "button", "settings-extensions__search-clear");
      clearSearchButton.type = "button";
      clearSearchButton.title = copy.clearSearch;
      clearSearchButton.setAttribute("aria-label", copy.clearSearch);
      clearSearchButton.hidden = true;
      clearSearchButton.append(createRendererSettingsIcon("close", 12));
      searchBox.append(searchIcon, searchInput, clearSearchButton);
      controlsBar.append(tabList, searchBox);

      // Dynamic category filter pills row below tabs.
      const categorySlot = createEl(document, "div", "settings-extensions__category-slot");
      categorySlot.hidden = true;

      const banner = createEl(document, "div", "settings-extensions__banner");
      banner.hidden = true;
      const bannerText = createEl(document, "span");
      const bannerRetry = createEl(
        document,
        "button",
        "settings-command-button settings-command-button--secondary",
        copy.retry,
      );
      bannerRetry.type = "button";
      bannerRetry.hidden = true;
      banner.append(bannerText, bannerRetry);

      const diagnosticsPanel = createEl(document, "section", "settings-extensions__diagnostics");
      diagnosticsPanel.setAttribute("role", "status");
      diagnosticsPanel.hidden = true;

      const body = createEl(document, "div", "settings-extensions__body");

      root.append(header, controlsBar, categorySlot, banner, diagnosticsPanel, body);
      context.content.append(root);

      let disposed = false;
      let moreMenuOpen = false;
      let localeMenuOpen = false;
      let contentLocalePreference: DesktopExtensionContentLocalePreference =
        readContentLocalePreference(ownerWindow);
      let activeTab: ActiveTab = "installed";
      let listing: DesktopExtensionsListResult | null = null;
      let catalog: DesktopExtensionsCatalogResult | null = null;
      let unavailable = false;
      let catalogUnavailable = false;
      let catalogError: string | null = null;
      let loading = false;
      let catalogLoading = false;
      let catalogRequestToken = 0;
      let mutating = false;
      let activeMutationId: string | null = null;
      let activeMutationAction: DesktopExtensionMutationAction | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let activeRecoveryDialog: HTMLDialogElement | null = null;
      let selectedCategory: DesktopExtensionCategory | null = null;
      let searchQuery = "";
      let currentFeedback: DesktopExtensionFeedback | null = null;
      let modalFeedbackExtensionId: string | null = null;

      const clientCapabilities = () => {
        const client = resolveAvailableClient(getClient);
        return {
          client,
          canInstall: !unavailable && Boolean(client?.installDesktopExtension),
          canUninstall: !unavailable && Boolean(client?.uninstallDesktopExtension),
          canRecover: !unavailable && Boolean(client?.disableAllDesktopExtensionsAndReload),
        };
      };

      const resolveContentLocale = (): DesktopExtensionContentLocale =>
        contentLocalePreference === "system" ? messages.locale : contentLocalePreference;

      const syncLocaleControl = (): void => {
        const effective = resolveContentLocale();
        localeShortLabel.textContent = effective === "zh-CN" ? "中" : "EN";
        localeButton.dataset.contentLocale = contentLocalePreference;
        localeButton.dataset.effectiveLocale = effective;
        for (const [value, entry] of localeOptionButtons) {
          const selected = value === contentLocalePreference;
          entry.button.setAttribute("aria-checked", String(selected));
          entry.checkSlot.hidden = !selected;
        }
      };

      const buildDetailModalState = () => {
        const { canInstall, canUninstall } = clientCapabilities();
        return {
          extensions: listing?.extensions ?? [],
          catalogExtensions: catalog?.extensions ?? [],
          contentLocale: resolveContentLocale(),
          hasSettingsPage: pluginPages
            ? (extensionId: string) => pluginPages.hasPageForExtension(extensionId)
            : undefined,
          unavailable,
          canInstall,
          canUninstall,
          mutating,
          activeMutationId,
          activeMutationAction,
          feedback:
            modalFeedbackExtensionId !== null &&
            modalFeedbackExtensionId === detailModal.extensionId
              ? currentFeedback
              : null,
        };
      };

      const detailModal = createDesktopExtensionDetailModal({
        document,
        host: root,
        signal: context.signal,
        messages,
        onToggle: (item, enable) => {
          void toggleExtension(item, enable);
        },
        onInstall: (entry, isUpdate) => {
          void installFromCatalog(entry, isUpdate);
        },
        onUninstall: (item) => {
          void uninstallExtension(item);
        },
        onOpenSettings: pluginPages
          ? (extensionId) => {
              const pageId = pluginPages.getPageIdForExtension(extensionId);
              if (pageId) context.navigateToPage?.(pageId);
            }
          : undefined,
        onClose: () => {
          modalFeedbackExtensionId = null;
        },
      });

      const createModal = createDesktopExtensionCreateModal({
        document,
        host: root,
        signal: context.signal,
        messages,
        getCopy: () => contentLocaleMessages(resolveContentLocale()),
      });

      const importModal = createDesktopExtensionImportModal({
        document,
        host: root,
        signal: context.signal,
        messages,
        onImport: async (source) => {
          await importExtension(source);
        },
      });

      const setFeedback = (
        next: DesktopExtensionFeedback | null,
        modalExtensionId: string | null = null,
      ): void => {
        currentFeedback = next;
        modalFeedbackExtensionId = next ? modalExtensionId : null;
        if (!next) {
          banner.hidden = true;
          bannerText.textContent = "";
          bannerRetry.hidden = true;
          delete banner.dataset.tone;
          return;
        }
        banner.hidden = false;
        banner.dataset.tone = next.tone;
        banner.setAttribute(
          "role",
          next.tone === "danger" || next.tone === "warning" ? "alert" : "status",
        );
        bannerText.textContent = next.text;
        bannerRetry.hidden = !next.retryable;
      };

      const syncToolbarState = (): void => {
        const activeLoading = activeTab === "installed" ? loading : catalogLoading;
        const busy = activeLoading || mutating;
        refreshButton.disabled = busy;
        refreshButton.setAttribute("aria-busy", String(activeLoading));
        refreshButton.title = activeLoading ? copy.refreshing : copy.refresh;
        refreshButton.setAttribute("aria-label", activeLoading ? copy.refreshing : copy.refresh);

        const { canInstall, canRecover } = clientCapabilities();
        importButton.disabled = mutating || !canInstall;
        recoveryMenuItem.disabled = mutating || !canRecover;

        installedTabButton.textContent = formatMessage(copy.tabInstalled, {
          count: String(listing?.extensions.length ?? 0),
        });
        marketplaceTabButton.textContent = formatMessage(copy.tabMarketplace, {
          count: String(catalog?.extensions.length ?? 0),
        });
        installedTabButton.setAttribute("aria-selected", String(activeTab === "installed"));
        marketplaceTabButton.setAttribute("aria-selected", String(activeTab === "marketplace"));
        syncLocaleControl();
      };

      const renderConnectionState = (): void => {
        if (!listing || unavailable || listing.desktopConnected) {
          connectionBadge.hidden = true;
          connectionBadge.textContent = "";
          delete connectionBadge.dataset.tone;
          return;
        }
        connectionBadge.hidden = false;
        connectionBadge.dataset.tone = "neutral";
        connectionBadge.textContent = copy.desktopDisconnected;
      };

      const renderDiagnostics = (): void => {
        if (
          activeTab !== "installed" ||
          !listing ||
          unavailable ||
          listing.diagnostics.length === 0
        ) {
          diagnosticsPanel.hidden = true;
          diagnosticsPanel.replaceChildren();
          return;
        }
        diagnosticsPanel.hidden = false;
        const heading = createEl(document, "div", "settings-extensions__diagnostics-head");
        heading.append(createRendererSettingsIcon("alert", 14), copy.diagnosticsTitle);
        const items = createEl(document, "ul", "settings-extensions__diagnostics-list");
        for (const entry of listing.diagnostics) {
          items.append(createEl(document, "li", "", entry));
        }
        diagnosticsPanel.replaceChildren(heading, items);
      };

      const renderLoading = (label: string): void => {
        const indicator = createEl(document, "p", "settings-remote__loading");
        indicator.setAttribute("role", "status");
        indicator.append(createEl(document, "span", "settings-remote-spinner"), label);
        body.replaceChildren(indicator);
      };

      const renderEmptyBox = (
        headingText: string,
        detailText: string,
        pathHint?: string,
        action?: { label: string; onClick: () => void },
      ): void => {
        const empty = createEl(
          document,
          "div",
          "settings-remote__empty settings-extensions__empty",
        );
        const copyBox = createEl(document, "div");
        copyBox.append(createEl(document, "strong", "", headingText));
        copyBox.append(createEl(document, "span", "", detailText));
        if (pathHint) {
          const pathLine = createEl(document, "code", "settings-extensions__empty-path", pathHint);
          copyBox.append(pathLine);
        }
        empty.append(copyBox);
        if (action) {
          const button = createEl(
            document,
            "button",
            "settings-command-button settings-command-button--secondary",
            action.label,
          );
          button.type = "button";
          button.addEventListener("click", action.onClick);
          empty.append(button);
        }
        body.replaceChildren(empty);
      };

      const renderNoMatchesBox = (prefixNodes: readonly HTMLElement[] = []): void => {
        const empty = createEl(
          document,
          "div",
          "settings-remote__empty settings-extensions__empty settings-extensions__no-matches",
        );
        const copyBox = createEl(document, "div");
        copyBox.append(createEl(document, "strong", "", copy.noMatchesTitle));
        copyBox.append(createEl(document, "span", "", copy.noMatchesDescription));
        const resetButton = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary",
          copy.clearFilters,
        );
        resetButton.type = "button";
        resetButton.addEventListener("click", () => {
          selectedCategory = null;
          searchQuery = "";
          searchInput.value = "";
          clearSearchButton.hidden = true;
          render();
        });
        empty.append(copyBox, resetButton);
        body.replaceChildren(...prefixNodes, empty);
      };

      const renderCategoryFilterBar = (
        presentCategories: ReadonlySet<DesktopExtensionCategory>,
      ): void => {
        const availableCategories = CATEGORY_ORDER.filter((category) =>
          presentCategories.has(category),
        );
        if (availableCategories.length === 0) {
          selectedCategory = null;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          return;
        }
        if (selectedCategory && !availableCategories.includes(selectedCategory)) {
          selectedCategory = null;
        }

        const filterBar = createEl(document, "div", "settings-extensions__filters");
        filterBar.setAttribute("role", "group");
        filterBar.setAttribute("aria-label", copy.categoryFilterLabel);

        const addFilterPill = (label: string, category: DesktopExtensionCategory | null): void => {
          const pill = createEl(document, "button", "settings-extensions-filter-pill", label);
          pill.type = "button";
          pill.dataset.category = category ?? "all";
          pill.setAttribute("aria-pressed", String(selectedCategory === category));
          pill.addEventListener("click", () => {
            if (selectedCategory === category) return;
            selectedCategory = category;
            render();
          });
          filterBar.append(pill);
        };

        const filterCopy = contentLocaleMessages(resolveContentLocale());
        addFilterPill(filterCopy.categoryAll, null);
        for (const category of availableCategories) {
          addFilterPill(filterCopy.categories[category], category);
        }
        categorySlot.hidden = false;
        categorySlot.replaceChildren(filterBar);
      };

      const setLocaleMenuOpen = (open: boolean): void => {
        if (open && moreMenuOpen) setMoreMenuOpen(false);
        localeMenuOpen = open;
        localeMenu.hidden = !open;
        localeButton.setAttribute("aria-expanded", String(open));
      };

      const setMoreMenuOpen = (open: boolean): void => {
        if (open && localeMenuOpen) setLocaleMenuOpen(false);
        moreMenuOpen = open;
        moreMenu.hidden = !open;
        moreButton.setAttribute("aria-expanded", String(open));
      };

      const closeHeaderMenus = (): void => {
        if (moreMenuOpen) setMoreMenuOpen(false);
        if (localeMenuOpen) setLocaleMenuOpen(false);
      };

      const openDetailModal = (extensionId: string): void => {
        if (disposed || context.signal.aborted || activeRecoveryDialog || importModal.isOpen) {
          return;
        }
        closeHeaderMenus();
        if (detailModal.extensionId !== extensionId) {
          modalFeedbackExtensionId = null;
        }
        detailModal.open(extensionId, buildDetailModalState());
      };

      const renderExtensionCard = (
        item: DesktopExtensionItem,
        allExtensions: readonly DesktopExtensionItem[],
        catalogEntry: DesktopExtensionCatalogEntry | undefined,
      ): HTMLElement => {
        const contentLocale = resolveContentLocale();
        const displayName = extensionDisplayName(item, contentLocale);
        const switchId = preferenceId(`desktop-ext-${item.id}`);
        const errorId = preferenceId(`desktop-ext-error-${item.id}`);
        const blocked = isToggleBlocked(item);

        const toggle = createPreferenceSwitch(document, switchId, errorId);
        toggle.checked = item.enabled;
        toggle.setAttribute("aria-label", formatMessage(copy.toggleLabel, { name: displayName }));
        toggle.disabled = mutating || blocked;
        if (blocked) {
          toggle.title = blockedToggleReason(item, copy);
        }
        const stopTrigger = (event: Event): void => {
          event.stopPropagation?.();
        };
        toggle.addEventListener("click", stopTrigger);
        toggle.addEventListener("keydown", stopTrigger);
        toggle.addEventListener("change", () => {
          const desired = toggle.checked;
          if (mutating || blocked) {
            toggle.checked = item.enabled;
            return;
          }
          void toggleExtension(item, desired);
        });

        const updateHint =
          hasCatalogUpdate(item, catalogEntry) && catalogEntry
            ? {
                label: copy.updateAvailable,
                title: formatMessage(copy.updateToVersion, { version: catalogEntry.version }),
              }
            : undefined;

        const attention = resolveAttentionDetail(item, allExtensions, messages.locale, copy);

        return renderDesktopExtensionCard({
          document,
          messages,
          contentLocale,
          extensionId: item.id,
          cardKind: "installed",
          displayName,
          iconUrl: resolveInstalledExtensionIconUrl(item, catalogEntry),
          author: item.manifest?.author ?? catalogEntry?.author,
          version: item.manifest?.version,
          repository: item.manifest?.repository ?? catalogEntry?.repository,
          stars: catalogEntry?.stars,
          downloads: catalogEntry?.downloads,
          trustTier: catalogEntry?.trustTier,
          statusState: item.status.state,
          updateHint,
          description: extensionDescription(item, contentLocale),
          attention,
          attentionId: attention ? errorId : undefined,
          categories: item.manifest?.categories,
          actionControl: toggle,
          busy: activeMutationId === item.id,
          dataset: {
            extensionState: item.status.state,
            trustTier: catalogEntry?.trustTier,
          },
          onOpenDetails: () => openDetailModal(item.id),
        });
      };

      const renderInstalledTab = (): void => {
        if (!listing) {
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          if (loading) renderLoading(copy.loading);
          else body.replaceChildren();
          return;
        }
        if (listing.extensions.length === 0) {
          selectedCategory = null;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          renderEmptyBox(copy.emptyTitle, copy.emptyDescription, copy.emptyPathHint);
          return;
        }

        const presentCategories = new Set<DesktopExtensionCategory>();
        for (const item of listing.extensions) {
          for (const category of item.manifest?.categories ?? []) {
            presentCategories.add(category);
          }
        }
        renderCategoryFilterBar(presentCategories);

        const normalizedQuery = searchQuery.trim().toLowerCase();
        const visibleExtensions = listing.extensions.filter((item) => {
          if (selectedCategory && !item.manifest?.categories?.includes(selectedCategory)) {
            return false;
          }
          return matchesInstalledSearchQuery(item, normalizedQuery);
        });

        if (visibleExtensions.length === 0) {
          renderNoMatchesBox();
          return;
        }

        const catalogById = new Map<string, DesktopExtensionCatalogEntry>();
        for (const entry of catalog?.extensions ?? []) {
          catalogById.set(entry.id, entry);
        }

        const attentionItems: DesktopExtensionItem[] = [];
        const normalItems: DesktopExtensionItem[] = [];
        for (const item of visibleExtensions) {
          if (extensionGroupOf(item.status.state) === "attention") {
            attentionItems.push(item);
          } else {
            normalItems.push(item);
          }
        }

        const contentLocale = resolveContentLocale();
        normalItems.sort((left, right) => {
          const leftRank = left.enabled ? 0 : 1;
          const rightRank = right.enabled ? 0 : 1;
          if (leftRank !== rightRank) return leftRank - rightRank;
          const nameCmp = extensionDisplayName(left, contentLocale).localeCompare(
            extensionDisplayName(right, contentLocale),
            contentLocale,
          );
          if (nameCmp !== 0) return nameCmp;
          return left.id.localeCompare(right.id);
        });

        const allExtensions = listing.extensions;
        const buildGrid = (items: readonly DesktopExtensionItem[]): HTMLElement => {
          const grid = createEl(document, "div", "settings-extensions-grid");
          for (const item of items) {
            grid.append(renderExtensionCard(item, allExtensions, catalogById.get(item.id)));
          }
          return grid;
        };

        if (attentionItems.length === 0) {
          const grid = buildGrid(normalItems);
          grid.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);
          body.replaceChildren(grid);
          return;
        }

        const groupsContainer = createEl(document, "div", "settings-extensions__groups");
        groupsContainer.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);

        const attentionSection = createEl(document, "section", "settings-extensions__group");
        attentionSection.dataset.extensionGroup = "attention";
        const headingId = preferenceId("desktop-ext-group-attention");
        attentionSection.setAttribute("aria-labelledby", headingId);

        const groupHead = createEl(document, "div", "settings-extensions__group-head");
        const groupTitle = createEl(
          document,
          "h2",
          "settings-extensions__group-title",
          copy.groups.attention,
        );
        groupTitle.id = headingId;
        const groupCount = createEl(
          document,
          "span",
          "settings-extensions__group-count",
          String(attentionItems.length),
        );
        groupHead.append(groupTitle, groupCount);
        attentionSection.append(groupHead, buildGrid(attentionItems));
        groupsContainer.append(attentionSection);

        if (normalItems.length > 0) {
          groupsContainer.append(buildGrid(normalItems));
        }

        body.replaceChildren(groupsContainer);
      };

      const renderMarketplaceTab = (): void => {
        if (catalogUnavailable) {
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          renderEmptyBox(copy.marketplaceUnavailableTitle, copy.marketplaceUnavailableDescription);
          return;
        }

        if (!catalog) {
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          if (catalogLoading) {
            renderLoading(copy.marketplaceLoading);
            return;
          }
          if (catalogError) {
            renderEmptyBox(
              copy.marketplaceUnavailableTitle,
              formatMessage(copy.marketplaceLoadFailed, { message: catalogError }),
              undefined,
              {
                label: copy.retry,
                onClick: () => {
                  if (!catalogLoading && !mutating) {
                    void loadCatalog({ forceRefresh: true, silent: false });
                  }
                },
              },
            );
            return;
          }
          renderLoading(copy.marketplaceLoading);
          return;
        }

        const fallbackNotice = renderMarketplaceFallbackNotice(
          document,
          messages,
          catalog,
          catalogLoading || mutating,
          () => {
            if (!catalogLoading && !mutating) {
              void loadCatalog({ forceRefresh: true, silent: false });
            }
          },
        );
        const prefixNodes = fallbackNotice ? [fallbackNotice] : [];

        if (catalog.extensions.length === 0) {
          selectedCategory = null;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          const empty = createEl(
            document,
            "div",
            "settings-remote__empty settings-extensions__empty",
          );
          const copyBox = createEl(document, "div");
          copyBox.append(
            createEl(document, "strong", "", copy.marketplaceEmptyTitle),
            createEl(document, "span", "", copy.marketplaceEmptyDescription),
          );
          empty.append(copyBox);
          body.replaceChildren(...prefixNodes, empty);
          return;
        }

        const presentCategories = new Set<DesktopExtensionCategory>();
        for (const entry of catalog.extensions) {
          for (const category of entry.categories ?? []) {
            presentCategories.add(category);
          }
        }
        renderCategoryFilterBar(presentCategories);

        const normalizedQuery = searchQuery.trim().toLowerCase();
        const visibleEntries = catalog.extensions.filter((entry) => {
          if (selectedCategory && !entry.categories?.includes(selectedCategory)) {
            return false;
          }
          return matchesCatalogSearchQuery(entry, normalizedQuery);
        });

        if (visibleEntries.length === 0) {
          renderNoMatchesBox(prefixNodes);
          return;
        }

        const installedById = new Map<string, DesktopExtensionItem>();
        for (const item of listing?.extensions ?? []) {
          installedById.set(item.id, item);
        }

        const { canInstall } = clientCapabilities();
        const grid = renderDesktopExtensionsMarketplaceGrid({
          document,
          messages,
          contentLocale: resolveContentLocale(),
          catalog,
          visibleEntries,
          installedById,
          canInstall,
          mutating,
          activeMutationId,
          activeMutationAction,
          onOpenDetails: openDetailModal,
          onInstall: (entry, isUpdate) => {
            void installFromCatalog(entry, isUpdate);
          },
          onViewInstalled: () => {
            activeTab = "installed";
            selectedCategory = null;
            searchQuery = "";
            searchInput.value = "";
            clearSearchButton.hidden = true;
            setFeedback(null);
            render();
          },
          onRetryCatalog: () => {
            if (!catalogLoading && !mutating) {
              void loadCatalog({ forceRefresh: true, silent: false });
            }
          },
        });

        body.replaceChildren(...prefixNodes, grid);
      };

      const render = (): void => {
        syncToolbarState();
        renderConnectionState();
        renderDiagnostics();

        if (unavailable) {
          controlsBar.hidden = true;
          categorySlot.hidden = true;
          categorySlot.replaceChildren();
          renderEmptyBox(copy.unavailableTitle, copy.unavailableDescription);
          detailModal.sync(buildDetailModalState());
          return;
        }

        controlsBar.hidden = false;
        clearSearchButton.hidden = searchQuery.length === 0;

        if (activeTab === "installed") {
          renderInstalledTab();
        } else {
          renderMarketplaceTab();
        }

        detailModal.sync(buildDetailModalState());
      };

      const clearPollTimer = (): void => {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      };

      const schedulePoll = (): void => {
        clearPollTimer();
        if (disposed || context.signal.aborted || document.visibilityState === "hidden") return;
        pollTimer = setTimeout(() => {
          if (
            disposed ||
            context.signal.aborted ||
            mutating ||
            loading ||
            activeRecoveryDialog ||
            importModal.isOpen
          ) {
            schedulePoll();
            return;
          }
          void loadInstalled({ silent: true });
        }, POLL_INTERVAL_MS);
      };

      const loadInstalled = async (
        options: { silent?: boolean; keepFeedback?: boolean } = {},
      ): Promise<void> => {
        const silent = options.silent ?? false;
        const keepFeedback = options.keepFeedback ?? silent;
        const client = resolveAvailableClient(getClient);
        if (!client?.listDesktopExtensions) {
          unavailable = true;
          listing = null;
          loading = false;
          if (!keepFeedback) setFeedback(null);
          render();
          schedulePoll();
          return;
        }

        if (!silent) {
          loading = true;
          if (!keepFeedback) setFeedback(null);
          render();
        }

        const listDesktopExtensions = client.listDesktopExtensions.bind(client);
        await context.runLatest(async () => listDesktopExtensions(), {
          success(result) {
            loading = false;
            unavailable = false;
            listing = result;
            pluginPages?.syncInstalledExtensions?.(
              result.extensions,
              result.configuration.revision,
            );
            if (!keepFeedback) setFeedback(null);
            render();
            schedulePoll();
          },
          failure(error) {
            loading = false;
            if (error instanceof RendererMethodUnavailableError) {
              unavailable = true;
              listing = null;
              setFeedback(null);
              render();
              return;
            }
            if (!silent || !listing) {
              setFeedback({
                tone: "danger",
                text: formatMessage(copy.loadFailed, { message: errorMessage(error) }),
                retryable: true,
              });
            }
            render();
            schedulePoll();
          },
        });
      };

      const loadCatalog = async (
        options: { forceRefresh?: boolean; silent?: boolean } = {},
      ): Promise<void> => {
        const forceRefresh = options.forceRefresh ?? false;
        const silent = options.silent ?? false;
        const client = resolveAvailableClient(getClient);
        if (!client?.listDesktopExtensionCatalog) {
          catalogUnavailable = true;
          catalogLoading = false;
          if (activeTab === "marketplace") render();
          return;
        }

        const token = ++catalogRequestToken;
        catalogLoading = true;
        catalogError = null;
        if (!silent) {
          setFeedback(null);
          render();
        } else {
          syncToolbarState();
        }

        try {
          const params: DesktopExtensionsCatalogParams = forceRefresh ? { forceRefresh: true } : {};
          const result = await client.listDesktopExtensionCatalog(params);
          if (disposed || context.signal.aborted || token !== catalogRequestToken) return;
          catalogLoading = false;
          catalogUnavailable = false;
          catalogError = null;
          catalog = result;
          render();
        } catch (error) {
          if (disposed || context.signal.aborted || token !== catalogRequestToken) return;
          catalogLoading = false;
          if (error instanceof RendererMethodUnavailableError) {
            catalogUnavailable = true;
            catalog = null;
            render();
            return;
          }
          catalogError = errorMessage(error);
          if (!silent && activeTab === "marketplace" && catalog) {
            setFeedback({
              tone: "danger",
              text: formatMessage(copy.marketplaceLoadFailed, { message: catalogError }),
              retryable: true,
            });
          }
          render();
        }
      };

      const resolveDisplayNameFromList = (
        listResult: DesktopExtensionsListResult,
        extensionId: string,
        fallbackName?: string,
      ): string => {
        const match = listResult.extensions.find((item) => item.id === extensionId);
        if (match?.manifest) return extensionDisplayName(match, messages.locale);
        return fallbackName ?? extensionId;
      };

      const installFromCatalog = async (
        entry: DesktopExtensionCatalogEntry,
        isUpdate: boolean,
      ): Promise<void> => {
        if (mutating || disposed || context.signal.aborted) return;
        const client = resolveAvailableClient(getClient);
        const install = client?.installDesktopExtension?.bind(client);
        if (!install) return;

        const fallbackName = catalogDisplayName(entry, messages.locale);
        const modalTargetId = detailModal.extensionId === entry.id ? entry.id : null;
        mutating = true;
        activeMutationId = entry.id;
        activeMutationAction = isUpdate ? "update" : "install";
        clearPollTimer();
        render();

        try {
          const result = await install({ source: { type: "catalog", id: entry.id } });
          if (disposed || context.signal.aborted) return;
          listing = result.list;
          pluginPages?.syncInstalledExtensions?.(
            result.list.extensions,
            result.list.configuration.revision,
          );
          const displayName = resolveDisplayNameFromList(
            result.list,
            result.extensionId,
            fallbackName,
          );
          setFeedback(
            {
              tone: "success",
              text: formatMessage(
                result.replaced || isUpdate ? copy.updatedSuccess : copy.installedSuccess,
                { name: displayName, version: result.version },
              ),
            },
            modalTargetId,
          );
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.installFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
        } finally {
          if (!disposed && !context.signal.aborted) {
            mutating = false;
            activeMutationId = null;
            activeMutationAction = null;
            render();
            schedulePoll();
          }
        }
      };

      const importExtension = async (
        source: DesktopExtensionsInstallParams["source"],
      ): Promise<void> => {
        const client = resolveAvailableClient(getClient);
        const install = client?.installDesktopExtension?.bind(client);
        if (!install) {
          throw new Error(copy.importUnavailable);
        }
        mutating = true;
        activeMutationId = null;
        activeMutationAction = "install";
        clearPollTimer();
        syncToolbarState();

        try {
          const result = await install({ source });
          if (disposed || context.signal.aborted) return;
          listing = result.list;
          pluginPages?.syncInstalledExtensions?.(
            result.list.extensions,
            result.list.configuration.revision,
          );
          activeTab = "installed";
          selectedCategory = null;
          searchQuery = "";
          searchInput.value = "";
          clearSearchButton.hidden = true;
          const displayName = resolveDisplayNameFromList(result.list, result.extensionId);
          setFeedback({
            tone: "success",
            text: formatMessage(result.replaced ? copy.updatedSuccess : copy.installedSuccess, {
              name: displayName,
              version: result.version,
            }),
          });
        } finally {
          if (!disposed && !context.signal.aborted) {
            mutating = false;
            activeMutationId = null;
            activeMutationAction = null;
            render();
            schedulePoll();
          }
        }
      };

      const uninstallExtension = async (item: DesktopExtensionItem): Promise<void> => {
        if (mutating || disposed || context.signal.aborted) return;
        const client = resolveAvailableClient(getClient);
        const uninstall = client?.uninstallDesktopExtension?.bind(client);
        if (!uninstall) return;

        const displayName = extensionDisplayName(item, messages.locale);
        const modalTargetId = detailModal.extensionId === item.id ? item.id : null;
        mutating = true;
        activeMutationId = item.id;
        activeMutationAction = "uninstall";
        clearPollTimer();
        render();

        try {
          const result = await uninstall({ id: item.id });
          if (disposed || context.signal.aborted) return;
          listing = result.list;
          pluginPages?.syncInstalledExtensions?.(
            result.list.extensions,
            result.list.configuration.revision,
          );
          detailModal.close();
          setFeedback({
            tone: "success",
            text: formatMessage(copy.uninstalledSuccess, { name: displayName }),
          });
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.uninstallFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
        } finally {
          if (!disposed && !context.signal.aborted) {
            mutating = false;
            activeMutationId = null;
            activeMutationAction = null;
            render();
            schedulePoll();
          }
        }
      };

      const toggleExtension = async (
        item: DesktopExtensionItem,
        enable: boolean,
      ): Promise<void> => {
        if (mutating || disposed || context.signal.aborted) return;
        const client = resolveAvailableClient(getClient);
        const mutate = enable
          ? client?.enableDesktopExtension?.bind(client)
          : client?.disableDesktopExtension?.bind(client);
        if (!mutate) {
          unavailable = true;
          render();
          return;
        }
        const expectedRevision = listing?.configuration.revision ?? 0;
        const displayName = extensionDisplayName(item, messages.locale);
        const modalTargetId = detailModal.extensionId === item.id ? item.id : null;
        mutating = true;
        activeMutationId = item.id;
        activeMutationAction = "toggle";
        clearPollTimer();
        render();

        try {
          const result = await mutate({ id: item.id, expectedRevision });
          if (disposed || context.signal.aborted) return;

          if (result.state === "saved") {
            if (listing) {
              listing = {
                ...listing,
                configuration: result.configuration,
                extensions: listing.extensions.map((entry) =>
                  entry.id === item.id ? { ...entry, enabled: enable } : entry,
                ),
              };
              pluginPages?.syncInstalledExtensions?.(
                listing.extensions,
                listing.configuration.revision,
              );
            }
            setFeedback(
              {
                tone: "success",
                text: formatMessage(enable ? copy.savedEnabled : copy.savedDisabled, {
                  name: displayName,
                }),
              },
              modalTargetId,
            );
            mutating = false;
            activeMutationId = null;
            activeMutationAction = null;
            render();
            await loadInstalled({ silent: true, keepFeedback: true });
            return;
          }

          if (result.state === "slot-conflict") {
            const allExtensions = listing?.extensions ?? [];
            const other = describeOtherExtension(
              result.conflictWith,
              allExtensions,
              messages.locale,
            );
            const shared = overlappingSlots(item, result.conflictWith, allExtensions);
            setFeedback(
              {
                tone: "warning",
                text:
                  shared.length > 0
                    ? formatMessage(copy.slotConflictBannerWithSlots, {
                        name: displayName,
                        slots: shared.map((slot) => formatSlotLabel(slot, copy)).join(", "),
                        other,
                      })
                    : formatMessage(copy.slotConflictBanner, {
                        name: displayName,
                        other,
                      }),
              },
              modalTargetId,
            );
            return;
          }

          if (result.state === "revision-conflict") {
            setFeedback(
              {
                tone: "warning",
                text: copy.revisionConflictBanner,
              },
              modalTargetId,
            );
            mutating = false;
            activeMutationId = null;
            activeMutationAction = null;
            render();
            await loadInstalled({ silent: true, keepFeedback: true });
            return;
          }
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          if (error instanceof RendererMethodUnavailableError) {
            unavailable = true;
            listing = null;
            setFeedback(null);
            return;
          }
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.actionFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
        } finally {
          if (!disposed && !context.signal.aborted) {
            mutating = false;
            activeMutationId = null;
            activeMutationAction = null;
            render();
            schedulePoll();
          }
        }
      };

      const openRecoveryDialog = (): void => {
        if (disposed || context.signal.aborted || mutating || activeRecoveryDialog) return;
        const client = resolveAvailableClient(getClient);
        if (!client?.disableAllDesktopExtensionsAndReload) return;
        detailModal.close();
        importModal.close();

        const modal = createEl(
          document,
          "dialog",
          "settings-account-dialog settings-credential-dialog settings-extensions-dialog",
        );
        const form = createEl(document, "form");
        const heading = createEl(document, "h2", "", copy.recoveryDialogTitle);
        heading.id = preferenceId("extensions-recovery-title");
        modal.setAttribute("aria-labelledby", heading.id);

        const dialogBody = createEl(document, "div", "settings-credential-dialog__body");
        dialogBody.append(createEl(document, "p", "", copy.recoveryDialogDescription));
        if (listing && !listing.desktopConnected) {
          dialogBody.append(
            createEl(
              document,
              "p",
              "settings-extensions-dialog__note",
              copy.recoveryDialogOfflineNote,
            ),
          );
        }

        const dialogError = createEl(document, "p", "settings-credential-dialog__error");
        dialogError.setAttribute("role", "alert");

        const actions = createEl(document, "div", "settings-credential-dialog__actions");
        const cancel = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary",
          copy.recoveryDialogCancel,
        );
        cancel.type = "button";
        const confirm = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary settings-command-button--danger",
          copy.recoveryDialogConfirm,
        );
        confirm.type = "submit";
        actions.append(cancel, confirm);
        form.append(heading, dialogBody, dialogError, actions);
        modal.append(form);

        let dialogBusy = false;
        const setDialogBusy = (next: boolean): void => {
          dialogBusy = next;
          cancel.disabled = next;
          confirm.disabled = next;
          confirm.textContent = next ? copy.recoveryDialogBusy : copy.recoveryDialogConfirm;
          modal.setAttribute("aria-busy", String(next));
        };

        const cleanupDialog = (): void => {
          context.signal.removeEventListener("abort", cleanupDialog);
          if (activeRecoveryDialog === modal) activeRecoveryDialog = null;
          modal.remove();
        };

        cancel.addEventListener("click", () => {
          if (!dialogBusy) modal.close();
        });
        modal.addEventListener("cancel", (event) => {
          if (dialogBusy) event.preventDefault();
        });
        modal.addEventListener("close", cleanupDialog);
        context.signal.addEventListener("abort", cleanupDialog, { once: true });

        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (dialogBusy || mutating) return;
          const recover = resolveAvailableClient(getClient)?.disableAllDesktopExtensionsAndReload;
          if (!recover) {
            modal.close();
            unavailable = true;
            render();
            return;
          }

          dialogError.textContent = "";
          setDialogBusy(true);
          mutating = true;
          clearPollTimer();
          syncToolbarState();

          const params: DesktopExtensionsRecoveryParams =
            listing !== null ? { expectedRevision: listing.configuration.revision } : {};

          void recover(params)
            .then(async (result) => {
              if (disposed || context.signal.aborted) return;
              if (result.state === "saved") {
                if (listing) {
                  listing = {
                    ...listing,
                    configuration: result.configuration,
                    extensions: listing.extensions.map((entry) => ({
                      ...entry,
                      enabled: false,
                    })),
                  };
                  pluginPages?.syncInstalledExtensions?.(
                    listing.extensions,
                    listing.configuration.revision,
                  );
                }
                setFeedback({
                  tone: "info",
                  text: copy.recoverySaved,
                });
                mutating = false;
                modal.close();
                render();
                await loadInstalled({ silent: true, keepFeedback: true });
                return;
              }

              if (result.state === "revision-conflict") {
                setFeedback({
                  tone: "warning",
                  text: copy.revisionConflictBanner,
                });
                mutating = false;
                modal.close();
                render();
                await loadInstalled({ silent: true, keepFeedback: true });
                return;
              }

              mutating = false;
              setDialogBusy(false);
              syncToolbarState();
            })
            .catch((error: unknown) => {
              if (disposed || context.signal.aborted) return;
              mutating = false;
              setDialogBusy(false);
              syncToolbarState();
              if (error instanceof RendererMethodUnavailableError) {
                modal.close();
                unavailable = true;
                listing = null;
                setFeedback(null);
                render();
                return;
              }
              dialogError.textContent = formatMessage(copy.actionFailed, {
                message: errorMessage(error),
              });
            });
        });

        activeRecoveryDialog = modal;
        root.append(modal);
        modal.showModal();
      };

      const switchTab = (next: ActiveTab): void => {
        if (activeTab === next) return;
        closeHeaderMenus();
        activeTab = next;
        setFeedback(null);
        render();
        if (next === "marketplace" && !catalog && !catalogLoading && !catalogUnavailable) {
          void loadCatalog({ forceRefresh: false, silent: false });
        }
      };

      const onVisibilityChange = (): void => {
        if (document.visibilityState === "hidden") clearPollTimer();
        else if (
          !disposed &&
          !context.signal.aborted &&
          !mutating &&
          !loading &&
          !activeRecoveryDialog &&
          !importModal.isOpen
        ) {
          void loadInstalled({ silent: true });
        }
      };

      const onDocumentClick = (event?: Event): void => {
        if (moreMenuOpen && !(event?.target && isWithinElement(event.target, moreWrap))) {
          setMoreMenuOpen(false);
        }
        if (localeMenuOpen && !(event?.target && isWithinElement(event.target, localeWrap))) {
          setLocaleMenuOpen(false);
        }
      };

      const onDocumentKeyDown = (event?: Event): void => {
        if (!moreMenuOpen && !localeMenuOpen) return;
        const key = (event as KeyboardEvent | undefined)?.key;
        if (key !== "Escape") return;
        event?.preventDefault?.();
        if (localeMenuOpen) {
          setLocaleMenuOpen(false);
          localeButton.focus?.();
        }
        if (moreMenuOpen) {
          setMoreMenuOpen(false);
          moreButton.focus?.();
        }
      };

      localeButton.addEventListener("click", (event) => {
        event.stopPropagation?.();
        setLocaleMenuOpen(!localeMenuOpen);
      });

      for (const [value, { button }] of localeOptionButtons) {
        button.addEventListener("click", () => {
          setLocaleMenuOpen(false);
          if (contentLocalePreference === value) return;
          contentLocalePreference = value;
          writeContentLocalePreference(ownerWindow, value);
          render();
        });
      }

      moreButton.addEventListener("click", (event) => {
        event.stopPropagation?.();
        setMoreMenuOpen(!moreMenuOpen);
      });

      copyDirectoryMenuItem.addEventListener("click", () => {
        setMoreMenuOpen(false);
        const clipboard = ownerWindow?.navigator?.clipboard;
        if (!clipboard) {
          setFeedback({ tone: "danger", text: copy.copyPathFailed });
          return;
        }
        void clipboard.writeText(EXTENSIONS_ROOT_DISPLAY).then(
          () => {
            if (!disposed && !context.signal.aborted) {
              setFeedback({ tone: "success", text: copy.copiedDirectoryPath });
            }
          },
          () => {
            if (!disposed && !context.signal.aborted) {
              setFeedback({ tone: "danger", text: copy.copyPathFailed });
            }
          },
        );
      });

      recoveryMenuItem.addEventListener("click", () => {
        setMoreMenuOpen(false);
        openRecoveryDialog();
      });

      installedTabButton.addEventListener("click", () => switchTab("installed"));
      marketplaceTabButton.addEventListener("click", () => switchTab("marketplace"));

      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        clearSearchButton.hidden = searchQuery.length === 0;
        render();
      });
      clearSearchButton.addEventListener("click", () => {
        searchQuery = "";
        searchInput.value = "";
        clearSearchButton.hidden = true;
        render();
        searchInput.focus?.();
      });

      createButton.addEventListener("click", () => {
        closeHeaderMenus();
        detailModal.close();
        importModal.close();
        createModal.open();
      });

      importButton.addEventListener("click", () => {
        if (mutating || !clientCapabilities().canInstall) return;
        closeHeaderMenus();
        detailModal.close();
        createModal.close();
        importModal.open();
      });

      refreshButton.addEventListener("click", () => {
        if (mutating) return;
        closeHeaderMenus();
        if (activeTab === "marketplace") {
          if (!catalogLoading) void loadCatalog({ forceRefresh: true, silent: false });
        } else if (!loading) {
          void loadInstalled({ silent: false, keepFeedback: false });
        }
      });

      bannerRetry.addEventListener("click", () => {
        if (mutating) return;
        if (activeTab === "marketplace") {
          if (!catalogLoading) void loadCatalog({ forceRefresh: true, silent: false });
        } else if (!loading) {
          void loadInstalled({ silent: false, keepFeedback: false });
        }
      });

      const unsubscribePluginPages =
        pluginPages?.subscribe(() => {
          if (!disposed && !context.signal.aborted) {
            detailModal.sync(buildDetailModalState());
          }
        }) ?? null;

      document.addEventListener?.("visibilitychange", onVisibilityChange);
      document.addEventListener?.("click", onDocumentClick);
      document.addEventListener?.("keydown", onDocumentKeyDown);

      void loadInstalled({ silent: false });
      if (resolveAvailableClient(getClient)?.listDesktopExtensionCatalog) {
        void loadCatalog({ forceRefresh: false, silent: true });
      }

      return () => {
        disposed = true;
        clearPollTimer();
        unsubscribePluginPages?.();
        document.removeEventListener?.("visibilitychange", onVisibilityChange);
        document.removeEventListener?.("click", onDocumentClick);
        document.removeEventListener?.("keydown", onDocumentKeyDown);
        detailModal.dispose();
        createModal.dispose();
        importModal.dispose();
        activeRecoveryDialog?.remove();
        activeRecoveryDialog = null;
      };
    },
  });
}
