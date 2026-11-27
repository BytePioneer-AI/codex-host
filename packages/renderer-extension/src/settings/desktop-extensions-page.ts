import {
  type HOST_EXTENSIONS_RPC,
  type HostExtensionCatalogEntry,
  type HostExtensionInstallSource,
  type HostExtensionListItem,
  type HostExtensionsCatalogResult,
  type HostExtensionsListResult,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
  type DesktopExtensionCategory,
} from "@codexhost/shared-contracts";
import { RendererMethodUnavailableError } from "../renderer-request-sender.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createDesktopExtensionPageHost } from "./desktop-extension-page-host.js";
import type { RendererSettingsPluginPagesSource } from "./desktop-extension-settings-pages.js";
import { renderDesktopExtensionCard } from "./desktop-extensions-card.js";
import { createDesktopCatalogIconLoader } from "./desktop-extensions-catalog-icons.js";
import { createDesktopExtensionCreateModal } from "./desktop-extensions-create-modal.js";
import { createDesktopExtensionDetailModal } from "./desktop-extensions-detail-modal.js";
import { createDesktopExtensionImportModal } from "./desktop-extensions-import-modal.js";
import {
  renderDesktopExtensionsMarketplaceGrid,
  renderMarketplaceFallbackNotice,
} from "./desktop-extensions-marketplace-view.js";
import {
  CAPABILITY_FILTER_ORDER,
  CATEGORY_ORDER,
  CONTENT_LOCALE_STORAGE_KEY,
  blockedToggleReason,
  capabilityFilterLabel,
  catalogCapabilities,
  catalogDisplayName,
  contentLocaleMessages,
  createEl,
  derivePlatformBadge,
  errorMessage,
  extensionDescription,
  extensionDisplayName,
  formatMessage,
  hasCatalogUpdate,
  isToggleBlocked,
  isWithinElement,
  itemCapabilities,
  itemStatusState,
  itemTargets,
  matchesCapabilityFilter,
  needsAttention,
  matchesCatalogSearchQuery,
  matchesInstalledSearchQuery,
  parseSafeExtensionIconUrl,
  readContentLocalePreference,
  resolveAttentionDetail,
  resolveInstalledExtensionIconUrl,
  type DesktopExtensionContentLocale,
  type DesktopExtensionContentLocalePreference,
  type DesktopExtensionFeedback,
  type DesktopExtensionMutationAction,
  type ExtensionCapabilityFilter,
  type HostExtensionValidItem,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

const POLL_INTERVAL_MS = 5_000;
const EXTENSIONS_ROOT_DISPLAY = "$CODEXHOST_DATA_DIR/host-extensions/";

type NavView = "all" | "installed" | DesktopExtensionCategory;

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
  listHostExtensions?(): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.list>>;
  snapshotHostExtensions?(): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.snapshot>>;
  listHostExtensionCatalog?(
    input?: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.catalog>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.catalog>>;
  readHostExtensionCatalogIcon?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.catalogIcon>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.catalogIcon>>;
  installHostExtension?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.install>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.install>>;
  updateHostExtension?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.update>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.update>>;
  enableHostExtension?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.enable>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.enable>>;
  disableHostExtension?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.disable>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.disable>>;
  uninstallHostExtension?(
    input: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.uninstall>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.uninstall>>;
  recoverHostExtensions?(
    input?: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.recover>,
  ): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.recover>>;
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

function resolveAvailableClient(
  getClient: () => RendererDesktopExtensionsClient | null,
): RendererDesktopExtensionsClient | null {
  const client = getClient();
  return client && typeof client.listHostExtensions === "function" ? client : null;
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

      // List view container (hidden while an extension's standalone `page` is open).
      const listViewWrap = createEl(document, "div", "settings-extensions__list-view");
      // Standalone page view host container.
      const pageViewHost = createEl(document, "div", "settings-extensions__page-host");
      pageViewHost.hidden = true;

      // Hero Header: editorial title + subtitle on left; direct Create & Import actions on right.
      const header = createEl(document, "header", "settings-extensions__hero");
      const heroCopy = createEl(document, "div", "settings-extensions__hero-copy");
      const title = createEl(
        document,
        "h1",
        "settings-extensions__title",
        messages.pageLabels["desktop-extensions"],
      );
      const subtitle = createEl(document, "p", "settings-extensions__subtitle", copy.subtitle);
      heroCopy.append(title, subtitle);

      const heroActions = createEl(document, "div", "settings-extensions__hero-actions");

      const createButton = createEl(document, "button", "settings-extensions__create-button");
      createButton.type = "button";
      createButton.dataset.action = "open-create";
      createButton.append(
        createRendererSettingsIcon("sparkles", 13),
        createEl(document, "span", "", copy.createButton),
      );

      const importButton = createEl(document, "button", "settings-extensions__import-button");
      importButton.type = "button";
      importButton.dataset.action = "open-import";
      importButton.append(
        createRendererSettingsIcon("upload", 13),
        createEl(document, "span", "", copy.importButton),
      );

      heroActions.append(createButton, importButton);
      header.append(heroCopy, heroActions);

      // Single sticky navigation bar: All + Installed | categories on left; Search + Filter + More on right.
      const stickyBar = createEl(document, "div", "settings-extensions__sticky-bar");
      stickyBar.hidden = true;

      const navTabs = createEl(document, "nav", "settings-extensions__nav-tabs");
      navTabs.setAttribute("role", "tablist");
      navTabs.setAttribute("aria-label", copy.tabListLabel);

      const allTabButton = createEl(
        document,
        "button",
        "settings-extensions__nav-tab",
        copy.tabAll,
      );
      allTabButton.type = "button";
      allTabButton.dataset.nav = "all";
      allTabButton.dataset.tab = "marketplace";
      allTabButton.setAttribute("role", "tab");
      allTabButton.setAttribute("aria-selected", "false");

      const installedTabButton = createEl(
        document,
        "button",
        "settings-extensions__nav-tab settings-extensions__nav-tab--installed",
      );
      installedTabButton.type = "button";
      installedTabButton.dataset.nav = "installed";
      installedTabButton.dataset.tab = "installed";
      installedTabButton.setAttribute("role", "tab");
      installedTabButton.setAttribute("aria-selected", "false");
      const installedTabLabel = createEl(document, "span");
      const installedTabUpdateDot = createEl(
        document,
        "span",
        "settings-extensions__tab-update-dot",
      );
      installedTabUpdateDot.hidden = true;
      installedTabUpdateDot.setAttribute("aria-hidden", "true");
      installedTabButton.append(installedTabLabel, installedTabUpdateDot);

      const navDivider = createEl(document, "span", "settings-extensions__nav-divider");
      navDivider.setAttribute("aria-hidden", "true");
      navDivider.hidden = true;

      navTabs.append(allTabButton, installedTabButton, navDivider);

      const barActions = createEl(document, "div", "settings-extensions__bar-actions");

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

      // Filter popover: capability/platform filters + content language switcher.
      const filterWrap = createEl(document, "div", "settings-extensions__filter");
      const filterButton = createEl(document, "button", "settings-extensions__filter-button");
      filterButton.type = "button";
      filterButton.dataset.action = "filter-menu";
      filterButton.title = copy.capabilityFilterLabel;
      filterButton.setAttribute("aria-label", copy.capabilityFilterLabel);
      filterButton.setAttribute("aria-haspopup", "menu");
      filterButton.setAttribute("aria-expanded", "false");
      const filterLabelSpan = createEl(document, "span", "", copy.filterButton);
      const filterActiveDot = createEl(document, "span", "settings-extensions__filter-dot");
      filterActiveDot.hidden = true;
      filterActiveDot.setAttribute("aria-hidden", "true");
      filterButton.append(
        createRendererSettingsIcon("sliders", 13),
        filterLabelSpan,
        filterActiveDot,
        createRendererSettingsIcon("chevron-down", 11),
      );

      const filterMenu = createEl(
        document,
        "div",
        "settings-extensions-menu settings-extensions-menu--filter",
      );
      filterMenu.dataset.menu = "filter";
      filterMenu.setAttribute("role", "menu");
      filterMenu.setAttribute("aria-label", copy.capabilityFilterLabel);
      filterMenu.hidden = true;

      const capabilityHeading = createEl(
        document,
        "div",
        "settings-extensions-menu__heading",
        copy.capabilityFilterLabel,
      );
      filterMenu.append(capabilityHeading);

      const capabilityOptionButtons = new Map<
        ExtensionCapabilityFilter,
        { readonly button: HTMLButtonElement; readonly checkSlot: HTMLSpanElement }
      >();
      for (const filter of CAPABILITY_FILTER_ORDER) {
        const itemButton = createEl(
          document,
          "button",
          "settings-extensions-menu__item settings-extensions-menu__item--radio",
        );
        itemButton.type = "button";
        itemButton.setAttribute("role", "menuitemradio");
        itemButton.dataset.capabilityFilter = filter;
        const labelSpan = createEl(
          document,
          "span",
          "settings-extensions-menu__item-label",
          capabilityFilterLabel(filter, copy),
        );
        const checkSlot = createEl(document, "span", "settings-extensions-menu__check");
        checkSlot.append(createRendererSettingsIcon("check", 13));
        itemButton.append(labelSpan, checkSlot);
        filterMenu.append(itemButton);
        capabilityOptionButtons.set(filter, { button: itemButton, checkSlot });
      }

      const filterDivider = createEl(document, "div", "settings-extensions-menu__divider");
      filterDivider.setAttribute("role", "separator");
      const localeHeading = createEl(
        document,
        "div",
        "settings-extensions-menu__heading",
        copy.contentLocaleLabel,
      );
      filterMenu.append(filterDivider, localeHeading);

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
        filterMenu.append(itemButton);
        localeOptionButtons.set(option.value, { button: itemButton, checkSlot });
      }
      filterWrap.append(filterButton, filterMenu);

      // More ("...") menu: refresh catalog, copy extensions directory, recovery.
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

      const refreshMenuItem = createEl(document, "button", "settings-extensions-menu__item");
      refreshMenuItem.type = "button";
      refreshMenuItem.setAttribute("role", "menuitem");
      refreshMenuItem.dataset.action = "refresh";
      const refreshMenuLabel = createEl(
        document,
        "span",
        "settings-extensions-menu__item-label",
        copy.refreshMarket,
      );
      refreshMenuItem.append(createRendererSettingsIcon("refresh", 14), refreshMenuLabel);

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

      moreMenu.append(refreshMenuItem, copyDirectoryMenuItem, menuDivider, recoveryMenuItem);
      moreWrap.append(moreButton, moreMenu);

      barActions.append(searchBox, filterWrap, moreWrap);
      stickyBar.append(navTabs, barActions);

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

      listViewWrap.append(header, stickyBar, banner, diagnosticsPanel, body);
      root.append(listViewWrap, pageViewHost);
      context.content.append(root);

      const initialHasCatalog =
        typeof resolveAvailableClient(getClient)?.listHostExtensionCatalog === "function";

      let disposed = false;
      let moreMenuOpen = false;
      let filterMenuOpen = false;
      let contentLocalePreference: DesktopExtensionContentLocalePreference =
        readContentLocalePreference(ownerWindow);
      let activeView: NavView = initialHasCatalog ? "all" : "installed";
      let listing: HostExtensionsListResult | null = null;
      let catalog: HostExtensionsCatalogResult | null = null;
      let catalogById = new Map<string, HostExtensionCatalogEntry>();
      let unavailable = false;
      let catalogUnavailable = !initialHasCatalog;
      let catalogError: string | null = null;
      let loading = false;
      let catalogLoading = false;
      let catalogRequestToken = 0;
      let listApplyToken = 0;
      const pendingMutations = new Map<string, DesktopExtensionMutationAction>();
      let importing = false;
      let recovering = false;
      let toggleQueue: Promise<void> = Promise.resolve();
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let activeRecoveryDialog: HTMLDialogElement | null = null;
      let selectedCapability: ExtensionCapabilityFilter = "all";
      let searchQuery = "";
      let modalFeedback: {
        readonly extensionId: string;
        readonly feedback: DesktopExtensionFeedback;
      } | null = null;

      const isInstalledView = (): boolean => activeView === "installed";
      const activeCategory = (): DesktopExtensionCategory | null =>
        activeView !== "all" && activeView !== "installed" ? activeView : null;

      const catalogIconLoader = createDesktopCatalogIconLoader(() => {
        const client = resolveAvailableClient(getClient);
        return client?.readHostExtensionCatalogIcon?.bind(client);
      });

      const hasPendingMutations = (): boolean =>
        pendingMutations.size > 0 || importing || recovering;

      const clientCapabilities = () => {
        const client = resolveAvailableClient(getClient);
        return {
          client,
          canInstall: !unavailable && Boolean(client?.installHostExtension),
          canUpdate:
            !unavailable && Boolean(client?.updateHostExtension || client?.installHostExtension),
          canUninstall: !unavailable && Boolean(client?.uninstallHostExtension),
          canRecover: !unavailable && Boolean(client?.recoverHostExtensions),
        };
      };

      const resolveContentLocale = (): DesktopExtensionContentLocale =>
        contentLocalePreference === "system" ? messages.locale : contentLocalePreference;

      const syncFilterControl = (): void => {
        const effective = resolveContentLocale();
        const capabilityActive = selectedCapability !== "all";
        const anyFilterActive = capabilityActive || contentLocalePreference !== "system";
        filterLabelSpan.textContent = capabilityActive
          ? capabilityFilterLabel(selectedCapability, copy)
          : copy.filterButton;
        filterButton.dataset.active = anyFilterActive ? "true" : "false";
        filterButton.dataset.contentLocale = contentLocalePreference;
        filterButton.dataset.effectiveLocale = effective;
        filterActiveDot.hidden = !anyFilterActive;
        for (const [filter, entry] of capabilityOptionButtons) {
          const selected = filter === selectedCapability;
          entry.button.setAttribute("aria-checked", String(selected));
          entry.checkSlot.hidden = !selected;
        }
        for (const [value, entry] of localeOptionButtons) {
          const selected = value === contentLocalePreference;
          entry.button.setAttribute("aria-checked", String(selected));
          entry.checkSlot.hidden = !selected;
        }
      };

      const pageHost = createDesktopExtensionPageHost({
        document,
        host: pageViewHost,
        signal: context.signal,
        messages,
        getClient: () => resolveAvailableClient(getClient),
        getContentLocale: resolveContentLocale,
        onClose: () => {
          listViewWrap.hidden = false;
          pageViewHost.hidden = true;
          render();
        },
      });

      const openExtensionPage = (item: HostExtensionValidItem): void => {
        if (disposed || context.signal.aborted || !item.enabled || !item.manifest.page) return;
        closeHeaderMenus();
        detailModal.close();
        importModal.close();
        createModal.close();
        const pageId = pluginPages?.getPageIdForExtension(item.id);
        if (pageId && context.navigateToPage?.(pageId)) return;
        const catalogEntry = catalogById.get(item.id);
        listViewWrap.hidden = true;
        pageViewHost.hidden = false;
        pageHost.open(item, catalogEntry?.icon);
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
          pendingMutations: new Map(pendingMutations),
          globalBusy: recovering,
          feedback:
            modalFeedback !== null && modalFeedback.extensionId === detailModal.extensionId
              ? modalFeedback.feedback
              : null,
        };
      };

      const detailModal = createDesktopExtensionDetailModal({
        document,
        host: root,
        signal: context.signal,
        messages,
        catalogIconLoader,
        assetClient: {
          async readAsset(input) {
            const reader = resolveAvailableClient(getClient)?.readHostExtensionAsset;
            if (!reader) throw new Error("Host extension asset RPC is unavailable");
            return reader(input);
          },
        },
        settingsClient: {
          async getSettings(id) {
            const getter = resolveAvailableClient(getClient)?.getHostExtensionSettings;
            if (!getter) throw new Error("Host extension settings RPC is unavailable");
            return getter({ id });
          },
          async setSettings(id, expectedSettingsRevision, values) {
            const setter = resolveAvailableClient(getClient)?.setHostExtensionSettings;
            if (!setter) throw new Error("Host extension settings RPC is unavailable");
            return setter({ id, expectedSettingsRevision, values });
          },
        },
        onSettingsSaved: (extensionId, values, revision) => {
          pageHost.notifySettingsChanged(extensionId, values, revision);
          pluginPages?.notifySettingsChanged?.(extensionId, values);
        },
        onToggle: (item, enable) => {
          void toggleExtension(item, enable);
        },
        onInstall: (entry, isUpdate) => {
          void installFromCatalog(entry, isUpdate);
        },
        onUninstall: (item) => {
          void uninstallExtension(item);
        },
        onOpenPage: (item) => {
          openExtensionPage(item);
        },
        onOpenSettings:
          pluginPages && context.navigateToPage
            ? (extensionId) => {
                const pageId = pluginPages.getPageIdForExtension(extensionId);
                if (pageId) context.navigateToPage?.(pageId);
              }
            : undefined,
        onClose: () => {
          modalFeedback = null;
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
        if (modalExtensionId !== null) {
          modalFeedback = next ? { extensionId: modalExtensionId, feedback: next } : null;
          return;
        }
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

      const computeAvailableCategories = (): readonly DesktopExtensionCategory[] => {
        const present = new Set<DesktopExtensionCategory>();
        if (catalog && catalog.extensions.length > 0) {
          for (const entry of catalog.extensions) {
            for (const category of entry.categories ?? []) {
              present.add(category);
            }
          }
        } else if (listing) {
          for (const item of listing.extensions) {
            if (item.state === "valid") {
              for (const category of item.manifest.categories ?? []) {
                present.add(category);
              }
            }
          }
        }
        return CATEGORY_ORDER.filter((category) => present.has(category));
      };

      const syncNavTabs = (): void => {
        const availableCategories = computeAvailableCategories();
        const currentCategory = activeCategory();
        if (currentCategory && !availableCategories.includes(currentCategory)) {
          activeView = catalogUnavailable ? "installed" : "all";
        }

        const contentCopy = contentLocaleMessages(resolveContentLocale());
        installedTabLabel.textContent = formatMessage(copy.tabInstalled, {
          count: String(listing?.extensions.length ?? 0),
        });
        const hasInstalledUpdates = listing?.extensions.some((item) =>
          hasCatalogUpdate(item, catalogById.get(item.id)),
        );
        installedTabUpdateDot.hidden = !hasInstalledUpdates;
        installedTabButton.setAttribute(
          "aria-description",
          hasInstalledUpdates ? copy.installedUpdatesAvailable : "",
        );
        allTabButton.setAttribute("aria-selected", String(activeView === "all"));
        installedTabButton.setAttribute("aria-selected", String(activeView === "installed"));
        navDivider.hidden = availableCategories.length === 0;

        const categoryNodes: HTMLElement[] = [];
        for (const category of availableCategories) {
          const btn = createEl(
            document,
            "button",
            "settings-extensions__nav-tab",
            contentCopy.categories[category],
          );
          btn.type = "button";
          btn.dataset.nav = category;
          btn.dataset.category = category;
          btn.setAttribute("role", "tab");
          btn.setAttribute("aria-selected", String(activeView === category));
          btn.addEventListener("click", () => switchView(category));
          categoryNodes.push(btn);
        }
        navTabs.replaceChildren(allTabButton, installedTabButton, navDivider, ...categoryNodes);
      };

      const syncToolbarState = (): void => {
        const activeLoading = isInstalledView() ? loading : catalogLoading;
        refreshMenuItem.disabled = activeLoading || recovering;
        refreshMenuLabel.textContent = activeLoading ? copy.refreshing : copy.refreshMarket;

        const { canInstall, canRecover } = clientCapabilities();
        importButton.disabled = importing || recovering || !canInstall;
        createButton.disabled = recovering;
        recoveryMenuItem.disabled = hasPendingMutations() || !canRecover;

        syncNavTabs();
        syncFilterControl();
      };

      const renderDiagnostics = (): void => {
        if (!isInstalledView() || !listing || unavailable || listing.diagnostics.length === 0) {
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
          selectedCapability = "all";
          if (activeCategory()) activeView = "all";
          searchQuery = "";
          searchInput.value = "";
          clearSearchButton.hidden = true;
          render();
        });
        empty.append(copyBox, resetButton);
        body.replaceChildren(...prefixNodes, empty);
      };

      const setFilterMenuOpen = (open: boolean): void => {
        if (open && moreMenuOpen) setMoreMenuOpen(false);
        filterMenuOpen = open;
        filterMenu.hidden = !open;
        filterButton.setAttribute("aria-expanded", String(open));
      };

      const setMoreMenuOpen = (open: boolean): void => {
        if (open && filterMenuOpen) setFilterMenuOpen(false);
        moreMenuOpen = open;
        moreMenu.hidden = !open;
        moreButton.setAttribute("aria-expanded", String(open));
      };

      const closeHeaderMenus = (): void => {
        if (moreMenuOpen) setMoreMenuOpen(false);
        if (filterMenuOpen) setFilterMenuOpen(false);
      };

      const openDetailModal = (extensionId: string): void => {
        if (disposed || context.signal.aborted || activeRecoveryDialog || importModal.isOpen) {
          return;
        }
        closeHeaderMenus();
        if (detailModal.extensionId !== extensionId) {
          modalFeedback = null;
        }
        detailModal.open(extensionId, buildDetailModalState());
      };

      const renderExtensionCard = (
        item: HostExtensionListItem,
        allExtensions: readonly HostExtensionListItem[],
        catalogEntry: HostExtensionCatalogEntry | undefined,
        canUpdate: boolean,
      ): HTMLElement => {
        const contentLocale = resolveContentLocale();
        const displayName = extensionDisplayName(item, contentLocale);
        const switchId = preferenceId(`host-ext-${item.id}`);
        const errorId = preferenceId(`host-ext-error-${item.id}`);
        const blocked = isToggleBlocked(item);
        const statusState = itemStatusState(item);
        const extAction = pendingMutations.get(item.id) ?? null;
        const isExtBusy = extAction !== null;
        const controlsDisabled = isExtBusy || recovering;

        const toggle = createPreferenceSwitch(document, switchId, errorId);
        toggle.checked = item.enabled;
        toggle.setAttribute("aria-label", formatMessage(copy.toggleLabel, { name: displayName }));
        toggle.disabled = controlsDisabled || blocked;
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
          if (recovering || pendingMutations.has(item.id) || blocked) {
            toggle.checked = item.enabled;
            return;
          }
          void toggleExtension(item, desired);
        });

        let openPageButton: HTMLElement | undefined;
        if (item.state === "valid" && item.enabled && item.manifest.page) {
          const btn = createEl(
            document,
            "button",
            "settings-command-button settings-command-button--secondary settings-extensions-card__open-page",
            copy.openPage,
          );
          btn.type = "button";
          btn.dataset.action = "open-page";
          btn.dataset.extensionId = item.id;
          btn.disabled = controlsDisabled;
          btn.addEventListener("click", (event) => {
            event.stopPropagation?.();
            if (!btn.disabled) openExtensionPage(item);
          });
          btn.addEventListener("keydown", stopTrigger);
          openPageButton = btn;
        }

        let update: { label: string; action: HTMLButtonElement } | undefined;
        if (catalogEntry && hasCatalogUpdate(item, catalogEntry)) {
          const updating = extAction === "update";
          const button = createEl(
            document,
            "button",
            "settings-command-button settings-extensions-card__button settings-extensions-card__update-button",
            updating ? copy.updating : copy.update,
          );
          button.type = "button";
          button.dataset.action = "update";
          button.setAttribute("aria-busy", String(updating));
          button.disabled = controlsDisabled || !canUpdate;
          button.addEventListener("click", () => {
            if (!button.disabled) void installFromCatalog(catalogEntry, true);
          });
          update = {
            label: formatMessage(copy.updateVersionCue, {
              version: catalogEntry.version.replace(/^v/u, ""),
            }),
            action: button,
          };
        }

        const attention = resolveAttentionDetail(item, allExtensions, messages.locale, copy);

        const targets = itemTargets(item);
        const webOnly = targets.includes("web") && !targets.includes("desktop");
        const localIcon =
          item.state === "valid" ? parseSafeExtensionIconUrl(item.iconDataUrl) : null;
        const cachedProxyIcon =
          !localIcon && catalogEntry?.icon ? catalogIconLoader.getCached(catalogEntry) : undefined;
        const shouldLoadViaRpc =
          !localIcon &&
          !cachedProxyIcon &&
          Boolean(catalogEntry?.icon) &&
          catalogIconLoader.isAvailable();
        return renderDesktopExtensionCard({
          document,
          messages,
          contentLocale,
          extensionId: item.id,
          cardKind: "installed",
          layout: "row",
          displayName,
          iconUrl: cachedProxyIcon ?? resolveInstalledExtensionIconUrl(item, catalogEntry),
          resolveIconUrl:
            shouldLoadViaRpc && catalogEntry
              ? () => catalogIconLoader.load(catalogEntry)
              : undefined,
          author:
            (item.state === "valid" ? item.manifest.author : undefined) ?? catalogEntry?.author,
          version: item.state === "valid" ? item.manifest.version : undefined,
          downloads: catalogEntry?.downloads,
          trustTier: catalogEntry?.trustTier,
          statusState,
          update,
          description: extensionDescription(item, contentLocale),
          attention,
          attentionId: attention ? errorId : undefined,
          categories: item.state === "valid" ? item.manifest.categories : undefined,
          platformBadge: webOnly ? derivePlatformBadge(targets, copy) : null,
          incompatiblePlatformLabel: webOnly ? copy.platformWebOnlyShort : undefined,
          capabilityBadges: [],
          secondaryAction: openPageButton,
          actionControl: toggle,
          busy: isExtBusy,
          dataset: {
            extensionState: statusState,
            trustTier: catalogEntry?.trustTier,
          },
          onOpenDetails: () => openDetailModal(item.id),
        });
      };

      const renderInstalledTab = (): void => {
        if (!listing) {
          if (loading) renderLoading(copy.loading);
          else body.replaceChildren();
          return;
        }
        if (listing.extensions.length === 0) {
          renderEmptyBox(copy.emptyTitle, copy.emptyDescription, copy.emptyPathHint);
          return;
        }

        const normalizedQuery = searchQuery.trim().toLowerCase();
        const visibleExtensions = listing.extensions.filter((item) => {
          if (
            selectedCapability !== "all" &&
            !matchesCapabilityFilter(selectedCapability, itemCapabilities(item), itemTargets(item))
          ) {
            return false;
          }
          return matchesInstalledSearchQuery(item, normalizedQuery);
        });

        if (visibleExtensions.length === 0) {
          renderNoMatchesBox();
          return;
        }

        const attentionItems: HostExtensionListItem[] = [];
        const normalItems: HostExtensionListItem[] = [];
        for (const item of visibleExtensions) {
          if (needsAttention(itemStatusState(item))) {
            attentionItems.push(item);
          } else {
            normalItems.push(item);
          }
        }

        const contentLocale = resolveContentLocale();
        normalItems.sort((left, right) => {
          const nameCmp = extensionDisplayName(left, contentLocale).localeCompare(
            extensionDisplayName(right, contentLocale),
            contentLocale,
          );
          if (nameCmp !== 0) return nameCmp;
          return left.id.localeCompare(right.id, "en");
        });

        const allExtensions = listing.extensions;
        const { canUpdate } = clientCapabilities();
        const buildRowGrid = (items: readonly HostExtensionListItem[]): HTMLElement => {
          const grid = createEl(document, "div", "settings-extensions-row-grid");
          for (const item of items) {
            grid.append(
              renderExtensionCard(item, allExtensions, catalogById.get(item.id), canUpdate),
            );
          }
          return grid;
        };

        const sections = createEl(document, "div", "settings-extensions-sections");
        sections.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);

        if (attentionItems.length > 0) {
          const attentionSection = createEl(document, "section", "settings-extensions-section");
          attentionSection.dataset.extensionGroup = "attention";
          const headingId = preferenceId("host-ext-group-attention");
          attentionSection.setAttribute("aria-labelledby", headingId);

          const heading = createEl(document, "h2", "settings-extensions-section__title");
          heading.id = headingId;
          heading.append(
            createEl(document, "span", "", copy.attentionHeading),
            createEl(
              document,
              "span",
              "settings-extensions-section__count",
              String(attentionItems.length),
            ),
          );
          attentionSection.append(heading, buildRowGrid(attentionItems));
          sections.append(attentionSection);
        }

        if (normalItems.length > 0) {
          const installedSection = createEl(document, "section", "settings-extensions-section");
          installedSection.dataset.extensionGroup = "installed";
          const heading = createEl(document, "h2", "settings-extensions-section__title");
          heading.append(
            createEl(document, "span", "", copy.sectionInstalled),
            createEl(
              document,
              "span",
              "settings-extensions-section__count",
              String(normalItems.length),
            ),
          );
          installedSection.append(heading, buildRowGrid(normalItems));
          sections.append(installedSection);
        }

        body.replaceChildren(sections);
      };

      const renderMarketplaceTab = (): void => {
        if (catalogUnavailable) {
          renderEmptyBox(copy.marketplaceUnavailableTitle, copy.marketplaceUnavailableDescription);
          return;
        }

        if (!catalog) {
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
                  if (!catalogLoading && !recovering) {
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
          catalogLoading || recovering,
          () => {
            if (!catalogLoading && !recovering) {
              void loadCatalog({ forceRefresh: true, silent: false });
            }
          },
          catalogError,
        );
        const prefixNodes = fallbackNotice ? [fallbackNotice] : [];

        if (catalog.extensions.length === 0) {
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

        const category = activeCategory();
        const normalizedQuery = searchQuery.trim().toLowerCase();
        const visibleEntries = catalog.extensions.filter((entry) => {
          if (
            selectedCapability !== "all" &&
            !matchesCapabilityFilter(selectedCapability, catalogCapabilities(entry), entry.targets)
          ) {
            return false;
          }
          if (category && !entry.categories?.includes(category)) {
            return false;
          }
          return matchesCatalogSearchQuery(entry, normalizedQuery);
        });

        if (visibleEntries.length === 0) {
          renderNoMatchesBox(prefixNodes);
          return;
        }

        const installedById = new Map<string, HostExtensionListItem>();
        for (const item of listing?.extensions ?? []) {
          installedById.set(item.id, item);
        }

        const isDefaultHome =
          activeView === "all" && normalizedQuery === "" && selectedCapability === "all";
        const { canInstall } = clientCapabilities();
        const marketView = renderDesktopExtensionsMarketplaceGrid({
          document,
          messages,
          contentLocale: resolveContentLocale(),
          catalog,
          visibleEntries,
          installedById,
          isDefaultHome,
          selectedCategory: category,
          catalogIconLoader,
          canInstall,
          pendingMutations,
          globalBusy: recovering,
          onOpenDetails: openDetailModal,
          onInstall: (entry, isUpdate) => {
            void installFromCatalog(entry, isUpdate);
          },
          onViewInstalled: () => {
            activeView = "installed";
            selectedCapability = "all";
            searchQuery = "";
            searchInput.value = "";
            clearSearchButton.hidden = true;
            setFeedback(null);
            render();
          },
          onRetryCatalog: () => {
            if (!catalogLoading && !recovering) {
              void loadCatalog({ forceRefresh: true, silent: false });
            }
          },
        });

        body.replaceChildren(...prefixNodes, marketView);
      };

      const render = (): void => {
        syncToolbarState();
        renderDiagnostics();

        if (unavailable) {
          stickyBar.hidden = true;
          renderEmptyBox(copy.unavailableTitle, copy.unavailableDescription);
          detailModal.sync(buildDetailModalState());
          return;
        }

        stickyBar.hidden = false;
        clearSearchButton.hidden = searchQuery.length === 0;

        if (isInstalledView()) {
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
            hasPendingMutations() ||
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

      const applyLoadedList = (result: HostExtensionsListResult, token?: number): boolean => {
        if (token !== undefined && token !== listApplyToken) return false;
        if (token === undefined) listApplyToken += 1;
        const hadOpenPageId = pageHost.extensionId;
        listing = result;
        pluginPages?.syncInstalledExtensions?.(result.extensions, result.configuration.revision);
        pageHost.sync(result.extensions);
        if (hadOpenPageId && !pageHost.isOpen) {
          setFeedback({ tone: "info", text: copy.pageClosedDisabled });
        }
        return true;
      };

      const refreshInstalledAfterMutation = async (): Promise<void> => {
        const client = resolveAvailableClient(getClient);
        if (!client?.listHostExtensions) return;
        const token = ++listApplyToken;
        try {
          const refreshed = await client.listHostExtensions();
          if (disposed || context.signal.aborted) return;
          applyLoadedList(refreshed, token);
        } catch {
          // Keep the completed mutation's success feedback; polling or next refresh will reconcile.
        }
      };

      const loadInstalled = async (
        options: { silent?: boolean; keepFeedback?: boolean } = {},
      ): Promise<void> => {
        const silent = options.silent ?? false;
        const keepFeedback = options.keepFeedback ?? silent;
        const client = resolveAvailableClient(getClient);
        if (!client?.listHostExtensions) {
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

        const listHostExtensions = client.listHostExtensions.bind(client);
        const token = ++listApplyToken;
        await context.runLatest(async () => listHostExtensions(), {
          success(result) {
            loading = false;
            unavailable = false;
            const applied = applyLoadedList(result, token);
            if (applied && !keepFeedback) setFeedback(null);
            render();
            schedulePoll();
          },
          failure(error) {
            loading = false;
            if (token !== listApplyToken) {
              render();
              schedulePoll();
              return;
            }
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
        if (!client?.listHostExtensionCatalog) {
          catalogUnavailable = true;
          catalogLoading = false;
          if (!isInstalledView()) render();
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
          const params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.catalog> = forceRefresh
            ? { forceRefresh: true }
            : {};
          const result = await client.listHostExtensionCatalog(params);
          if (disposed || context.signal.aborted || token !== catalogRequestToken) return;
          catalogLoading = false;
          catalogUnavailable = false;
          catalogError = null;
          catalog = result;
          catalogById = new Map(result.extensions.map((entry) => [entry.id, entry]));
          render();
        } catch (error) {
          if (disposed || context.signal.aborted || token !== catalogRequestToken) return;
          catalogLoading = false;
          if (error instanceof RendererMethodUnavailableError) {
            catalogUnavailable = true;
            catalog = null;
            catalogById.clear();
            render();
            return;
          }
          catalogError = errorMessage(error);
          if (!silent && !isInstalledView() && catalog) {
            setFeedback({
              tone: "danger",
              text: formatMessage(copy.marketplaceLoadFailed, { message: catalogError }),
              retryable: true,
            });
          }
          render();
        }
      };

      const installFromCatalog = async (
        entry: HostExtensionCatalogEntry,
        isUpdate: boolean,
      ): Promise<void> => {
        if (recovering || pendingMutations.has(entry.id) || disposed || context.signal.aborted)
          return;
        const client = resolveAvailableClient(getClient);
        const installedItem = listing?.extensions.find((item) => item.id === entry.id);
        const canUpdate =
          isUpdate && installedItem?.state === "valid" && Boolean(client?.updateHostExtension);
        const install = client?.installHostExtension?.bind(client);
        const update = client?.updateHostExtension?.bind(client);
        if (!canUpdate && !install) return;

        const fallbackName = catalogDisplayName(entry, messages.locale);
        pendingMutations.set(entry.id, isUpdate ? "update" : "install");
        clearPollTimer();
        render();

        try {
          let result;
          if (canUpdate && update && installedItem?.state === "valid") {
            result = await update({
              id: entry.id,
              expectedDigest: installedItem.digest,
              expectedActivationId: installedItem.activationId,
              source: { type: "catalog", id: entry.id },
            });
          } else if (install) {
            result = await install({
              source: { type: "catalog", id: entry.id },
            });
          } else {
            return;
          }
          if (disposed || context.signal.aborted) return;
          const displayName =
            result.manifest.name[messages.locale] || result.manifest.name.en || fallbackName;
          const modalTargetId = detailModal.extensionId === entry.id ? entry.id : null;
          setFeedback(
            {
              tone: "success",
              text: formatMessage(
                result.replaced || isUpdate ? copy.updatedSuccess : copy.installedSuccess,
                { name: displayName, version: result.manifest.version },
              ),
            },
            modalTargetId,
          );
          await refreshInstalledAfterMutation();
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          const modalTargetId = detailModal.extensionId === entry.id ? entry.id : null;
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.installFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
        } finally {
          pendingMutations.delete(entry.id);
          if (!disposed && !context.signal.aborted) {
            render();
            if (!hasPendingMutations()) schedulePoll();
          }
        }
      };

      const importExtension = async (source: HostExtensionInstallSource): Promise<void> => {
        if (importing || recovering) return;
        const client = resolveAvailableClient(getClient);
        const install = client?.installHostExtension?.bind(client);
        if (!install) {
          throw new Error(copy.importUnavailable);
        }
        importing = true;
        clearPollTimer();
        syncToolbarState();

        try {
          const result = await install({ source });
          if (disposed || context.signal.aborted) return;
          activeView = "installed";
          selectedCapability = "all";
          searchQuery = "";
          searchInput.value = "";
          clearSearchButton.hidden = true;
          const displayName =
            result.manifest.name[messages.locale] || result.manifest.name.en || result.id;
          setFeedback({
            tone: "success",
            text: formatMessage(result.replaced ? copy.updatedSuccess : copy.installedSuccess, {
              name: displayName,
              version: result.manifest.version,
            }),
          });
          await refreshInstalledAfterMutation();
        } finally {
          importing = false;
          if (!disposed && !context.signal.aborted) {
            render();
            if (!hasPendingMutations()) schedulePoll();
          }
        }
      };

      const uninstallExtension = async (item: HostExtensionListItem): Promise<void> => {
        if (recovering || pendingMutations.has(item.id) || disposed || context.signal.aborted)
          return;
        const client = resolveAvailableClient(getClient);
        const uninstall = client?.uninstallHostExtension?.bind(client);
        if (!uninstall) return;

        const displayName = extensionDisplayName(item, messages.locale);
        pendingMutations.set(item.id, "uninstall");
        clearPollTimer();
        render();

        try {
          await uninstall({
            id: item.id,
            ...(item.state === "valid" ? { expectedDigest: item.digest } : {}),
          });
          if (disposed || context.signal.aborted) return;
          if (pageHost.extensionId === item.id) {
            pageHost.close();
          }
          if (detailModal.extensionId === item.id) {
            detailModal.close();
          }
          setFeedback({
            tone: "success",
            text: formatMessage(copy.uninstalledSuccess, { name: displayName }),
          });
          await refreshInstalledAfterMutation();
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          const modalTargetId = detailModal.extensionId === item.id ? item.id : null;
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.uninstallFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
        } finally {
          pendingMutations.delete(item.id);
          if (!disposed && !context.signal.aborted) {
            render();
            if (!hasPendingMutations()) schedulePoll();
          }
        }
      };

      const toggleExtension = async (
        item: HostExtensionListItem,
        enable: boolean,
      ): Promise<void> => {
        if (recovering || pendingMutations.has(item.id) || disposed || context.signal.aborted)
          return;
        const client = resolveAvailableClient(getClient);
        const mutate = enable
          ? client?.enableHostExtension?.bind(client)
          : client?.disableHostExtension?.bind(client);
        if (!mutate) {
          unavailable = true;
          render();
          return;
        }
        const displayName = extensionDisplayName(item, messages.locale);
        pendingMutations.set(item.id, "toggle");
        clearPollTimer();
        render();

        let shouldReload = false;
        const runQueued = toggleQueue.then(async () => {
          if (disposed || context.signal.aborted) return;
          const expectedRevision = listing?.configuration.revision ?? 0;
          const result = await mutate({ id: item.id, expectedRevision });
          if (disposed || context.signal.aborted) return;
          const modalTargetId = detailModal.extensionId === item.id ? item.id : null;

          if (result.state === "saved") {
            if (!enable && pageHost.extensionId === item.id) {
              pageHost.close();
            }
            if (listing) {
              applyLoadedList({
                ...listing,
                configuration: result.configuration,
                extensions: listing.extensions.map((entry) =>
                  entry.id === item.id ? { ...entry, enabled: enable } : entry,
                ),
              });
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
            shouldReload = true;
            return;
          }

          if (result.state === "revision-conflict") {
            listApplyToken += 1;
            if (listing) {
              listing = {
                ...listing,
                configuration: { ...listing.configuration, revision: result.revision },
              };
            }
            setFeedback(
              {
                tone: "warning",
                text: copy.revisionConflictBanner,
              },
              modalTargetId,
            );
            shouldReload = true;
          }
        });
        toggleQueue = runQueued.then(
          () => undefined,
          () => undefined,
        );

        try {
          await runQueued;
        } catch (error) {
          if (disposed || context.signal.aborted) return;
          if (error instanceof RendererMethodUnavailableError) {
            unavailable = true;
            listing = null;
            setFeedback(null);
            return;
          }
          const modalTargetId = detailModal.extensionId === item.id ? item.id : null;
          setFeedback(
            {
              tone: "danger",
              text: formatMessage(copy.actionFailed, { message: errorMessage(error) }),
            },
            modalTargetId,
          );
        } finally {
          pendingMutations.delete(item.id);
          if (!disposed && !context.signal.aborted) {
            render();
            if (shouldReload) {
              await loadInstalled({ silent: true, keepFeedback: true });
            } else if (!hasPendingMutations()) {
              schedulePoll();
            }
          }
        }
      };

      const openRecoveryDialog = (): void => {
        if (disposed || context.signal.aborted || hasPendingMutations() || activeRecoveryDialog)
          return;
        const client = resolveAvailableClient(getClient);
        if (!client?.recoverHostExtensions) return;
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
          if (dialogBusy || hasPendingMutations()) return;
          const recover = resolveAvailableClient(getClient)?.recoverHostExtensions;
          if (!recover) {
            modal.close();
            unavailable = true;
            render();
            return;
          }

          dialogError.textContent = "";
          setDialogBusy(true);
          recovering = true;
          clearPollTimer();
          render();

          const params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.recover> =
            listing !== null ? { expectedRevision: listing.configuration.revision } : {};

          void recover(params)
            .then(async (result) => {
              if (disposed || context.signal.aborted) return;
              if (result.state === "saved") {
                pageHost.close();
                if (listing) {
                  applyLoadedList({
                    ...listing,
                    configuration: result.configuration,
                    extensions: listing.extensions.map((entry) => ({
                      ...entry,
                      enabled: false,
                    })),
                  });
                }
                setFeedback({
                  tone: "info",
                  text: copy.recoverySaved,
                });
                recovering = false;
                modal.close();
                render();
                await loadInstalled({ silent: true, keepFeedback: true });
                return;
              }

              if (result.state === "revision-conflict") {
                listApplyToken += 1;
                if (listing) {
                  listing = {
                    ...listing,
                    configuration: { ...listing.configuration, revision: result.revision },
                  };
                }
                setFeedback({
                  tone: "warning",
                  text: copy.revisionConflictBanner,
                });
                recovering = false;
                modal.close();
                render();
                await loadInstalled({ silent: true, keepFeedback: true });
                return;
              }

              recovering = false;
              setDialogBusy(false);
              render();
              schedulePoll();
            })
            .catch((error: unknown) => {
              if (disposed || context.signal.aborted) return;
              recovering = false;
              setDialogBusy(false);
              render();
              schedulePoll();
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

      const switchView = (next: NavView): void => {
        if (activeView === next) return;
        closeHeaderMenus();
        if (pageHost.isOpen) pageHost.close();
        activeView = next;
        setFeedback(null);
        render();
        if (
          next !== "installed" &&
          !catalog &&
          !catalogLoading &&
          !catalogUnavailable &&
          !catalogError
        ) {
          void loadCatalog({ silent: true });
        }
      };

      const onVisibilityChange = (): void => {
        if (document.visibilityState === "hidden") clearPollTimer();
        else if (
          !disposed &&
          !context.signal.aborted &&
          !hasPendingMutations() &&
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
        if (filterMenuOpen && !(event?.target && isWithinElement(event.target, filterWrap))) {
          setFilterMenuOpen(false);
        }
      };

      const onDocumentKeyDown = (event?: Event): void => {
        if (!moreMenuOpen && !filterMenuOpen) return;
        const key = (event as KeyboardEvent | undefined)?.key;
        if (key !== "Escape") return;
        event?.preventDefault?.();
        if (filterMenuOpen) {
          setFilterMenuOpen(false);
          filterButton.focus?.();
        }
        if (moreMenuOpen) {
          setMoreMenuOpen(false);
          moreButton.focus?.();
        }
      };

      filterButton.addEventListener("click", (event) => {
        event.stopPropagation?.();
        setFilterMenuOpen(!filterMenuOpen);
      });

      for (const [filter, { button }] of capabilityOptionButtons) {
        button.addEventListener("click", () => {
          setFilterMenuOpen(false);
          if (selectedCapability === filter) return;
          selectedCapability = filter;
          render();
        });
      }

      for (const [value, { button }] of localeOptionButtons) {
        button.addEventListener("click", () => {
          setFilterMenuOpen(false);
          if (contentLocalePreference === value) return;
          contentLocalePreference = value;
          writeContentLocalePreference(ownerWindow, value);
          pageHost.syncLocale();
          render();
        });
      }

      moreButton.addEventListener("click", (event) => {
        event.stopPropagation?.();
        setMoreMenuOpen(!moreMenuOpen);
      });

      refreshMenuItem.addEventListener("click", () => {
        setMoreMenuOpen(false);
        if (recovering) return;
        if (!isInstalledView()) {
          if (!catalogLoading) void loadCatalog({ forceRefresh: true, silent: false });
          if (!loading) void loadInstalled({ silent: true, keepFeedback: true });
        } else {
          if (!loading) void loadInstalled({ silent: false, keepFeedback: false });
          if (!catalogLoading && !catalogUnavailable) {
            void loadCatalog({ forceRefresh: true, silent: true });
          }
        }
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

      allTabButton.addEventListener("click", () => switchView("all"));
      installedTabButton.addEventListener("click", () => switchView("installed"));

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
        if (importing || recovering || !clientCapabilities().canInstall) return;
        closeHeaderMenus();
        detailModal.close();
        createModal.close();
        importModal.open();
      });

      bannerRetry.addEventListener("click", () => {
        if (recovering) return;
        if (!isInstalledView()) {
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

      void loadInstalled({ silent: activeView !== "installed" });
      if (resolveAvailableClient(getClient)?.listHostExtensionCatalog) {
        void loadCatalog({ silent: activeView === "installed" });
      }

      return () => {
        disposed = true;
        clearPollTimer();
        unsubscribePluginPages?.();
        document.removeEventListener?.("visibilitychange", onVisibilityChange);
        document.removeEventListener?.("click", onDocumentClick);
        document.removeEventListener?.("keydown", onDocumentKeyDown);
        pageHost.dispose();
        detailModal.dispose();
        createModal.dispose();
        importModal.dispose();
        activeRecoveryDialog?.remove();
        activeRecoveryDialog = null;
      };
    },
  });
}
