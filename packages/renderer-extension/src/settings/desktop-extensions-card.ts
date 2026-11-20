import type {
  DesktopExtensionCategory,
  DesktopExtensionStatus,
  DesktopExtensionTrustTier,
} from "@codexhost/shared-contracts";
import {
  createEl,
  createTrustBadge,
  formatMessage,
  isWithinElement,
  statusTone,
  type DesktopExtensionAttentionDetail,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export const MAX_CARD_CATEGORIES = 2;

export interface DesktopExtensionCardOptions {
  readonly document: Document;
  readonly messages: RendererSettingsMessages;
  readonly extensionId: string;
  readonly cardKind: "installed" | "marketplace";
  readonly displayName: string;
  readonly author?: string | undefined;
  readonly version?: string | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly statusState?: DesktopExtensionStatus["state"] | undefined;
  readonly description?: string | null | undefined;
  readonly attention?: DesktopExtensionAttentionDetail | null | undefined;
  readonly attentionId?: string | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  readonly footerMeta: HTMLElement | string | null;
  readonly footerAction: HTMLElement;
  readonly busy?: boolean | undefined;
  readonly dataset?: Readonly<Record<string, string | undefined>> | undefined;
  readonly onOpenDetails: () => void;
}

function formatSubline(author: string | undefined, version: string | undefined): string {
  const parts: string[] = [];
  const trimmedAuthor = author?.trim();
  const trimmedVersion = version?.trim();
  if (trimmedAuthor) parts.push(trimmedAuthor);
  if (trimmedVersion) parts.push(`v${trimmedVersion}`);
  return parts.join(" · ");
}

export function renderDesktopExtensionCard(options: DesktopExtensionCardOptions): HTMLElement {
  const {
    document,
    messages,
    extensionId,
    cardKind,
    displayName,
    author,
    version,
    trustTier,
    statusState,
    description,
    attention,
    attentionId,
    categories,
    footerMeta,
    footerAction,
    busy,
    dataset,
    onOpenDetails,
  } = options;
  const copy = messages.desktopExtensions;

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

  // Header: title + optional trust/status badges, followed by optional "author · vX.Y.Z" subline.
  const head = createEl(document, "div", "settings-extensions-card__head");
  const titleRow = createEl(document, "div", "settings-extensions-card__title-row");
  const nameEl = createEl(document, "h3", "settings-extensions-card__title", displayName);
  nameEl.title = displayName;
  titleRow.append(nameEl);

  if (trustTier) {
    titleRow.append(createTrustBadge(document, trustTier, copy));
  }
  if (statusState && statusState !== "disabled") {
    const badge = createEl(document, "span", "settings-extensions-badge", copy.states[statusState]);
    badge.dataset.state = statusState;
    badge.dataset.tone = statusTone(statusState);
    titleRow.append(badge);
  }
  head.append(titleRow);

  const sublineText = formatSubline(author, version);
  if (sublineText) {
    const subline = createEl(document, "div", "settings-extensions-card__subline", sublineText);
    subline.title = sublineText;
    head.append(subline);
  }
  card.append(head);

  // Middle: 2-line clamped description + optional inline attention diagnostic for installed items.
  const trimmedDescription = description?.trim() ?? "";
  if (trimmedDescription) {
    const descEl = createEl(
      document,
      "p",
      "settings-extensions-card__description",
      trimmedDescription,
    );
    descEl.title = trimmedDescription;
    card.append(descEl);
  }

  if (attention) {
    const detail = createEl(document, "div", "settings-extensions-card__detail");
    if (attentionId) detail.id = attentionId;
    detail.dataset.tone = attention.tone;
    detail.append(
      createRendererSettingsIcon("alert", 13),
      createEl(document, "span", "", attention.text),
    );
    card.append(detail);
  }

  // Categories: at most 2 compact category chips + "+N" overflow pill.
  const categoryList = categories ?? [];
  if (categoryList.length > 0) {
    const categoriesWrap = createEl(
      document,
      "div",
      "settings-extensions-categories settings-extensions-card__categories",
    );
    for (const category of categoryList.slice(0, MAX_CARD_CATEGORIES)) {
      const chip = createEl(
        document,
        "span",
        "settings-extensions-category-chip",
        copy.categories[category] ?? category,
      );
      chip.dataset.category = category;
      categoriesWrap.append(chip);
    }
    if (categoryList.length > MAX_CARD_CATEGORIES) {
      categoriesWrap.append(
        createEl(
          document,
          "span",
          "settings-extensions-category-chip settings-extensions-category-chip--more",
          `+${categoryList.length - MAX_CARD_CATEGORIES}`,
        ),
      );
    }
    card.append(categoriesWrap);
  }

  // Footer: left metadata/status, right interactive control (toggle or install/update button).
  const footer = createEl(document, "div", "settings-extensions-card__footer");
  const metaWrap = createEl(document, "div", "settings-extensions-card__meta");
  if (typeof footerMeta === "string") {
    metaWrap.textContent = footerMeta;
    if (footerMeta) metaWrap.title = footerMeta;
  } else if (footerMeta) {
    metaWrap.append(footerMeta);
  }

  const actionWrap = createEl(document, "div", "settings-extensions-card__action");
  const stopTrigger = (event: Event): void => {
    event.stopPropagation?.();
  };
  actionWrap.addEventListener("click", stopTrigger);
  actionWrap.addEventListener("keydown", stopTrigger);
  actionWrap.append(footerAction);

  footer.append(metaWrap, actionWrap);
  card.append(footer);

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
