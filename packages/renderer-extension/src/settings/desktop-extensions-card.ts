import type {
  DesktopExtensionCategory,
  DesktopExtensionStatus,
  DesktopExtensionTrustTier,
} from "@codexhost/shared-contracts";
import {
  contentLocaleMessages,
  createEl,
  createExtensionIconElement,
  formatMessage,
  formatPositiveExtensionCount,
  isWithinElement,
  statusTone,
  type DesktopExtensionAttentionDetail,
  type DesktopExtensionContentLocale,
  type ExtensionCapabilityBadge,
  type ExtensionPlatformBadge,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export const MAX_CARD_CATEGORIES = 2;

export type DesktopExtensionCardLayout = "featured" | "row";

export interface DesktopExtensionCardOptions {
  readonly document: Document;
  readonly messages: RendererSettingsMessages;
  readonly contentLocale?: DesktopExtensionContentLocale | undefined;
  readonly extensionId: string;
  readonly cardKind: "installed" | "marketplace";
  readonly layout?: DesktopExtensionCardLayout | undefined;
  readonly displayName: string;
  readonly iconUrl?: string | undefined;
  readonly resolveIconUrl?: (() => Promise<string | null>) | undefined;
  readonly author?: string | undefined;
  readonly version?: string | undefined;
  readonly downloads?: number | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly statusState?: DesktopExtensionStatus["state"] | undefined;
  readonly update?: { readonly label: string; readonly action: HTMLElement } | undefined;
  readonly description?: string | null | undefined;
  readonly attention?: DesktopExtensionAttentionDetail | null | undefined;
  readonly attentionId?: string | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  readonly platformBadge?: ExtensionPlatformBadge | null | undefined;
  readonly incompatiblePlatformLabel?: string | undefined;
  readonly capabilityBadges?: readonly ExtensionCapabilityBadge[] | undefined;
  readonly secondaryAction?: HTMLElement | undefined;
  readonly actionControl: HTMLElement;
  readonly busy?: boolean | undefined;
  readonly dataset?: Readonly<Record<string, string | undefined>> | undefined;
  readonly onOpenDetails: () => void;
}

function formatVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function shouldShowStatusDot(state: DesktopExtensionStatus["state"] | undefined): boolean {
  return Boolean(state && state !== "running" && state !== "disabled");
}

export function createExtensionPlatformBadgeElement(
  document: Document,
  badge: ExtensionPlatformBadge,
): HTMLSpanElement {
  const element = createEl(document, "span", "settings-extensions-cap-badge", badge.label);
  element.dataset.platform = badge.kind;
  return element;
}

/**
 * Renders either a Kettu-style 3-column Featured showcase card (`layout: "featured"`)
 * or a lightweight 2-column borderless row (`layout: "row"`), aligned with CH Web.
 */
export function renderDesktopExtensionCard(options: DesktopExtensionCardOptions): HTMLElement {
  const {
    document,
    messages,
    contentLocale = messages.locale,
    extensionId,
    cardKind,
    layout = "row",
    displayName,
    iconUrl,
    resolveIconUrl,
    author,
    version,
    downloads,
    trustTier,
    statusState,
    update,
    description,
    attention,
    attentionId,
    categories,
    platformBadge,
    incompatiblePlatformLabel,
    secondaryAction,
    actionControl,
    busy,
    dataset,
    onOpenDetails,
  } = options;
  const copy = messages.desktopExtensions;
  const contentCopy = contentLocaleMessages(contentLocale);

  const isFeatured = layout === "featured";
  const card = createEl(
    document,
    "article",
    isFeatured
      ? "settings-extensions-card settings-extensions-card--featured"
      : "settings-extensions-row",
  );
  card.dataset.extensionId = extensionId;
  card.dataset.cardKind = cardKind;
  card.dataset.layout = layout;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      if (value !== undefined) card.dataset[key] = value;
    }
  }
  if (busy) card.dataset.busy = "true";
  if (update) card.dataset.updateAvailable = "true";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-haspopup", "dialog");
  card.setAttribute("aria-label", formatMessage(copy.openDetailsLabel, { name: displayName }));
  const ariaDesc = platformBadge?.label ?? incompatiblePlatformLabel;
  if (ariaDesc) card.setAttribute("aria-description", ariaDesc);

  const stopTrigger = (event: Event): void => {
    event.stopPropagation?.();
  };

  // Title group: title + optional official shield + optional status dot + optional incompatible platform hint.
  const titleGroup = createEl(document, "div", "settings-extensions-card__title-group");
  const nameEl = createEl(document, "h3", "settings-extensions-card__title", displayName);
  nameEl.title = displayName;
  titleGroup.append(nameEl);

  if (trustTier === "official") {
    const verified = createEl(document, "span", "settings-extensions-card__verified");
    verified.dataset.trustTier = "official";
    verified.setAttribute("role", "img");
    verified.setAttribute("aria-label", copy.trustOfficial);
    verified.title = copy.trustOfficial;
    verified.append(createRendererSettingsIcon("shield-check", 13));
    titleGroup.append(verified);
  }

  if (shouldShowStatusDot(statusState) && statusState) {
    const dot = createEl(document, "span", "settings-extensions-card__status-dot");
    dot.dataset.state = statusState;
    dot.dataset.tone = statusTone(statusState);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", copy.states[statusState]);
    dot.title = copy.states[statusState];
    titleGroup.append(dot);
  }

  const compatLabel =
    incompatiblePlatformLabel ?? (platformBadge?.kind === "web" ? platformBadge.label : undefined);
  if (compatLabel) {
    const hint = createEl(document, "span", "settings-extensions-compat-hint", compatLabel);
    hint.dataset.platform = platformBadge?.kind ?? "web";
    titleGroup.append(hint);
  }

  // Single muted dot-separated metadata line: Category · Author · vX.Y.Z · ↓ N
  const firstCategory = categories?.[0];
  const primaryCategory = firstCategory
    ? (contentCopy.categories[firstCategory] ?? firstCategory)
    : undefined;
  const trimmedAuthor = author?.trim() || undefined;
  const formattedVersion = formatVersion(version);
  const formattedDownloads = formatPositiveExtensionCount(downloads);

  const metaParts: string[] = [];
  if (primaryCategory) metaParts.push(primaryCategory);
  if (trimmedAuthor) metaParts.push(trimmedAuthor);
  if (formattedVersion) metaParts.push(formattedVersion);

  const downloadsLabel = formattedDownloads
    ? formatMessage(copy.downloadsLabel, { count: formattedDownloads })
    : undefined;

  let metaLine: HTMLDivElement | null = null;
  if (metaParts.length > 0 || formattedDownloads) {
    metaLine = createEl(document, "div", "settings-extensions-card__meta-line");
    metaLine.title = [...metaParts, ...(downloadsLabel ? [downloadsLabel] : [])].join(" · ");
    for (const part of metaParts) {
      metaLine.append(createEl(document, "span", "settings-extensions-card__meta-segment", part));
    }
    if (formattedDownloads) {
      const downloadsBadge = createEl(
        document,
        "span",
        "settings-extensions-card__meta-segment settings-extensions-card__downloads",
      );
      downloadsBadge.dataset.metric = "downloads";
      if (downloadsLabel) {
        downloadsBadge.title = downloadsLabel;
        downloadsBadge.setAttribute("aria-label", downloadsLabel);
      }
      downloadsBadge.append(
        createRendererSettingsIcon("download", 11),
        createEl(document, "span", "", formattedDownloads),
      );
      metaLine.append(downloadsBadge);
    }
  }

  const actionWrap = createEl(document, "div", "settings-extensions-card__action");
  actionWrap.addEventListener("click", stopTrigger);
  actionWrap.addEventListener("keydown", stopTrigger);
  if (secondaryAction) {
    actionWrap.append(secondaryAction);
  }
  actionWrap.append(actionControl);

  const trimmedDescription = description?.trim() ?? "";

  if (isFeatured) {
    const topRow = createEl(document, "div", "settings-extensions-card__featured-top");
    const iconEl = createExtensionIconElement({
      document,
      iconUrl,
      resolveIconUrl,
      categories,
      size: "card",
      alt: displayName,
    });
    topRow.append(iconEl, actionWrap);

    const body = createEl(document, "div", "settings-extensions-card__featured-body");
    body.append(titleGroup);
    if (metaLine) body.append(metaLine);
    if (trimmedDescription) {
      const descEl = createEl(
        document,
        "p",
        "settings-extensions-card__description settings-extensions-card__description--featured",
        trimmedDescription,
      );
      descEl.title = trimmedDescription;
      body.append(descEl);
    }
    card.append(topRow, body);
  } else {
    const iconWrap = createEl(document, "div", "settings-extensions-row__icon");
    const iconEl = createExtensionIconElement({
      document,
      iconUrl,
      resolveIconUrl,
      categories,
      size: "row",
      alt: displayName,
    });
    iconWrap.append(iconEl);

    const main = createEl(document, "div", "settings-extensions-row__main");
    const rowTop = createEl(document, "div", "settings-extensions-row__top");
    const textHead = createEl(document, "div", "settings-extensions-row__text-head");
    textHead.append(titleGroup);
    if (metaLine) textHead.append(metaLine);
    rowTop.append(textHead, actionWrap);
    main.append(rowTop);

    if (trimmedDescription) {
      const descEl = createEl(
        document,
        "p",
        "settings-extensions-row__description",
        trimmedDescription,
      );
      descEl.title = trimmedDescription;
      main.append(descEl);
    }

    if (attention) {
      const detail = createEl(document, "div", "settings-extensions-card__detail");
      if (attentionId) detail.id = attentionId;
      detail.dataset.tone = attention.tone;
      detail.append(
        createRendererSettingsIcon("alert", 13),
        createEl(document, "span", "", attention.text),
      );
      main.append(detail);
    }

    if (update) {
      const updateRow = createEl(document, "div", "settings-extensions-card__update");
      updateRow.dataset.updateAvailable = "true";
      update.action.addEventListener("click", stopTrigger);
      update.action.addEventListener("keydown", stopTrigger);
      const label = createEl(
        document,
        "span",
        "settings-extensions-card__update-label",
        update.label,
      );
      updateRow.append(label, update.action);
      main.append(updateRow);
    }

    card.append(iconWrap, main);
  }

  card.addEventListener("click", (event) => {
    if (isWithinElement(event.target, actionWrap)) return;
    onOpenDetails();
  });
  card.addEventListener("keydown", (event) => {
    if (isWithinElement(event.target, actionWrap)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenDetails();
    }
  });

  return card;
}
