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

export interface DesktopExtensionCardOptions {
  readonly document: Document;
  readonly messages: RendererSettingsMessages;
  readonly contentLocale?: DesktopExtensionContentLocale | undefined;
  readonly extensionId: string;
  readonly cardKind: "installed" | "marketplace";
  readonly displayName: string;
  readonly iconUrl?: string | undefined;
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
  readonly platformBadge: ExtensionPlatformBadge | null;
  readonly capabilityBadges?: readonly ExtensionCapabilityBadge[] | undefined;
  readonly secondaryAction?: HTMLElement | undefined;
  readonly actionControl: HTMLElement;
  readonly busy?: boolean | undefined;
  readonly dataset?: Readonly<Record<string, string | undefined>> | undefined;
  readonly onOpenDetails: () => void;
}

function formatAuthorVersion(author: string | undefined, version: string | undefined): string {
  const parts: string[] = [];
  const trimmedAuthor = author?.trim();
  const trimmedVersion = version?.trim();
  if (trimmedAuthor) parts.push(trimmedAuthor);
  if (trimmedVersion) {
    parts.push(trimmedVersion.startsWith("v") ? trimmedVersion : `v${trimmedVersion}`);
  }
  return parts.join(" · ");
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

export function renderDesktopExtensionCard(options: DesktopExtensionCardOptions): HTMLElement {
  const {
    document,
    messages,
    contentLocale = messages.locale,
    extensionId,
    cardKind,
    displayName,
    iconUrl,
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
    capabilityBadges = [],
    secondaryAction,
    actionControl,
    busy,
    dataset,
    onOpenDetails,
  } = options;
  const copy = messages.desktopExtensions;
  const contentCopy = contentLocaleMessages(contentLocale);

  const card = createEl(document, "article", "settings-extensions-card");
  card.dataset.extensionId = extensionId;
  card.dataset.cardKind = cardKind;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      if (value !== undefined) card.dataset[key] = value;
    }
  }
  if (busy) card.dataset.busy = "true";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-haspopup", "dialog");
  card.setAttribute("aria-label", formatMessage(copy.openDetailsLabel, { name: displayName }));
  if (platformBadge) card.setAttribute("aria-description", platformBadge.label);

  // Row 1: 32x32 rounded icon + Title + optional official shield / status dot on left, actions on right.
  const topRow = createEl(document, "div", "settings-extensions-card__top");
  const identity = createEl(document, "div", "settings-extensions-card__identity");
  const iconEl = createExtensionIconElement({
    document,
    iconUrl,
    categories,
    size: "card",
    alt: displayName,
  });
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
    verified.append(createRendererSettingsIcon("shield-check", 14));
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

  identity.append(iconEl, titleGroup);

  const actionWrap = createEl(document, "div", "settings-extensions-card__action");
  const stopTrigger = (event: Event): void => {
    event.stopPropagation?.();
  };
  actionWrap.addEventListener("click", stopTrigger);
  actionWrap.addEventListener("keydown", stopTrigger);
  if (secondaryAction) {
    actionWrap.append(secondaryAction);
  }
  actionWrap.append(actionControl);

  topRow.append(identity, actionWrap);
  card.append(topRow);

  // Platform and capability badges.
  if (platformBadge || capabilityBadges.length > 0) {
    const badgesRow = createEl(document, "div", "settings-extensions-card__capabilities");
    if (platformBadge)
      badgesRow.append(createExtensionPlatformBadgeElement(document, platformBadge));
    for (const badge of capabilityBadges) {
      const chip = createEl(document, "span", "settings-extensions-cap-badge", badge.label);
      chip.dataset.capability = badge.kind;
      badgesRow.append(chip);
    }
    card.append(badgesRow);
  }

  // Row 2: 2-line clamped muted description + optional compact inline error callout.
  const trimmedDescription = description?.trim() ?? "";
  if (trimmedDescription || attention) {
    const body = createEl(document, "div", "settings-extensions-card__body");
    if (trimmedDescription) {
      const descEl = createEl(
        document,
        "p",
        "settings-extensions-card__description",
        trimmedDescription,
      );
      descEl.title = trimmedDescription;
      body.append(descEl);
    }
    if (attention) {
      const detail = createEl(document, "div", "settings-extensions-card__detail");
      if (attentionId) detail.id = attentionId;
      detail.dataset.tone = attention.tone;
      detail.append(
        createRendererSettingsIcon("alert", 13),
        createEl(document, "span", "", attention.text),
      );
      body.append(detail);
    }
    card.append(body);
  }

  if (update) {
    card.dataset.updateAvailable = "true";
    const row = createEl(document, "div", "settings-extensions-card__update");
    row.dataset.updateAvailable = "true";
    update.action.addEventListener("click", stopTrigger);
    update.action.addEventListener("keydown", stopTrigger);
    const label = createEl(
      document,
      "span",
      "settings-extensions-card__update-label",
      update.label,
    );
    row.append(label, update.action);
    card.append(row);
  }

  // Borderless muted metadata line.
  const authorVersion = formatAuthorVersion(author, version);
  const formattedDownloads = formatPositiveExtensionCount(downloads);
  const categoryLabels = (categories ?? [])
    .slice(0, MAX_CARD_CATEGORIES)
    .map((category) => contentCopy.categories[category] ?? category);
  const categoriesText = categoryLabels.join(" · ");

  if (authorVersion || formattedDownloads || categoriesText) {
    const metaRow = createEl(document, "div", "settings-extensions-card__meta");
    const metaLeft = createEl(document, "div", "settings-extensions-card__meta-left");
    if (authorVersion) {
      const authorVersionWrap = createEl(
        document,
        "span",
        "settings-extensions-card__author-version",
        authorVersion,
      );
      authorVersionWrap.title = authorVersion;
      metaLeft.append(authorVersionWrap);
    }

    if (formattedDownloads) {
      const downloadsBadge = createEl(document, "span", "settings-extensions-card__downloads");
      downloadsBadge.dataset.metric = "downloads";
      const downloadsLabel = formatMessage(copy.downloadsLabel, { count: formattedDownloads });
      downloadsBadge.title = downloadsLabel;
      downloadsBadge.setAttribute("aria-label", downloadsLabel);
      downloadsBadge.append(
        createRendererSettingsIcon("download", 11),
        createEl(document, "span", "", formattedDownloads),
      );
      metaLeft.append(downloadsBadge);
    }

    metaRow.append(metaLeft);

    if (categoriesText) {
      const catEl = createEl(
        document,
        "span",
        "settings-extensions-card__categories-text",
        categoriesText,
      );
      catEl.title = categoriesText;
      metaRow.append(catEl);
    }

    card.append(metaRow);
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
