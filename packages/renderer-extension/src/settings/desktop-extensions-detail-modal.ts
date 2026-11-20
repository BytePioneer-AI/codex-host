import {
  resolveLocalizedExtensionText,
  type DesktopExtensionSlot,
  type DesktopExtensionStatus,
  type DesktopExtensionsListResult,
} from "@codexhost/shared-contracts";
import type { DesktopExtensionsMessages } from "./desktop-extensions-messages.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

export type DesktopExtensionItem = DesktopExtensionsListResult["extensions"][number];
export type DesktopExtensionBannerTone = "info" | "success" | "warning" | "danger";
export type DesktopExtensionGroupId = "attention" | "enabled" | "disabled";

export interface DesktopExtensionFeedback {
  readonly tone: DesktopExtensionBannerTone;
  readonly text: string;
  readonly retryable?: boolean;
}

export interface DesktopExtensionAttentionDetail {
  readonly tone: "warning" | "danger";
  readonly text: string;
}

const SAFE_SCREENSHOT_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

export function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, key: string) => values[key] ?? match);
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function extensionGroupOf(state: DesktopExtensionStatus["state"]): DesktopExtensionGroupId {
  switch (state) {
    case "failed":
    case "conflict":
    case "invalid":
    case "incompatible":
      return "attention";
    case "running":
    case "waiting":
      return "enabled";
    case "disabled":
      return "disabled";
  }
}

export function statusTone(
  state: DesktopExtensionStatus["state"],
): DesktopExtensionBannerTone | "neutral" {
  if (state === "running") return "success";
  if (state === "waiting") return "info";
  if (state === "conflict" || state === "incompatible") return "warning";
  if (state === "failed" || state === "invalid") return "danger";
  return "neutral";
}

