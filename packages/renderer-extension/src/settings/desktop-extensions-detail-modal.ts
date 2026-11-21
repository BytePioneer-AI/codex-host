import type { DesktopExtensionCatalogEntry } from "@codexhost/shared-contracts";
import { renderSafeMarkdown } from "./desktop-extensions-markdown.js";
import {
  blockedToggleReason,
  catalogDescription,
  catalogDisplayName,
  contentLocaleMessages,
  createEl,
  createExtensionIconElement,
  createTrustBadge,
  extensionDescription,
  extensionDisplayName,
  formatExtensionCount,
  formatMessage,
  hasCatalogUpdate,
  isToggleBlocked,
  isValidExtensionCount,
  parseSafeRepositoryUrl,
  resolveAttentionDetail,
  resolveExtensionIconCategory,
  resolveInstalledExtensionIconUrl,
  resolveOptionalLocalizedText,
  safeScreenshotUrls,
  statusTone,
  type DesktopExtensionContentLocale,
  type DesktopExtensionFeedback,
  type DesktopExtensionItem,
  type DesktopExtensionMutationAction,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

export * from "./desktop-extensions-shared.js";

export interface DesktopExtensionDetailModalState {
  readonly extensions: readonly DesktopExtensionItem[];
  readonly catalogExtensions: readonly DesktopExtensionCatalogEntry[];
  readonly contentLocale?: DesktopExtensionContentLocale | undefined;
  readonly hasSettingsPage?: ((extensionId: string) => boolean) | undefined;
  readonly unavailable: boolean;
  readonly canInstall: boolean;
  readonly canUninstall: boolean;
  readonly mutating: boolean;
  readonly activeMutationId: string | null;
  readonly activeMutationAction: DesktopExtensionMutationAction | null;
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
  readonly onInstall?: (entry: DesktopExtensionCatalogEntry, isUpdate: boolean) => void;
  readonly onUninstall?: (item: DesktopExtensionItem) => void;
  readonly onOpenSettings?: ((extensionId: string) => void) | undefined;
  readonly onClose?: (() => void) | undefined;
}): DesktopExtensionDetailModalController {
  const {
    document,
    host,
    signal,
    messages,
    onToggle,
    onInstall,
    onUninstall,
    onOpenSettings,
    onClose,
  } = options;
  const copy = messages.desktopExtensions;

  let dialog: HTMLDialogElement | null = null;
  let openExtensionId: string | null = null;
  let activeScreenshotIndex: number | null = null;
  let renderedIconKey = "";
  let renderedScreenshotsKey = "";
  let renderedDetailsKey = "";
  let confirmingUninstall = false;
  let currentItem: DesktopExtensionItem | undefined;
  let currentCatalogEntry: DesktopExtensionCatalogEntry | undefined;
  let currentState: DesktopExtensionDetailModalState | null = null;

  // Persistent DOM nodes inside the open modal so background polls update in-place cleanly.
  let iconSlot: HTMLDivElement | null = null;
  let titleRow: HTMLDivElement | null = null;
  let titleEl: HTMLHeadingElement | null = null;
  let metaRow: HTMLDivElement | null = null;
  let actionBar: HTMLDivElement | null = null;
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

    const activeUrl = currentScreenshots[activeScreenshotIndex];
    if (!activeUrl) {
      previewStage.hidden = true;
      previewImage.src = "";
      previewImage.alt = "";
      return;
    }
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

  const renderScreenshots = (
    extensionId: string,
    installed: DesktopExtensionItem | undefined,
    catalogEntry: DesktopExtensionCatalogEntry | undefined,
    displayName: string,
  ): void => {
    if (!screenshotsSection || !galleryGrid) return;
    const urls = safeScreenshotUrls(installed, catalogEntry);
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
    const signature = `${extensionId}\0${urls.join("\0")}`;
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
      const url = urls[i];
      if (!url) continue;
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

  const renderActions = (
    extensionId: string,
    displayName: string,
    installed: DesktopExtensionItem | undefined,
    catalogEntry: DesktopExtensionCatalogEntry | undefined,
    state: DesktopExtensionDetailModalState,
  ): void => {
    if (!actionBar || !modalToggle) return;
    const updateAvailable = hasCatalogUpdate(installed, catalogEntry);
    const isBusyThis = state.activeMutationId === extensionId;
    const nodes: HTMLElement[] = [];

    if (!installed && catalogEntry) {
      const installButton = createEl(
        document,
        "button",
        "settings-command-button",
        isBusyThis && state.activeMutationAction === "install" ? copy.installing : copy.install,
      );
      installButton.type = "button";
      installButton.dataset.action = "install";
      installButton.disabled = state.mutating || !state.canInstall;
      installButton.addEventListener("click", () => {
        if (!installButton.disabled) onInstall?.(catalogEntry, false);
      });
      nodes.push(installButton);

      if (catalogEntry.trustTier === "community") {
        const note = createEl(
          document,
          "span",
          "settings-extensions-detail-modal__community-note",
          copy.communityNotice,
        );
        nodes.push(note);
      }
    } else if (installed) {
      if (catalogEntry && updateAvailable) {
        const updateButton = createEl(
          document,
          "button",
          "settings-command-button",
          isBusyThis && state.activeMutationAction === "update"
            ? copy.updating
            : formatMessage(copy.updateToVersion, { version: catalogEntry.version }),
        );
        updateButton.type = "button";
        updateButton.dataset.action = "update";
        updateButton.disabled = state.mutating || !state.canInstall;
        updateButton.addEventListener("click", () => {
          if (!updateButton.disabled) onInstall?.(catalogEntry, true);
        });
        nodes.push(updateButton);
      }

      const blocked = isToggleBlocked(installed);
      modalToggle.checked = installed.enabled;
      modalToggle.disabled = state.mutating || blocked;
      modalToggle.setAttribute(
        "aria-label",
        formatMessage(copy.toggleLabel, { name: displayName }),
      );
      modalToggle.title = blocked ? blockedToggleReason(installed, copy) : "";
      nodes.push(modalToggle);

      if (onOpenSettings && state.hasSettingsPage?.(extensionId)) {
        const openSettingsButton = createEl(
          document,
          "button",
          "settings-command-button settings-command-button--secondary",
        );
        openSettingsButton.type = "button";
        openSettingsButton.dataset.action = "open-settings";
        openSettingsButton.disabled = state.mutating;
        openSettingsButton.append(
          createRendererSettingsIcon("settings", 13),
          createEl(document, "span", "", copy.openExtensionSettings),
        );
        openSettingsButton.addEventListener("click", () => {
          if (openSettingsButton.disabled) return;
          dialog?.close();
          onOpenSettings(extensionId);
        });
        nodes.push(openSettingsButton);
      }

      if (state.canUninstall) {
        if (confirmingUninstall) {
          const confirmGroup = createEl(
            document,
            "div",
            "settings-extensions-detail-modal__confirm",
          );
          const prompt = createEl(
            document,
            "span",
            "settings-extensions-detail-modal__confirm-text",
            copy.uninstallConfirmPrompt,
          );
          const confirmButton = createEl(
            document,
            "button",
            "settings-command-button settings-command-button--secondary settings-command-button--danger",
            isBusyThis && state.activeMutationAction === "uninstall"
              ? copy.uninstalling
              : copy.uninstallConfirm,
          );
          confirmButton.type = "button";
          confirmButton.dataset.action = "confirm-uninstall";
          confirmButton.disabled = state.mutating;
          confirmButton.addEventListener("click", () => {
            if (!confirmButton.disabled) onUninstall?.(installed);
          });

          const cancelButton = createEl(
            document,
            "button",
            "settings-command-button settings-command-button--secondary",
            copy.uninstallCancel,
          );
          cancelButton.type = "button";
          cancelButton.dataset.action = "cancel-uninstall";
          cancelButton.disabled = state.mutating;
          cancelButton.addEventListener("click", () => {
            if (state.mutating) return;
            confirmingUninstall = false;
            if (currentState)
              renderContent(extensionId, currentItem, currentCatalogEntry, currentState);
          });

          confirmGroup.append(prompt, confirmButton, cancelButton);
          nodes.push(confirmGroup);
        } else {
          const uninstallButton = createEl(
            document,
            "button",
            "settings-command-button settings-command-button--secondary settings-command-button--danger",
          );
          uninstallButton.type = "button";
          uninstallButton.dataset.action = "uninstall";
          uninstallButton.disabled = state.mutating;
          uninstallButton.append(
            createRendererSettingsIcon("trash", 13),
            createEl(document, "span", "", copy.uninstall),
          );
          uninstallButton.addEventListener("click", () => {
            if (state.mutating) return;
            confirmingUninstall = true;
            if (currentState)
              renderContent(extensionId, currentItem, currentCatalogEntry, currentState);
          });
          nodes.push(uninstallButton);
        }
      }
    }

    actionBar.hidden = nodes.length === 0;
    actionBar.replaceChildren(...nodes);
  };

  const renderContent = (
    extensionId: string,
    installed: DesktopExtensionItem | undefined,
    catalogEntry: DesktopExtensionCatalogEntry | undefined,
    state: DesktopExtensionDetailModalState,
  ): void => {
    if (
      !dialog ||
      !iconSlot ||
      !titleRow ||
      !titleEl ||
      !metaRow ||
      !actionBar ||
      !modalToggle ||
      !feedbackBar ||
      !attentionBar ||
      !descriptionSection
    ) {
      return;
    }

    currentItem = installed;
    currentCatalogEntry = catalogEntry;
    currentState = state;
    if (!installed) {
      confirmingUninstall = false;
    }

    const contentLocale = state.contentLocale ?? messages.locale;
    const contentCopy = contentLocaleMessages(contentLocale);
    const displayName = installed?.manifest
      ? extensionDisplayName(installed, contentLocale)
      : catalogEntry
        ? catalogDisplayName(catalogEntry, contentLocale)
        : extensionId;
    const updateAvailable = hasCatalogUpdate(installed, catalogEntry);

    dialog.dataset.extensionId = extensionId;
    if (installed) {
      dialog.dataset.extensionState = installed.status.state;
    } else {
      delete dialog.dataset.extensionState;
    }
    if (state.activeMutationId === extensionId) dialog.dataset.busy = "true";
    else delete dialog.dataset.busy;

    const categories = installed?.manifest?.categories ?? catalogEntry?.categories;
    const iconUrl = resolveInstalledExtensionIconUrl(installed, catalogEntry);
    const primaryIconCategory = resolveExtensionIconCategory(categories);
    const iconKey = `${extensionId}\0${iconUrl ?? ""}\0${primaryIconCategory}`;
    if (iconKey !== renderedIconKey) {
      renderedIconKey = iconKey;
      iconSlot.replaceChildren(
        createExtensionIconElement({
          document,
          iconUrl,
          categories,
          size: "detail",
          alt: displayName,
        }),
      );
    }

    // Title row: bilingual title + trust tier badge + installed status badge + update chip.
    titleEl.textContent = displayName;
    const titleNodes: HTMLElement[] = [titleEl];
    if (catalogEntry) {
      titleNodes.push(createTrustBadge(document, catalogEntry.trustTier, copy));
    }
    if (installed) {
      const statusBadge = createEl(
        document,
        "span",
        "settings-extensions-badge",
        copy.states[installed.status.state],
      );
      statusBadge.dataset.state = installed.status.state;
      statusBadge.dataset.tone = statusTone(installed.status.state);
      titleNodes.push(statusBadge);
    }
    if (updateAvailable) {
      const updateBadge = createEl(
        document,
        "span",
        "settings-extensions-update-chip",
        copy.updateAvailable,
      );
      titleNodes.push(updateBadge);
    }
    titleRow.replaceChildren(...titleNodes);

    // Header metadata: author, version, category chips, GitHub repository link.
    const metaNodes: HTMLElement[] = [];
    const author = installed?.manifest?.author ?? catalogEntry?.author;
    if (author) {
      metaNodes.push(
        createEl(
          document,
          "span",
          "settings-extensions-detail-modal__author",
          formatMessage(copy.authorBy, { author }),
        ),
      );
    }

    const installedVersion = installed?.manifest?.version;
    const catalogVersion = catalogEntry?.version;
    if (installedVersion) {
      const versionLabel =
        updateAvailable && catalogVersion
          ? `v${installedVersion} → v${catalogVersion}`
          : `v${installedVersion}`;
      metaNodes.push(
        createEl(document, "span", "settings-extensions-detail-modal__version", versionLabel),
      );
    } else if (catalogVersion) {
      metaNodes.push(
        createEl(
          document,
          "span",
          "settings-extensions-detail-modal__version",
          `v${catalogVersion}`,
        ),
      );
    }

    if (categories && categories.length > 0) {
      const categoriesRow = createEl(document, "div", "settings-extensions-categories");
      for (const category of categories) {
        const chip = createEl(
          document,
          "span",
          "settings-extensions-category-chip",
          contentCopy.categories[category] ?? category,
        );
        chip.dataset.category = category;
        categoriesRow.append(chip);
      }
      metaNodes.push(categoriesRow);
    }

    const repositoryHref = parseSafeRepositoryUrl(
      installed?.manifest?.repository ?? catalogEntry?.repository,
    );
    const formattedStars = isValidExtensionCount(catalogEntry?.stars)
      ? formatExtensionCount(catalogEntry.stars)
      : null;
    const formattedDownloads = isValidExtensionCount(catalogEntry?.downloads)
      ? formatExtensionCount(catalogEntry.downloads)
      : null;
    if (repositoryHref) {
      const repoLink = createEl(document, "a", "settings-extensions-detail-modal__repo");
      repoLink.href = repositoryHref;
      repoLink.target = "_blank";
      repoLink.rel = "noopener noreferrer";
      repoLink.title = repositoryHref;
      repoLink.append(
        createRendererSettingsIcon("github", 13),
        createEl(document, "span", "", copy.githubRepository),
      );
      if (formattedStars) {
        const repoStars = createEl(
          document,
          "span",
          "settings-extensions-detail-modal__repo-stars",
        );
        repoStars.append(
          createEl(document, "span", "settings-extensions-detail-modal__repo-dot", "·"),
          createRendererSettingsIcon("star", 11),
          createEl(document, "span", "", formattedStars),
        );
        repoLink.append(repoStars);
      }
      repoLink.append(createRendererSettingsIcon("external-link", 11));
      metaNodes.push(repoLink);
    }
    if (formattedDownloads) {
      const downloadsEl = createEl(document, "span", "settings-extensions-detail-modal__downloads");
      downloadsEl.dataset.metric = "downloads";
      const downloadsLabel = formatMessage(copy.downloadsLabel, { count: formattedDownloads });
      downloadsEl.title = downloadsLabel;
      downloadsEl.setAttribute("aria-label", downloadsLabel);
      downloadsEl.append(
        createRendererSettingsIcon("download", 12),
        createEl(document, "span", "", formattedDownloads),
      );
      metaNodes.push(downloadsEl);
    }
    metaRow.hidden = metaNodes.length === 0;
    metaRow.replaceChildren(...metaNodes);

    // Action bar (Install / Update / Toggle / Uninstall with inline confirmation).
    renderActions(extensionId, displayName, installed, catalogEntry, state);

    // Modal-scoped feedback banner.
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
    const attention = installed
      ? resolveAttentionDetail(installed, state.extensions, messages.locale, copy)
      : null;
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

    // Safe-subset Markdown bilingual details (fallback to description).
    // Skip DOM rebuild across polling ticks when raw content has not changed.
    const rawDetails =
      resolveOptionalLocalizedText(installed?.manifest?.details, contentLocale) ??
      resolveOptionalLocalizedText(catalogEntry?.details, contentLocale) ??
      (installed ? extensionDescription(installed, contentLocale) : null) ??
      (catalogEntry ? catalogDescription(catalogEntry, contentLocale) : null);
    const detailsKey = `${extensionId}\0${contentLocale}\0${rawDetails ?? ""}`;
    if (detailsKey !== renderedDetailsKey) {
      renderedDetailsKey = detailsKey;
      const blocks = renderSafeMarkdown(document, rawDetails);
      if (blocks.length > 0) {
        descriptionSection.hidden = false;
        descriptionSection.replaceChildren(...blocks);
      } else {
        descriptionSection.hidden = true;
        descriptionSection.replaceChildren();
      }
    }

    // Screenshots gallery + interactive large preview.
    renderScreenshots(extensionId, installed, catalogEntry, displayName);
  };

  const cleanup = (): void => {
    signal.removeEventListener("abort", cleanup);
    const previous = dialog;
    dialog = null;
    openExtensionId = null;
    activeScreenshotIndex = null;
    renderedIconKey = "";
    renderedScreenshotsKey = "";
    renderedDetailsKey = "";
    confirmingUninstall = false;
    currentItem = undefined;
    currentCatalogEntry = undefined;
    currentState = null;
    currentScreenshots = [];
    currentDisplayName = "";
    iconSlot = null;
    titleRow = null;
    titleEl = null;
    metaRow = null;
    actionBar = null;
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
    const headerTop = createEl(document, "div", "settings-extensions-detail-modal__header-top");
    const headerHero = createEl(document, "div", "settings-extensions-detail-modal__hero");
    iconSlot = createEl(document, "div", "settings-extensions-detail-modal__icon-slot");
    const headerIdentity = createEl(document, "div", "settings-extensions-detail-modal__identity");
    titleRow = createEl(document, "div", "settings-extensions-detail-modal__title-row");
    titleEl = createEl(document, "h2", "settings-extensions-detail-modal__title");
    titleEl.id = titleId;
    titleRow.append(titleEl);

    metaRow = createEl(document, "div", "settings-extensions-detail-modal__meta");
    headerIdentity.append(titleRow, metaRow);
    headerHero.append(iconSlot, headerIdentity);

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

    headerTop.append(headerHero, closeButton);

    actionBar = createEl(document, "div", "settings-extensions-detail-modal__action-bar");
    modalToggle = createPreferenceSwitch(document, switchId, alertId);
    modalToggle.addEventListener("change", () => {
      if (!currentItem || !modalToggle) return;
      const desired = modalToggle.checked;
      if (currentState?.mutating || isToggleBlocked(currentItem)) {
        modalToggle.checked = currentItem.enabled;
        return;
      }
      onToggle(currentItem, desired);
    });

    modalHeader.append(headerTop, actionBar);

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

    modalBody.append(feedbackBar, attentionBar, descriptionSection, screenshotsSection);
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

  const resolveEntries = (
    extensionId: string,
    state: DesktopExtensionDetailModalState,
  ): {
    installed: DesktopExtensionItem | undefined;
    catalogEntry: DesktopExtensionCatalogEntry | undefined;
  } => ({
    installed: state.extensions.find((entry) => entry.id === extensionId),
    catalogEntry: state.catalogExtensions.find((entry) => entry.id === extensionId),
  });

  return {
    get extensionId() {
      return openExtensionId;
    },
    get isOpen() {
      return Boolean(dialog?.open);
    },
    open(extensionId, state) {
      if (signal.aborted || state.unavailable) return;
      const { installed, catalogEntry } = resolveEntries(extensionId, state);
      if (!installed && !catalogEntry) return;
      if (openExtensionId !== extensionId) {
        activeScreenshotIndex = null;
        renderedIconKey = "";
        renderedScreenshotsKey = "";
        renderedDetailsKey = "";
        confirmingUninstall = false;
      }
      openExtensionId = extensionId;
      ensureDialog();
      renderContent(extensionId, installed, catalogEntry, state);
    },
    sync(state) {
      if (!openExtensionId || !dialog) return;
      if (state.unavailable) {
        dialog.close();
        return;
      }
      const { installed, catalogEntry } = resolveEntries(openExtensionId, state);
      if (!installed && !catalogEntry) {
        dialog.close();
        return;
      }
      renderContent(openExtensionId, installed, catalogEntry, state);
    },
    close() {
      dialog?.close();
    },
    dispose() {
      if (dialog) cleanup();
    },
  };
}
