import type {
  DesktopExtensionCategory,
  DesktopExtensionStatus,
  DesktopExtensionTrustTier,
} from "@codexhost/shared-contracts";
import {
  contentLocaleMessages,
  createEl,
  createExtensionIconElement,
  formatExtensionCount,
  formatMessage,
  isValidExtensionCount,
  isWithinElement,
  parseSafeRepositoryUrl,
  statusTone,
  type DesktopExtensionAttentionDetail,
  type DesktopExtensionContentLocale,
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
  readonly repository?: string | undefined;
  readonly stars?: number | undefined;
  readonly downloads?: number | undefined;
  readonly trustTier?: DesktopExtensionTrustTier | undefined;
  readonly statusState?: DesktopExtensionStatus["state"] | undefined;
  readonly updateHint?: { readonly label: string; readonly title: string } | undefined;
  readonly description?: string | null | undefined;
  readonly attention?: DesktopExtensionAttentionDetail | null | undefined;
  readonly attentionId?: string | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
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
  if (trimmedVersion) parts.push(`v${trimmedVersion}`);
  return parts.join(" · ");
}

function shouldShowStatusDot(state: DesktopExtensionStatus["state"] | undefined): boolean {
  return Boolean(state && state !== "running" && state !== "disabled");
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
    repository,
    stars,
    downloads,
    trustTier,
    statusState,
    updateHint,
    description,
    attention,
    attentionId,
    categories,
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

  // Row 1: 32x32 rounded icon + Title + optional lightweight official shield / status dot on left, action control on right.
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
  actionWrap.append(actionControl);

  topRow.append(identity, actionWrap);
  card.append(topRow);

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

  // Row 3: Borderless muted metadata line — "author · vX.Y.Z" (+ optional subtle update cue, star link & downloads) on left,
  // plain middot-separated categories (up to 2) on right.
  const authorVersion = formatAuthorVersion(author, version);
  const repositoryHref = parseSafeRepositoryUrl(repository);
  const formattedStars = isValidExtensionCount(stars) ? formatExtensionCount(stars) : null;
  const formattedDownloads = isValidExtensionCount(downloads)
    ? formatExtensionCount(downloads)
    : null;
  const categoryLabels = (categories ?? [])
    .slice(0, MAX_CARD_CATEGORIES)
    .map((category) => contentCopy.categories[category] ?? category);
  const categoriesText = categoryLabels.join(" · ");

  let starControl: HTMLElement | null = null;
  if (
    authorVersion ||
    updateHint ||
    repositoryHref ||
    formattedStars ||
    formattedDownloads ||
    categoriesText
  ) {
    const metaRow = createEl(document, "div", "settings-extensions-card__meta");
    const metaLeft = createEl(document, "div", "settings-extensions-card__meta-left");
    if (authorVersion || updateHint) {
      const authorVersionWrap = createEl(
        document,
        "span",
        "settings-extensions-card__author-version",
      );
      if (authorVersion) {
        authorVersionWrap.append(createEl(document, "span", "", authorVersion));
      }
      if (updateHint) {
        const updateCue = createEl(
          document,
          "span",
          "settings-extensions-card__update-cue",
          authorVersion ? ` · ${updateHint.label}` : updateHint.label,
        );
        updateCue.dataset.updateAvailable = "true";
        updateCue.title = updateHint.title;
        authorVersionWrap.append(updateCue);
      }
      if (authorVersion) {
        authorVersionWrap.title = updateHint
          ? `${authorVersion} · ${updateHint.title}`
          : authorVersion;
      }
      metaLeft.append(authorVersionWrap);
    }

    if (repositoryHref) {
      const starLink = createEl(
        document,
        "a",
        "settings-extensions-card__star settings-extensions-card__star--link",
      );
      starLink.href = repositoryHref;
      starLink.target = "_blank";
      starLink.rel = "noopener noreferrer";
      starLink.dataset.action = "open-repository";
      const label = formattedStars
        ? `${copy.githubRepository} · ${formattedStars}`
        : copy.githubRepository;
      starLink.title = label;
      starLink.setAttribute("aria-label", label);
      starLink.append(createRendererSettingsIcon("star", 11));
      if (formattedStars) {
        starLink.append(createEl(document, "span", "", formattedStars));
      }
      starLink.addEventListener("click", stopTrigger);
      starLink.addEventListener("keydown", stopTrigger);
      starControl = starLink;
      metaLeft.append(starLink);
    } else if (formattedStars) {
      const starBadge = createEl(document, "span", "settings-extensions-card__star");
      starBadge.append(
        createRendererSettingsIcon("star", 11),
        createEl(document, "span", "", formattedStars),
      );
      metaLeft.append(starBadge);
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
    if (starControl && isWithinElement(event.target, starControl)) return;
    onOpenDetails();
  });
  card.addEventListener("keydown", (event) => {
    if (isWithinElement(event.target, actionWrap)) return;
    if (starControl && isWithinElement(event.target, starControl)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpenDetails();
    }
  });

  return card;
}