function resolveOptionalLocalizedText(
  value: { en: string; "zh-CN"?: string | undefined } | undefined,
  locale: RendererSettingsMessages["locale"],
): string | null {
  if (!value) return null;
  const localized =
    value["zh-CN"] !== undefined ? { en: value.en, "zh-CN": value["zh-CN"] } : { en: value.en };
  const trimmed = resolveLocalizedExtensionText(localized, locale).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extensionDisplayName(
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string {
  return item.manifest ? resolveLocalizedExtensionText(item.manifest.name, locale) : item.id;
}

export function extensionDescription(
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string | null {
  return resolveOptionalLocalizedText(item.manifest?.description, locale);
}

export function extensionDetailsParagraphs(
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string[] {
  const raw =
    resolveOptionalLocalizedText(item.manifest?.details, locale) ??
    extensionDescription(item, locale);
  if (!raw) return [];
  return raw
    .split(/\r?\n\s*\r?\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function parseSafeRepositoryUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeScreenshotDataUrls(item: DesktopExtensionItem): readonly string[] {
  const urls = item.screenshotDataUrls;
  if (!urls || urls.length === 0) return [];
  return urls.filter((url) => SAFE_SCREENSHOT_DATA_URL_PATTERN.test(url));
}

export function formatSlotLabel(
  slot: DesktopExtensionSlot,
  copy: DesktopExtensionsMessages,
): string {
  const localized = copy.slots[slot];
  return localized ? `${localized} (${slot})` : slot;
}

export function describeOtherExtension(
  conflictWithId: string,
  extensions: readonly DesktopExtensionItem[],
  locale: RendererSettingsMessages["locale"],
): string {
  const other = extensions.find((item) => item.id === conflictWithId);
  const name = other?.manifest
    ? resolveLocalizedExtensionText(other.manifest.name, locale)
    : undefined;
  return name && name !== conflictWithId ? `${name} (${conflictWithId})` : conflictWithId;
}

export function overlappingSlots(
  target: DesktopExtensionItem,
  conflictWithId: string,
  extensions: readonly DesktopExtensionItem[],
): readonly DesktopExtensionSlot[] {
  const targetSlots = target.manifest?.slots ?? [];
  if (targetSlots.length === 0) return [];
  const otherSlots = extensions.find((item) => item.id === conflictWithId)?.manifest?.slots;
  if (!otherSlots || otherSlots.length === 0) return targetSlots;
  const shared = targetSlots.filter((slot) => otherSlots.includes(slot));
  return shared.length > 0 ? shared : targetSlots;
}

export function isToggleBlocked(item: DesktopExtensionItem): boolean {
  if (item.enabled) return false;
  return (
    item.status.state === "incompatible" ||
    item.status.state === "invalid" ||
    item.manifest === undefined
  );
}

export function blockedToggleReason(
  item: DesktopExtensionItem,
  copy: DesktopExtensionsMessages,
): string {
  if (item.status.error) return item.status.error;
  return item.status.state === "incompatible"
    ? copy.toggleDisabledIncompatible
    : copy.toggleDisabledInvalid;
}

export function resolveAttentionDetail(
  item: DesktopExtensionItem,
  allExtensions: readonly DesktopExtensionItem[],
  locale: RendererSettingsMessages["locale"],
  copy: DesktopExtensionsMessages,
): DesktopExtensionAttentionDetail | null {
  if (extensionGroupOf(item.status.state) !== "attention") return null;
  if (item.status.conflictWith) {
    const other = describeOtherExtension(item.status.conflictWith, allExtensions, locale);
    const shared = overlappingSlots(item, item.status.conflictWith, allExtensions);
    return {
      tone: "warning",
      text:
        shared.length > 0
          ? formatMessage(copy.conflictSlotDetails, {
              slots: shared.map((slot) => formatSlotLabel(slot, copy)).join(", "),
              other,
            })
          : formatMessage(copy.conflictOccupiedBy, { other }),
    };
  }
  if (item.status.error) {
    return {
      tone: item.status.state === "incompatible" ? "warning" : "danger",
      text: item.status.error,
    };
  }
  if (isToggleBlocked(item)) {
    return {
      tone: item.status.state === "incompatible" ? "warning" : "danger",
      text: blockedToggleReason(item, copy),
    };
  }
  return null;
}

export interface DesktopExtensionDetailModalState {
  readonly extensions: readonly DesktopExtensionItem[];
  readonly unavailable: boolean;
  readonly mutating: boolean;
  readonly activeMutationId: string | null;
  readonly feedback: DesktopExtensionFeedback | null;
}

export interface DesktopExtensionDetailModalController {
  readonly extensionId: string | null;
  readonly isOpen: boolean;
  open(extensionId: string, state: DesktopExtensionDetailModalState): void;
  sync(state: DesktopExtensionDetailModalState): void;
  close(): void;
  dispose(): void;
}

export function createDesktopExtensionDetailModal(options: {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  readonly messages: RendererSettingsMessages;
  readonly onToggle: (item: DesktopExtensionItem, enable: boolean) => void;
  readonly onClose?: () => void;
}): DesktopExtensionDetailModalController {
  const { document, host, signal, messages, onToggle, onClose } = options;
  const copy = messages.desktopExtensions;

  let dialog: HTMLDialogElement | null = null;
  let openExtensionId: string | null = null;
  let activeScreenshotIndex: number | null = null;
  let renderedScreenshotsKey = "";
  let techExpanded = false;
  let currentItem: DesktopExtensionItem | null = null;
  let currentMutating = false;

  // Persistent DOM nodes inside the open modal so 5s polls update in-place cleanly.
  let titleEl: HTMLHeadingElement | null = null;
  let statusBadge: HTMLSpanElement | null = null;
  let metaRow: HTMLDivElement | null = null;
  let modalToggle: HTMLInputElement | null = null;
  let feedbackBar: HTMLDivElement | null = null;
  let attentionBar: HTMLDivElement | null = null;
  let descriptionSection: HTMLDivElement | null = null;
  let screenshotsSection: HTMLElement | null = null;
  let previewStage: HTMLDivElement | null = null;
  let previewImage: HTMLImageElement | null = null;
  let previewCounter: HTMLSpanElement | null = null;
  let previewPrevButton: HTMLButtonElement | null = null;
  let previewNextButton: HTMLButtonElement | null = null;
  let galleryGrid: HTMLDivElement | null = null;
  let techDetails: HTMLDetailsElement | null = null;
  let techMetaList: HTMLDListElement | null = null;
  let currentScreenshots: readonly string[] = [];
  let currentDisplayName = "";

  const syncPreviewStage = (): void => {
    if (!previewStage || !previewImage || !previewCounter || !galleryGrid) return;
    const total = currentScreenshots.length;
    if (
      activeScreenshotIndex !== null &&
      (activeScreenshotIndex < 0 || activeScreenshotIndex >= total)
    ) {
      activeScreenshotIndex = null;
    }

    const thumbButtons = galleryGrid.children;
    for (let i = 0; i < thumbButtons.length; i += 1) {
      const button = thumbButtons[i];
      if (button && typeof (button as HTMLElement).setAttribute === "function") {
        (button as HTMLElement).setAttribute("aria-pressed", String(activeScreenshotIndex === i));
      }
    }

    if (activeScreenshotIndex === null || total === 0) {
      previewStage.hidden = true;
      previewImage.src = "";
      previewImage.alt = "";
      return;
    }

    const activeUrl = currentScreenshots[activeScreenshotIndex]!;
    previewStage.hidden = false;
    previewImage.src = activeUrl;
    previewImage.alt = formatMessage(copy.screenshotAlt, {
      name: currentDisplayName,
      index: String(activeScreenshotIndex + 1),
    });
    previewCounter.textContent = `${activeScreenshotIndex + 1} / ${total}`;
    if (previewPrevButton) previewPrevButton.hidden = total <= 1;
    if (previewNextButton) previewNextButton.hidden = total <= 1;
  };

  const renderScreenshots = (item: DesktopExtensionItem, displayName: string): void => {
    if (!screenshotsSection || !galleryGrid) return;
    const urls = safeScreenshotDataUrls(item);
    currentScreenshots = urls;
    currentDisplayName = displayName;
    if (urls.length === 0) {
      renderedScreenshotsKey = "";
      activeScreenshotIndex = null;
      screenshotsSection.hidden = true;
      galleryGrid.replaceChildren();
      syncPreviewStage();
      return;
    }

    screenshotsSection.hidden = false;
    const signature = `${item.id}\0${urls.join("\0")}`;
    if (signature === renderedScreenshotsKey) {
      syncPreviewStage();
      return;
    }

    renderedScreenshotsKey = signature;
    if (activeScreenshotIndex !== null && activeScreenshotIndex >= urls.length) {
      activeScreenshotIndex = null;
    }

    const thumbs: HTMLElement[] = [];
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i]!;
      const thumbButton = createEl(document, "button", "settings-extensions-detail-modal__thumb");
      thumbButton.type = "button";
      thumbButton.dataset.screenshotIndex = String(i);
      thumbButton.setAttribute("aria-pressed", String(activeScreenshotIndex === i));
      thumbButton.setAttribute(
        "aria-label",
        formatMessage(copy.screenshotPreviewLabel, {
          index: String(i + 1),
          total: String(urls.length),
        }),
      );
      const image = createEl(document, "img");
      image.src = url;
      image.alt = formatMessage(copy.screenshotAlt, {
        name: displayName,
        index: String(i + 1),
      });
      image.loading = "lazy";
      thumbButton.append(image);
      thumbButton.addEventListener("click", () => {
        activeScreenshotIndex = activeScreenshotIndex === i ? null : i;
        syncPreviewStage();
      });
      thumbs.push(thumbButton);
    }
    galleryGrid.replaceChildren(...thumbs);
    syncPreviewStage();
  };

  const renderContent = (
    item: DesktopExtensionItem,
    state: DesktopExtensionDetailModalState,
  ): void => {
    if (
      !dialog ||
      !titleEl ||
      !statusBadge ||
      !metaRow ||
      !modalToggle ||
      !feedbackBar ||
      !attentionBar ||
      !descriptionSection ||
      !techDetails ||
      !techMetaList
    ) {
      return;
    }

    currentItem = item;
    currentMutating = state.mutating;

    const displayName = extensionDisplayName(item, messages.locale);
    dialog.dataset.extensionId = item.id;
    dialog.dataset.extensionState = item.status.state;
    if (state.activeMutationId === item.id) dialog.dataset.busy = "true";
    else delete dialog.dataset.busy;

    titleEl.textContent = displayName;
    statusBadge.textContent = copy.states[item.status.state];
    statusBadge.dataset.state = item.status.state;
    statusBadge.dataset.tone = statusTone(item.status.state);

    // Header metadata: author, version, category chips, GitHub repository link.
    const metaNodes: HTMLElement[] = [];
    if (item.manifest?.author) {
      metaNodes.push(
        createEl(
          document,
          "span",
          "settings-extensions-detail-modal__author",
          formatMessage(copy.authorBy, { author: item.manifest.author }),
        ),
      );
    }
    if (item.manifest?.version) {
      metaNodes.push(
        createEl(
          document,
          "span",
          "settings-extensions-detail-modal__version",
          `v${item.manifest.version}`,
        ),
      );
    }
    if (item.manifest?.categories && item.manifest.categories.length > 0) {
      const categoriesRow = createEl(document, "div", "settings-extensions-categories");
      for (const category of item.manifest.categories) {
        const chip = createEl(
          document,
          "span",
          "settings-extensions-category-chip",
          copy.categories[category] ?? category,
        );
        chip.dataset.category = category;
        categoriesRow.append(chip);
      }
      metaNodes.push(categoriesRow);
    }
    const repositoryHref = parseSafeRepositoryUrl(item.manifest?.repository);
    if (repositoryHref) {
      const repoLink = createEl(document, "a", "settings-extensions-detail-modal__repo");
      repoLink.href = repositoryHref;
      repoLink.target = "_blank";
      repoLink.rel = "noopener noreferrer";
      repoLink.title = repositoryHref;
      repoLink.append(
        createRendererSettingsIcon("github", 13),
        createEl(document, "span", "", copy.githubRepository),
        createRendererSettingsIcon("external-link", 11),
      );
      metaNodes.push(repoLink);
    }
    metaRow.hidden = metaNodes.length === 0;
    metaRow.replaceChildren(...metaNodes);

    // Header toggle switch.
    const blocked = isToggleBlocked(item);
    modalToggle.checked = item.enabled;
    modalToggle.disabled = state.mutating || blocked;
    modalToggle.setAttribute("aria-label", formatMessage(copy.toggleLabel, { name: displayName }));
    modalToggle.title = blocked ? blockedToggleReason(item, copy) : "";

    // Modal-scoped feedback banner (e.g. slot conflict / save result triggered inside modal).
    if (state.feedback) {
      feedbackBar.hidden = false;
      feedbackBar.dataset.tone = state.feedback.tone;
      feedbackBar.setAttribute(
        "role",
        state.feedback.tone === "danger" || state.feedback.tone === "warning" ? "alert" : "status",
      );
      feedbackBar.textContent = state.feedback.text;
    } else {
      feedbackBar.hidden = true;
      feedbackBar.textContent = "";
      delete feedbackBar.dataset.tone;
    }

    // Attention diagnostic banner inside modal body.
    const attention = resolveAttentionDetail(item, state.extensions, messages.locale, copy);
    if (attention) {
      attentionBar.hidden = false;
      attentionBar.dataset.tone = attention.tone;
      attentionBar.replaceChildren(
        createRendererSettingsIcon("alert", 14),
        createEl(document, "span", "", attention.text),
      );
    } else {
      attentionBar.hidden = true;
      attentionBar.replaceChildren();
      delete attentionBar.dataset.tone;
    }

    // Multi-paragraph bilingual details (fallback to description).
    const paragraphs = extensionDetailsParagraphs(item, messages.locale);
    if (paragraphs.length > 0) {
      descriptionSection.hidden = false;
      descriptionSection.replaceChildren(
        ...paragraphs.map((text) =>
          createEl(document, "p", "settings-extensions-detail-modal__paragraph", text),
        ),
      );
    } else {
      descriptionSection.hidden = true;
      descriptionSection.replaceChildren();
    }

    // Screenshots gallery + interactive large preview.
    renderScreenshots(item, displayName);

    // Subtle bottom technical details (ID, declared slots, hash, diagnostics).
    techDetails.open = techExpanded;
    const techRows: HTMLElement[] = [];
    const appendTechRow = (label: string, valueNode: HTMLElement): void => {
      const row = createEl(document, "div", "settings-extensions-card__meta-row");
      row.append(createEl(document, "dt", "", label));
      const dd = createEl(document, "dd");
      dd.append(valueNode);
      row.append(dd);
      techRows.push(row);
    };

    appendTechRow(copy.detailId, createEl(document, "code", "", item.id));

    if (item.manifest) {
      const slotsRow = createEl(document, "div", "settings-extensions-slots");
      if (item.manifest.slots.length === 0) {
        slotsRow.append(
          createEl(
            document,
            "span",
            "settings-status-badge settings-extensions-slot-chip--empty",
            copy.noExclusiveSlots,
          ),
        );
      } else {
        for (const slot of item.manifest.slots) {
          const chip = createEl(
            document,
            "span",
            "settings-status-badge settings-extensions-slot-chip",
            copy.slots[slot] ?? slot,
          );
          chip.dataset.slot = slot;
          chip.title = slot;
          slotsRow.append(chip);
        }
      }
      appendTechRow(copy.detailSlots, slotsRow);
    }

    if (item.status.hash) {
      const hashCode = createEl(document, "code", "", item.status.hash);
      hashCode.title = item.status.hash;
      appendTechRow(copy.detailHash, hashCode);
    }

    if (attention) {
      appendTechRow(copy.detailDiagnostics, createEl(document, "span", "", attention.text));
    }

    techMetaList.replaceChildren(...techRows);
  };

  const cleanup = (): void => {
    signal.removeEventListener("abort", cleanup);
    const previous = dialog;
    dialog = null;
    openExtensionId = null;
    activeScreenshotIndex = null;
    renderedScreenshotsKey = "";
    techExpanded = false;
    currentItem = null;
    currentScreenshots = [];
    currentDisplayName = "";
    titleEl = null;
    statusBadge = null;
    metaRow = null;
    modalToggle = null;
    feedbackBar = null;
    attentionBar = null;
    descriptionSection = null;
    screenshotsSection = null;
    previewStage = null;
    previewImage = null;
    previewCounter = null;
    previewPrevButton = null;
    previewNextButton = null;
    galleryGrid = null;
    techDetails = null;
    techMetaList = null;
    previous?.remove();
    onClose?.();
  };

  const ensureDialog = (): void => {
    if (dialog) return;

    const modal = createEl(
      document,
      "dialog",
      "settings-account-dialog settings-extensions-detail-dialog",
    );
    const titleId = preferenceId("desktop-ext-detail-title");
    const switchId = preferenceId("desktop-ext-detail-switch");
    const alertId = preferenceId("desktop-ext-detail-alert");
    modal.setAttribute("aria-labelledby", titleId);

    const surface = createEl(document, "div", "settings-extensions-detail-modal");

    // Header
    const modalHeader = createEl(document, "div", "settings-extensions-detail-modal__header");
    const headerIdentity = createEl(document, "div", "settings-extensions-detail-modal__identity");
    const titleRow = createEl(document, "div", "settings-extensions-detail-modal__title-row");
    titleEl = createEl(document, "h2", "settings-extensions-detail-modal__title");
    titleEl.id = titleId;
    statusBadge = createEl(document, "span", "settings-extensions-badge");
    titleRow.append(titleEl, statusBadge);

    metaRow = createEl(document, "div", "settings-extensions-detail-modal__meta");
    headerIdentity.append(titleRow, metaRow);

    const headerActions = createEl(document, "div", "settings-extensions-detail-modal__actions");
    modalToggle = createPreferenceSwitch(document, switchId, alertId);
    modalToggle.addEventListener("change", () => {
      if (!currentItem || !modalToggle) return;
      const desired = modalToggle.checked;
      if (currentMutating || isToggleBlocked(currentItem)) {
        modalToggle.checked = currentItem.enabled;
        return;
      }
      onToggle(currentItem, desired);
    });

    const closeButton = createEl(
      document,
      "button",
      "settings-icon-button settings-extensions-detail-modal__close",
    );
    closeButton.type = "button";
    closeButton.title = copy.closeModal;
    closeButton.setAttribute("aria-label", copy.closeModal);
    closeButton.append(createRendererSettingsIcon("close", 16));
    closeButton.addEventListener("click", () => {
      modal.close();
    });

    headerActions.append(modalToggle, closeButton);
    modalHeader.append(headerIdentity, headerActions);

    // Body
    const modalBody = createEl(document, "div", "settings-extensions-detail-modal__body");

    feedbackBar = createEl(
      document,
      "div",
      "settings-extensions__banner settings-extensions-detail-modal__feedback",
    );
    feedbackBar.hidden = true;

    attentionBar = createEl(document, "div", "settings-extensions-detail-modal__alert");
    attentionBar.id = alertId;
    attentionBar.hidden = true;

    descriptionSection = createEl(document, "div", "settings-extensions-detail-modal__description");
    descriptionSection.hidden = true;

    // Screenshots gallery + interactive large preview stage
    screenshotsSection = createEl(
      document,
      "section",
      "settings-extensions-detail-modal__screenshots",
    );
    screenshotsSection.hidden = true;
    const screenshotsHeading = createEl(
      document,
      "h3",
      "settings-extensions-detail-modal__section-title",
      copy.screenshotsTitle,
    );

    previewStage = createEl(document, "div", "settings-extensions-detail-modal__preview");
    previewStage.hidden = true;
    previewImage = createEl(document, "img", "settings-extensions-detail-modal__preview-img");
    const previewBar = createEl(document, "div", "settings-extensions-detail-modal__preview-bar");
    previewCounter = createEl(document, "span", "settings-extensions-detail-modal__preview-count");
    const previewControls = createEl(
      document,
      "div",
      "settings-extensions-detail-modal__preview-controls",
    );
    previewPrevButton = createEl(
      document,
      "button",
      "settings-icon-button settings-extensions-detail-modal__preview-nav",
    );
    previewPrevButton.type = "button";
    previewPrevButton.title = copy.previousScreenshot;
    previewPrevButton.setAttribute("aria-label", copy.previousScreenshot);
    previewPrevButton.append(createRendererSettingsIcon("chevron-left", 14));
    previewPrevButton.addEventListener("click", () => {
      if (activeScreenshotIndex === null || currentScreenshots.length <= 1) return;
      activeScreenshotIndex =
        (activeScreenshotIndex - 1 + currentScreenshots.length) % currentScreenshots.length;
      syncPreviewStage();
    });

    previewNextButton = createEl(
      document,
      "button",
      "settings-icon-button settings-extensions-detail-modal__preview-nav",
    );
    previewNextButton.type = "button";
    previewNextButton.title = copy.nextScreenshot;
    previewNextButton.setAttribute("aria-label", copy.nextScreenshot);
    previewNextButton.append(createRendererSettingsIcon("chevron-right", 14));
    previewNextButton.addEventListener("click", () => {
      if (activeScreenshotIndex === null || currentScreenshots.length <= 1) return;
      activeScreenshotIndex = (activeScreenshotIndex + 1) % currentScreenshots.length;
      syncPreviewStage();
    });

    const closePreviewButton = createEl(
      document,
      "button",
      "settings-extensions-detail-modal__preview-close",
      copy.closePreview,
    );
    closePreviewButton.type = "button";
    closePreviewButton.addEventListener("click", () => {
      activeScreenshotIndex = null;
      syncPreviewStage();
    });

    previewControls.append(previewPrevButton, previewNextButton, closePreviewButton);
    previewBar.append(previewCounter, previewControls);
    previewStage.append(previewImage, previewBar);

    galleryGrid = createEl(document, "div", "settings-extensions-detail-modal__gallery");
    screenshotsSection.append(screenshotsHeading, previewStage, galleryGrid);

    // Subtle bottom collapsible technical details
    techDetails = createEl(document, "details", "settings-extensions-detail-modal__tech");
    const techSummary = createEl(
      document,
      "summary",
      "settings-extensions-detail-modal__tech-summary",
    );
    techSummary.append(
      createEl(document, "span", "", copy.technicalDetails),
      createRendererSettingsIcon("chevron-down", 12),
    );
    techMetaList = createEl(
      document,
      "dl",
      "settings-extensions-card__meta-grid settings-extensions-detail-modal__meta-grid",
    );
    techDetails.append(techSummary, techMetaList);
    techDetails.addEventListener("toggle", () => {
      techExpanded = Boolean(techDetails?.open);
    });

    modalBody.append(
      feedbackBar,
      attentionBar,
      descriptionSection,
      screenshotsSection,
      techDetails,
    );
    surface.append(modalHeader, modalBody);
    modal.append(surface);

    // Dismiss on backdrop click (only when target is the <dialog> backdrop itself).
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.close();
    });

    // Esc closes large screenshot preview first, then closes the detail modal.
    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation?.();
      if (activeScreenshotIndex !== null) {
        activeScreenshotIndex = null;
        syncPreviewStage();
        return;
      }
      modal.close();
    });

    modal.addEventListener("cancel", (event) => {
      if (activeScreenshotIndex !== null) {
        event.preventDefault();
        activeScreenshotIndex = null;
        syncPreviewStage();
      }
    });

    modal.addEventListener("close", cleanup);
    signal.addEventListener("abort", cleanup, { once: true });

    dialog = modal;
    host.append(modal);
    modal.showModal();
  };

  return {
    get extensionId() {
      return openExtensionId;
    },
    get isOpen() {
      return Boolean(dialog?.open);
    },
    open(extensionId, state) {
      if (signal.aborted || state.unavailable) return;
      const item = state.extensions.find((entry) => entry.id === extensionId);
      if (!item) return;
      if (openExtensionId !== extensionId) {
        activeScreenshotIndex = null;
        renderedScreenshotsKey = "";
        techExpanded = false;
      }
      openExtensionId = extensionId;
      ensureDialog();
      renderContent(item, state);
    },
    sync(state) {
      if (!openExtensionId || !dialog) return;
      if (state.unavailable) {
        dialog.close();
        return;
      }
      const item = state.extensions.find((entry) => entry.id === openExtensionId);
      if (!item) {
        dialog.close();
        return;
      }
      renderContent(item, state);
    },
    close() {
      dialog?.close();
    },
    dispose() {
      if (dialog) cleanup();
    },
  };
}
