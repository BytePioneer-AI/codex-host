import type {
  DesktopExtensionCatalogEntry,
  DesktopExtensionsCatalogResult,
} from "@codexhost/shared-contracts";
import { renderDesktopExtensionCard } from "./desktop-extensions-card.js";
import {
  catalogDescription,
  catalogDisplayName,
  createEl,
  formatMessage,
  hasCatalogUpdate,
  type DesktopExtensionContentLocale,
  type DesktopExtensionItem,
  type DesktopExtensionMutationAction,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface DesktopExtensionsMarketplaceViewOptions {
  readonly document: Document;
  readonly messages: RendererSettingsMessages;
  readonly contentLocale?: DesktopExtensionContentLocale | undefined;
  readonly catalog: DesktopExtensionsCatalogResult;
  readonly visibleEntries: readonly DesktopExtensionCatalogEntry[];
  readonly installedById: ReadonlyMap<string, DesktopExtensionItem>;
  readonly canInstall: boolean;
  readonly mutating: boolean;
  readonly activeMutationId: string | null;
  readonly activeMutationAction: DesktopExtensionMutationAction | null;
  readonly onOpenDetails: (extensionId: string) => void;
  readonly onInstall: (entry: DesktopExtensionCatalogEntry, isUpdate: boolean) => void;
  readonly onViewInstalled: (extensionId: string) => void;
  readonly onRetryCatalog: () => void;
}

export function renderMarketplaceFallbackNotice(
  document: Document,
  messages: RendererSettingsMessages,
  catalog: DesktopExtensionsCatalogResult,
  disabled: boolean,
  onRetry: () => void,
): HTMLElement | null {
  const showFallbackNotice = catalog.source === "fallback";
  const showEmptyErrorNotice =
    catalog.source !== "fallback" && Boolean(catalog.error) && catalog.extensions.length === 0;
  if (!showFallbackNotice && !showEmptyErrorNotice) return null;

  const copy = messages.desktopExtensions;
  const notice = createEl(document, "div", "settings-extensions-market__notice");
  notice.setAttribute("role", "status");
  notice.dataset.source = catalog.source;

  const textWrap = createEl(document, "div", "settings-extensions-market__notice-copy");
  const text = showFallbackNotice
    ? copy.marketplaceFallbackNotice
    : formatMessage(copy.marketplaceLoadFailed, { message: catalog.error ?? "" });
  textWrap.append(createRendererSettingsIcon("info", 14), createEl(document, "span", "", text));

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
    mutating,
    activeMutationId,
    activeMutationAction,
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
    const isBusyCard = activeMutationId === entry.id;

    const actionButton = createEl(document, "button");
    actionButton.type = "button";
    actionButton.dataset.extensionId = entry.id;

    if (installState === "available") {
      actionButton.className = "settings-command-button settings-extensions-card__button";
      actionButton.dataset.action = "install";
      const installingThis = isBusyCard && activeMutationAction === "install";
      actionButton.textContent = installingThis ? copy.installing : copy.install;
      actionButton.disabled = mutating || !canInstall;
    } else if (installState === "update") {
      actionButton.className =
        "settings-command-button settings-extensions-card__button settings-extensions-card__button--update";
      actionButton.dataset.action = "update";
      const updatingThis = isBusyCard && activeMutationAction === "update";
      actionButton.textContent = updatingThis ? copy.updating : copy.update;
      actionButton.disabled = mutating || !canInstall;
    } else {
      actionButton.className =
        "settings-command-button settings-command-button--secondary settings-extensions-card__button settings-extensions-card__button--installed";
      actionButton.dataset.action = "installed";
      actionButton.append(
        createRendererSettingsIcon("check", 12),
        createEl(document, "span", "", copy.installedBadge),
      );
      actionButton.disabled = mutating;
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
        iconUrl: (entry as { readonly icon?: string }).icon,
        author: entry.author,
        version: entry.version,
        repository: entry.repository,
        stars: entry.stars,
        downloads: entry.downloads,
        trustTier: entry.trustTier,
        description: catalogDescription(entry, contentLocale),
        categories: entry.categories,
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
