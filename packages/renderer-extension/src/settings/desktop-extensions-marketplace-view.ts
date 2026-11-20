import type {
  DesktopExtensionCatalogEntry,
  DesktopExtensionsCatalogResult,
} from "@codexhost/shared-contracts";
import {
  catalogDescription,
  catalogDisplayName,
  createEl,
  createTrustBadge,
  extensionAvatarInitial,
  extensionAvatarTone,
  formatMessage,
  formatShortDate,
  hasCatalogUpdate,
  isWithinElement,
  type DesktopExtensionItem,
  type DesktopExtensionMutationAction,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

const MAX_CARD_CATEGORIES = 2;

export interface DesktopExtensionsMarketplaceViewOptions {
  readonly document: Document;
  readonly messages: RendererSettingsMessages;
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
  if (catalog.source !== "fallback" && !catalog.error) return null;
  const copy = messages.desktopExtensions;
  const notice = createEl(document, "div", "settings-extensions-market__notice");
  notice.setAttribute("role", "status");
  notice.dataset.source = catalog.source;

  const textWrap = createEl(document, "div", "settings-extensions-market__notice-copy");
  const text = catalog.error
    ? formatMessage(copy.marketplaceFallbackNoticeWithError, { message: catalog.error })
    : copy.marketplaceFallbackNotice;
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

  const grid = createEl(document, "div", "settings-extensions-market-grid");
  grid.setAttribute("aria-label", messages.pageLabels["desktop-extensions"]);

  for (const entry of visibleEntries) {
    const displayName = catalogDisplayName(entry, messages.locale);
    const installed = installedById.get(entry.id);
    const updateAvailable = hasCatalogUpdate(installed, entry);
    const installState = installed ? (updateAvailable ? "update" : "installed") : "available";
    const isBusyCard = activeMutationId === entry.id;

    const card = createEl(document, "article", "settings-extensions-market-card");
    card.dataset.extensionId = entry.id;
    card.dataset.trustTier = entry.trustTier;
    card.dataset.installState = installState;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-haspopup", "dialog");
    card.setAttribute("aria-label", formatMessage(copy.openDetailsLabel, { name: displayName }));
    if (isBusyCard) card.dataset.busy = "true";

    // Top: rounded initial avatar + title + trust badge + author · version.
    const top = createEl(document, "div", "settings-extensions-market-card__top");
    const icon = createEl(
      document,
      "div",
      "settings-extensions-market-card__icon",
      extensionAvatarInitial(displayName),
    );
    icon.dataset.tone = extensionAvatarTone(entry.id);
    icon.setAttribute("aria-hidden", "true");

    const headingBlock = createEl(document, "div", "settings-extensions-market-card__heading");
    const titleRow = createEl(document, "div", "settings-extensions-market-card__title-row");
    const nameEl = createEl(document, "h3", "settings-extensions-market-card__title", displayName);
    nameEl.title = displayName;
    titleRow.append(nameEl, createTrustBadge(document, entry.trustTier, copy));

    const subline = createEl(
      document,
      "div",
      "settings-extensions-market-card__subline",
      `${entry.author} · v${entry.version}`,
    );
    headingBlock.append(titleRow, subline);
    top.append(icon, headingBlock);

    // Middle: concise 2-line description.
    const descText = catalogDescription(entry, messages.locale) ?? "";
    const description = createEl(
      document,
      "p",
      "settings-extensions-market-card__description",
      descText,
    );
    description.title = descText;

    // Categories: at most 2 compact category chips + overflow indicator, never technical slots.
    const categories = entry.categories ?? [];
    const categoriesWrap = createEl(
      document,
      "div",
      "settings-extensions-categories settings-extensions-market-card__categories",
    );
    const shownCategories = categories.slice(0, MAX_CARD_CATEGORIES);
    for (const category of shownCategories) {
      const chip = createEl(
        document,
        "span",
        "settings-extensions-category-chip",
        copy.categories[category] ?? category,
      );
      chip.dataset.category = category;
      categoriesWrap.append(chip);
    }
    if (categories.length > MAX_CARD_CATEGORIES) {
      categoriesWrap.append(
        createEl(
          document,
          "span",
          "settings-extensions-category-chip settings-extensions-category-chip--more",
          `+${categories.length - MAX_CARD_CATEGORIES}`,
        ),
      );
    }
    categoriesWrap.hidden = categories.length === 0;

    // Footer: left status/date hint, right action button.
    const footer = createEl(document, "div", "settings-extensions-market-card__footer");
    const metaHint = createEl(document, "span", "settings-extensions-market-card__meta");
    if (installed?.manifest?.version) {
      metaHint.textContent = formatMessage(copy.installedVersionHint, {
        version: installed.manifest.version,
      });
    } else {
      const dateLabel = formatShortDate(entry.updatedAt ?? entry.publishedAt);
      if (dateLabel) {
        metaHint.textContent = formatMessage(copy.updatedAtLabel, { date: dateLabel });
      }
    }

    const actionWrap = createEl(document, "div", "settings-extensions-market-card__action");
    const actionButton = createEl(document, "button");
    actionButton.type = "button";
    actionButton.dataset.extensionId = entry.id;

    if (installState === "available") {
      actionButton.className = "settings-command-button settings-extensions-market-card__button";
      actionButton.dataset.action = "install";
      const installingThis = isBusyCard && activeMutationAction === "install";
      actionButton.textContent = installingThis ? copy.installing : copy.install;
      actionButton.disabled = mutating || !canInstall;
    } else if (installState === "update") {
      actionButton.className =
        "settings-command-button settings-extensions-market-card__button settings-extensions-market-card__button--update";
      actionButton.dataset.action = "update";
      const updatingThis = isBusyCard && activeMutationAction === "update";
      actionButton.textContent = updatingThis ? copy.updating : copy.update;
      actionButton.disabled = mutating || !canInstall;
    } else {
      actionButton.className =
        "settings-command-button settings-command-button--secondary settings-extensions-market-card__button settings-extensions-market-card__button--installed";
      actionButton.dataset.action = "installed";
      actionButton.append(
        createRendererSettingsIcon("check", 13),
        createEl(document, "span", "", copy.installedBadge),
      );
      actionButton.disabled = mutating;
    }

    const stopTrigger = (event: Event): void => {
      event.stopPropagation?.();
    };
    actionWrap.addEventListener("click", stopTrigger);
    actionWrap.addEventListener("keydown", stopTrigger);
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
    actionButton.addEventListener("keydown", stopTrigger);

    actionWrap.append(actionButton);
    footer.append(metaHint, actionWrap);

    card.append(top, description, categoriesWrap, footer);

    card.addEventListener("click", (event) => {
      if (isWithinElement(event.target, actionWrap)) return;
      onOpenDetails(entry.id);
    });
    card.addEventListener("keydown", (event) => {
      if (isWithinElement(event.target, actionWrap)) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenDetails(entry.id);
      }
    });

    grid.append(card);
  }

  return grid;
}
