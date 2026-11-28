import type {
  DesktopExtensionCategory,
  HostExtensionCatalogEntry,
  HostExtensionListItem,
  HostExtensionsCatalogResult,
} from "@codexhost/shared-contracts";
import {
  renderDesktopExtensionCard,
  type DesktopExtensionCardLayout,
} from "./desktop-extensions-card.js";
import type { DesktopCatalogIconLoader } from "./desktop-extensions-catalog-icons.js";
import {
  catalogDescription,
  catalogDisplayName,
  contentLocaleMessages,
  createEl,
  derivePlatformBadge,
  hasCatalogUpdate,
  parseSafeExtensionIconUrl,
  selectFeaturedCatalogEntries,
  type DesktopExtensionContentLocale,
  type DesktopExtensionMutationAction,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface DesktopExtensionsMarketplaceViewOptions {
  readonly document: Document;
  readonly messages: RendererSettingsMessages;
  readonly contentLocale?: DesktopExtensionContentLocale | undefined;
  readonly catalog: HostExtensionsCatalogResult;
  readonly visibleEntries: readonly HostExtensionCatalogEntry[];
  readonly installedById: ReadonlyMap<string, HostExtensionListItem>;
  readonly isDefaultHome?: boolean | undefined;
  readonly selectedCategory?: DesktopExtensionCategory | null | undefined;
  readonly catalogIconLoader?: DesktopCatalogIconLoader | undefined;
  readonly canInstall: boolean;
  readonly pendingMutations: ReadonlyMap<string, DesktopExtensionMutationAction>;
  readonly globalBusy: boolean;
  readonly onOpenDetails: (extensionId: string) => void;
  readonly onInstall: (entry: HostExtensionCatalogEntry, isUpdate: boolean) => void;
  readonly onViewInstalled: (extensionId: string) => void;
  readonly onRetryCatalog: () => void;
}

export function renderMarketplaceFallbackNotice(
  document: Document,
  messages: RendererSettingsMessages,
  catalog: HostExtensionsCatalogResult,
  disabled: boolean,
  onRetry: () => void,
  catalogError: string | null = null,
): HTMLElement | null {
  if (!catalogError && !catalog.cached) return null;
  if (!catalogError) return null;

  const copy = messages.desktopExtensions;
  const notice = createEl(document, "div", "settings-extensions-market__notice");
  notice.setAttribute("role", "status");
  notice.dataset.source = catalog.cached ? "cached" : "error";

  const textWrap = createEl(document, "div", "settings-extensions-market__notice-copy");
  textWrap.append(
    createRendererSettingsIcon("info", 14),
    createEl(document, "span", "", copy.marketplaceFallbackNotice),
  );

  const retryButton = createEl(
    document,
    "button",
    "settings-command-button settings-command-button--secondary settings-extensions-market__retry",
    copy.retry,
  );
  retryButton.type = "button";
  retryButton.disabled = disabled;
  retryButton.addEventListener("click", onRetry);

  notice.append(textWrap, retryButton);
  return notice;
}

export function renderDesktopExtensionsMarketplaceGrid(
  options: DesktopExtensionsMarketplaceViewOptions,
): HTMLElement {
  const {
    document,
    messages,
    contentLocale = messages.locale,
    visibleEntries,
    installedById,
    isDefaultHome = false,
    selectedCategory = null,
    catalogIconLoader,
    canInstall,
    pendingMutations,
    globalBusy,
    onOpenDetails,
    onInstall,
    onViewInstalled,
  } = options;
  const copy = messages.desktopExtensions;
  const contentCopy = contentLocaleMessages(contentLocale);

  const renderEntry = (
    entry: HostExtensionCatalogEntry,
    layout: DesktopExtensionCardLayout,
  ): HTMLElement => {
    const displayName = catalogDisplayName(entry, contentLocale);
    const installed = installedById.get(entry.id);
    const updateAvailable = hasCatalogUpdate(installed, entry);
    const installState = installed ? (updateAvailable ? "update" : "installed") : "available";
    const entryAction = pendingMutations.get(entry.id) ?? null;
    const isBusyCard = entryAction !== null;
    const controlsDisabled = isBusyCard || globalBusy;

    const actionButton = createEl(document, "button");
    actionButton.type = "button";
    actionButton.dataset.extensionId = entry.id;

    if (installState === "available") {
      actionButton.className = "settings-extensions-btn-install";
      actionButton.dataset.action = "install";
      const installingThis = entryAction === "install";
      actionButton.textContent = installingThis ? copy.installing : copy.install;
      actionButton.setAttribute("aria-busy", String(installingThis));
      actionButton.disabled = controlsDisabled || !canInstall;
    } else if (installState === "update") {
      actionButton.className = "settings-extensions-btn-update";
      actionButton.dataset.action = "update";
      const updatingThis = entryAction === "update";
      actionButton.textContent = updatingThis ? copy.updating : copy.update;
      actionButton.setAttribute("aria-busy", String(updatingThis));
      actionButton.disabled = controlsDisabled || !canInstall;
    } else {
      actionButton.className = "settings-extensions-btn-installed";
      actionButton.dataset.action = "installed";
      actionButton.append(
        createRendererSettingsIcon("check", 12),
        createEl(document, "span", "", copy.installedBadge),
      );
      actionButton.disabled = controlsDisabled;
    }

    actionButton.addEventListener("click", (event) => {
      event.stopPropagation?.();
      if (actionButton.disabled) return;
      if (installState === "available") {
        onInstall(entry, false);
      } else if (installState === "update") {
        onInstall(entry, true);
      } else {
        onViewInstalled(entry.id);
      }
    });
    actionButton.addEventListener("keydown", (event) => {
      event.stopPropagation?.();
    });

    const localIcon =
      installed?.state === "valid" ? parseSafeExtensionIconUrl(installed.iconDataUrl) : null;
    const cachedProxyIcon =
      !localIcon && entry.icon && catalogIconLoader
        ? catalogIconLoader.getCached(entry)
        : undefined;
    const resolvedUrl = localIcon ?? cachedProxyIcon ?? entry.icon;
    const shouldLoadViaRpc =
      !localIcon &&
      !cachedProxyIcon &&
      Boolean(entry.icon) &&
      Boolean(catalogIconLoader?.isAvailable());

    const webOnly = entry.targets.includes("web") && !entry.targets.includes("desktop");
    return renderDesktopExtensionCard({
      document,
      messages,
      contentLocale,
      extensionId: entry.id,
      cardKind: "marketplace",
      layout,
      displayName,
      iconUrl: resolvedUrl,
      resolveIconUrl:
        shouldLoadViaRpc && catalogIconLoader ? () => catalogIconLoader.load(entry) : undefined,
      author: entry.author,
      version: entry.version,
      downloads: entry.downloads,
      trustTier: entry.trustTier,
      description: catalogDescription(entry, contentLocale),
      categories: entry.categories,
      platformBadge: webOnly ? derivePlatformBadge(entry.targets, copy) : null,
      incompatiblePlatformLabel: webOnly ? copy.platformWebOnlyShort : undefined,
      capabilityBadges: [],
      actionControl: actionButton,
      busy: isBusyCard,
      dataset: {
        trustTier: entry.trustTier,
        installState,
      },
      onOpenDetails: () => onOpenDetails(entry.id),
    });
  };

  const hasExplicitFeatured = visibleEntries.some((entry) => entry.featured === true);
  const showFeaturedSection = isDefaultHome && (hasExplicitFeatured || visibleEntries.length > 3);

  const featuredEntries = showFeaturedSection
    ? selectFeaturedCatalogEntries(visibleEntries, 3)
    : [];
  const featuredIds = new Set(featuredEntries.map((entry) => entry.id));
  const communityEntries = showFeaturedSection
    ? visibleEntries.filter((entry) => !featuredIds.has(entry.id))
    : visibleEntries;

  const sections = createEl(document, "div", "settings-extensions-sections");
  sections.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);

  if (featuredEntries.length > 0) {
    const featuredSection = createEl(document, "section", "settings-extensions-section");
    featuredSection.dataset.marketSection = "featured";

    const heading = createEl(document, "h2", "settings-extensions-section__title");
    heading.append(
      createEl(document, "span", "", copy.sectionFeatured),
      createEl(
        document,
        "span",
        "settings-extensions-section__count",
        String(featuredEntries.length),
      ),
    );

    const grid = createEl(document, "div", "settings-extensions-featured-grid");
    for (const entry of featuredEntries) {
      grid.append(renderEntry(entry, "featured"));
    }

    featuredSection.append(heading, grid);
    sections.append(featuredSection);
  }

  if (communityEntries.length > 0) {
    const communitySection = createEl(document, "section", "settings-extensions-section");
    communitySection.dataset.marketSection = "community";

    const headingText = selectedCategory
      ? (contentCopy.categories[selectedCategory] ?? copy.sectionCommunity)
      : copy.sectionCommunity;
    const heading = createEl(document, "h2", "settings-extensions-section__title");
    heading.append(
      createEl(document, "span", "", headingText),
      createEl(
        document,
        "span",
        "settings-extensions-section__count",
        String(communityEntries.length),
      ),
    );

    const rowGrid = createEl(document, "div", "settings-extensions-row-grid");
    for (const entry of communityEntries) {
      rowGrid.append(renderEntry(entry, "row"));
    }

    communitySection.append(heading, rowGrid);
    sections.append(communitySection);
  }

  return sections;
}
