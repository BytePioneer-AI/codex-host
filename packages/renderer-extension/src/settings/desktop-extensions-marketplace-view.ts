import type {
  HostExtensionCatalogEntry,
  HostExtensionListItem,
  HostExtensionsCatalogResult,
} from "@codexhost/shared-contracts";
import { renderDesktopExtensionCard } from "./desktop-extensions-card.js";
import {
  catalogCapabilities,
  catalogDescription,
  catalogDisplayName,
  createEl,
  deriveCapabilityBadges,
  derivePlatformBadge,
  hasCatalogUpdate,
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
    canInstall,
    pendingMutations,
    globalBusy,
    onOpenDetails,
    onInstall,
    onViewInstalled,
  } = options;
  const copy = messages.desktopExtensions;

  const grid = createEl(document, "div", "settings-extensions-grid");
  grid.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);

  for (const entry of visibleEntries) {
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
      actionButton.className = "settings-command-button settings-extensions-card__button";
      actionButton.dataset.action = "install";
      const installingThis = entryAction === "install";
      actionButton.textContent = installingThis ? copy.installing : copy.install;
      actionButton.setAttribute("aria-busy", String(installingThis));
      actionButton.disabled = controlsDisabled || !canInstall;
    } else if (installState === "update") {
      actionButton.className =
        "settings-command-button settings-extensions-card__button settings-extensions-card__button--update";
      actionButton.dataset.action = "update";
      const updatingThis = entryAction === "update";
      actionButton.textContent = updatingThis ? copy.updating : copy.update;
      actionButton.setAttribute("aria-busy", String(updatingThis));
      actionButton.disabled = controlsDisabled || !canInstall;
    } else {
      actionButton.className =
        "settings-command-button settings-command-button--secondary settings-extensions-card__button settings-extensions-card__button--installed";
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

    grid.append(
      renderDesktopExtensionCard({
        document,
        messages,
        contentLocale,
        extensionId: entry.id,
        cardKind: "marketplace",
        displayName,
        iconUrl: entry.icon,
        author: entry.author,
        version: entry.version,
        downloads: entry.downloads,
        trustTier: entry.trustTier,
        description: catalogDescription(entry, contentLocale),
        categories: entry.categories,
        platformBadge: derivePlatformBadge(entry.targets, copy),
        capabilityBadges: deriveCapabilityBadges(catalogCapabilities(entry), copy),
        actionControl: actionButton,
        busy: isBusyCard,
        dataset: {
          trustTier: entry.trustTier,
          installState,
        },
        onOpenDetails: () => onOpenDetails(entry.id),
      }),
    );
  }

  return grid;
}
