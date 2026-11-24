import {
  resolveLocalizedExtensionText,
  type DesktopExtensionSettingField,
  type HostExtensionCatalogEntry,
  type HostExtensionListItem,
  type HostExtensionSettings,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { createExtensionPlatformBadgeElement } from "./desktop-extensions-card.js";
import { renderSafeMarkdown } from "./desktop-extensions-markdown.js";
import {
  blockedToggleReason,
  catalogCapabilities,
  catalogDescription,
  catalogDisplayName,
  contentLocaleMessages,
  createEl,
  createExtensionIconElement,
  createTrustBadge,
  deriveCapabilityBadges,
  derivePlatformBadge,
  errorMessage,
  extensionDescription,
  extensionDisplayName,
  formatMessage,
  formatPositiveExtensionCount,
  hasCatalogUpdate,
  isToggleBlocked,
  itemCapabilities,
  itemStatusState,
  itemTargets,
  parseSafeRepositoryUrl,
  resolveAttentionDetail,
  resolveExtensionIconCategory,
  resolveInstalledExtensionIconUrl,
  resolveOptionalLocalizedText,
  safeScreenshotUrls,
  statusTone,
  type DesktopExtensionContentLocale,
  type DesktopExtensionFeedback,
  type DesktopExtensionMutationAction,
  type HostExtensionValidItem,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createPreferenceSwitch, preferenceId } from "./preference-ui.js";

export * from "./desktop-extensions-shared.js";

export interface DesktopExtensionDetailModalState {
  readonly extensions: readonly HostExtensionListItem[];
  readonly catalogExtensions: readonly HostExtensionCatalogEntry[];
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

export interface DesktopExtensionDetailSettingsClient {
  getSettings(id: string): Promise<HostExtensionSettings>;
  setSettings(
    id: string,
    expectedSettingsRevision: number,
    values: JsonObject,
  ): Promise<HostExtensionSettings>;
}

function fieldDefaultValue(field: DesktopExtensionSettingField): JsonValue {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "string":
      return "";
    case "number":
      return field.min ?? 0;
    case "range":
      return field.min;
    case "select":
      return field.options[0]?.value ?? "";
  }
}

function coerceFieldValue(
  field: DesktopExtensionSettingField,
  raw: JsonValue | undefined,
): JsonValue {
  switch (field.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : fieldDefaultValue(field);
    case "string":
      return typeof raw === "string" ? raw : fieldDefaultValue(field);
    case "number":
    case "range":
      if (typeof raw === "number" && Number.isFinite(raw)) {
        if (field.min !== undefined && raw < field.min) return field.min;
        if (field.max !== undefined && raw > field.max) return field.max;
        return raw;
      }
      return fieldDefaultValue(field);
    case "select":
      if (typeof raw === "string" && field.options.some((opt) => opt.value === raw)) {
        return raw;
      }
      return fieldDefaultValue(field);
  }
}

function mergeSettingsWithDefaults(
  schema: readonly DesktopExtensionSettingField[],
  stored: JsonObject,
): JsonObject {
  const merged: JsonObject = { ...stored };
  for (const field of schema) {
    merged[field.key] = coerceFieldValue(field, stored[field.key]);
  }
  return merged;
}

function isSettingsConflict(error: unknown): boolean {
  return /revision|conflict|stale/iu.test(errorMessage(error));
}

export function createDesktopExtensionDetailModal(options: {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  readonly messages: RendererSettingsMessages;
  readonly settingsClient?: DesktopExtensionDetailSettingsClient | undefined;
  readonly onSettingsSaved?:
    ((extensionId: string, values: JsonObject, revision: number) => void) | undefined;
  readonly onToggle: (item: HostExtensionListItem, enable: boolean) => void;
  readonly onInstall?: (entry: HostExtensionCatalogEntry, isUpdate: boolean) => void;
  readonly onUninstall?: (item: HostExtensionListItem) => void;
  readonly onOpenPage?: ((item: HostExtensionValidItem) => void) | undefined;
  readonly onOpenSettings?: ((extensionId: string) => void) | undefined;
  readonly onClose?: (() => void) | undefined;
}): DesktopExtensionDetailModalController {
  const {
    document,
    host,
    signal,
    messages,
    settingsClient,
    onSettingsSaved,
    onToggle,
    onInstall,
    onUninstall,
    onOpenPage,
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
  let renderedSettingsKey = "";
  let settingsLoadToken = 0;
  let confirmingUninstall = false;
  let currentItem: HostExtensionListItem | undefined;
  let currentCatalogEntry: HostExtensionCatalogEntry | undefined;
  let currentState: DesktopExtensionDetailModalState | null = null;

  // Persistent DOM nodes inside the open modal so background polls update in-place cleanly.
  let iconSlot: HTMLDivElement | null = null;
  let titleRow: HTMLDivElement | null = null;
  let titleEl: HTMLHeadingElement | null = null;
  let metaRow: HTMLDivElement | null = null;
  let capabilityRow: HTMLDivElement | null = null;
  let actionBar: HTMLDivElement | null = null;
  let modalToggle: HTMLInputElement | null = null;
  let feedbackBar: HTMLDivElement | null = null;
  let attentionBar: HTMLDivElement | null = null;
  let settingsSection: HTMLElement | null = null;
  let descriptionSection: HTMLDivElement | null = null;
  let screenshotsSection: HTMLElement | null = null;
  let galleryGrid: HTMLDivElement | null = null;
  let lightboxDialog: HTMLDialogElement | null = null;
  let lightboxImage: HTMLImageElement | null = null;
  let lightboxCounter: HTMLSpanElement | null = null;
  let lightboxPrevButton: HTMLButtonElement | null = null;
  let lightboxNextButton: HTMLButtonElement | null = null;
  let lightboxReturnFocus: HTMLElement | null = null;
  let currentScreenshots: readonly string[] = [];
  let currentDisplayName = "";

  const syncThumbPressed = (): void => {
    if (!galleryGrid) return;
    const thumbButtons = galleryGrid.children;
    for (let i = 0; i < thumbButtons.length; i += 1) {
      const button = thumbButtons[i];
      if (button && typeof (button as HTMLElement).setAttribute === "function") {
        (button as HTMLElement).setAttribute("aria-pressed", String(activeScreenshotIndex === i));
      }
    }
  };

  const cleanupLightbox = (): void => {
    const previous = lightboxDialog;
    const restore = lightboxReturnFocus;
    lightboxDialog = null;
    lightboxImage = null;
    lightboxCounter = null;
    lightboxPrevButton = null;
    lightboxNextButton = null;
    lightboxReturnFocus = null;
    activeScreenshotIndex = null;
    previous?.remove();
    syncThumbPressed();
    if (restore && restore.isConnected && typeof restore.focus === "function") {
      restore.focus();
    }
  };

  const closeLightbox = (): void => {
    if (!lightboxDialog) {
      activeScreenshotIndex = null;
      syncThumbPressed();
      return;
    }
    if (lightboxDialog.open) {
      lightboxDialog.close();
    } else {
      cleanupLightbox();
    }
  };

  const syncLightbox = (): void => {
    const total = currentScreenshots.length;
    if (
      activeScreenshotIndex === null ||
      total === 0 ||
      activeScreenshotIndex < 0 ||
      activeScreenshotIndex >= total
    ) {
      closeLightbox();
      return;
    }
    const activeUrl = currentScreenshots[activeScreenshotIndex];
    if (!activeUrl) {
      closeLightbox();
      return;
    }

    if (!lightboxDialog) {
      const modal = createEl(document, "dialog", "settings-extensions-lightbox");
      modal.setAttribute("aria-label", copy.screenshotsTitle);
      modal.tabIndex = -1;

      lightboxImage = createEl(document, "img", "settings-extensions-lightbox__img");

      const closeBtn = createEl(
        document,
        "button",
        "settings-extensions-lightbox__btn settings-extensions-lightbox__close",
      );
      closeBtn.type = "button";
      closeBtn.title = copy.closePreview;
      closeBtn.setAttribute("aria-label", copy.closePreview);
      closeBtn.append(createRendererSettingsIcon("close", 16));
      closeBtn.addEventListener("click", () => modal.close());

      lightboxPrevButton = createEl(
        document,
        "button",
        "settings-extensions-lightbox__btn settings-extensions-lightbox__nav settings-extensions-lightbox__nav--prev",
      );
      lightboxPrevButton.type = "button";
      lightboxPrevButton.title = copy.previousScreenshot;
      lightboxPrevButton.setAttribute("aria-label", copy.previousScreenshot);
      lightboxPrevButton.append(createRendererSettingsIcon("chevron-left", 18));
      lightboxPrevButton.addEventListener("click", () => {
        if (activeScreenshotIndex === null || currentScreenshots.length <= 1) return;
        activeScreenshotIndex =
          (activeScreenshotIndex - 1 + currentScreenshots.length) % currentScreenshots.length;
        syncLightbox();
      });

      lightboxNextButton = createEl(
        document,
        "button",
        "settings-extensions-lightbox__btn settings-extensions-lightbox__nav settings-extensions-lightbox__nav--next",
      );
      lightboxNextButton.type = "button";
      lightboxNextButton.title = copy.nextScreenshot;
      lightboxNextButton.setAttribute("aria-label", copy.nextScreenshot);
      lightboxNextButton.append(createRendererSettingsIcon("chevron-right", 18));
      lightboxNextButton.addEventListener("click", () => {
        if (activeScreenshotIndex === null || currentScreenshots.length <= 1) return;
        activeScreenshotIndex = (activeScreenshotIndex + 1) % currentScreenshots.length;
        syncLightbox();
      });

      lightboxCounter = createEl(document, "span", "settings-extensions-lightbox__count");

      modal.append(
        lightboxImage,
        closeBtn,
        lightboxPrevButton,
        lightboxNextButton,
        lightboxCounter,
      );
      modal.addEventListener("click", (event) => {
        if (event.target === modal) modal.close();
      });
      modal.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation?.();
          modal.close();
        } else if (event.key === "ArrowLeft" && currentScreenshots.length > 1) {
          event.preventDefault();
          event.stopPropagation?.();
          activeScreenshotIndex =
            ((activeScreenshotIndex ?? 0) - 1 + currentScreenshots.length) %
            currentScreenshots.length;
          syncLightbox();
        } else if (event.key === "ArrowRight" && currentScreenshots.length > 1) {
          event.preventDefault();
          event.stopPropagation?.();
          activeScreenshotIndex = ((activeScreenshotIndex ?? 0) + 1) % currentScreenshots.length;
          syncLightbox();
        }
      });
      modal.addEventListener("close", cleanupLightbox);

      lightboxDialog = modal;
      host.append(modal);
      modal.showModal();
      modal.focus();
    }

    if (lightboxImage) {
      lightboxImage.src = activeUrl;
      lightboxImage.alt = formatMessage(copy.screenshotAlt, {
        name: currentDisplayName,
        index: String(activeScreenshotIndex + 1),
      });
    }
    const multi = total > 1;
    if (lightboxPrevButton) lightboxPrevButton.hidden = !multi;
    if (lightboxNextButton) lightboxNextButton.hidden = !multi;
    if (lightboxCounter) {
      lightboxCounter.hidden = !multi;
      lightboxCounter.textContent = multi ? `${activeScreenshotIndex + 1} / ${total}` : "";
    }
    syncThumbPressed();
  };

  const renderScreenshots = (
    extensionId: string,
    installed: HostExtensionListItem | undefined,
    catalogEntry: HostExtensionCatalogEntry | undefined,
    displayName: string,
  ): void => {
    if (!screenshotsSection || !galleryGrid) return;
    const urls = safeScreenshotUrls(installed, catalogEntry);
    currentScreenshots = urls;
    currentDisplayName = displayName;
    if (urls.length === 0) {
      renderedScreenshotsKey = "";
      screenshotsSection.hidden = true;
      galleryGrid.replaceChildren();
      closeLightbox();
      return;
    }

    screenshotsSection.hidden = false;
    const signature = `${extensionId}\0${urls.join("\0")}`;
    if (signature === renderedScreenshotsKey) {
      if (activeScreenshotIndex !== null) syncLightbox();
      return;
    }

    renderedScreenshotsKey = signature;
    if (activeScreenshotIndex !== null && activeScreenshotIndex >= urls.length) {
      closeLightbox();
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
        lightboxReturnFocus = thumbButton;
        activeScreenshotIndex = i;
        syncLightbox();
      });
      thumbs.push(thumbButton);
    }
    galleryGrid.replaceChildren(...thumbs);
    if (activeScreenshotIndex !== null) syncLightbox();
  };

  const renderInlineSettings = (
    installed: HostExtensionListItem | undefined,
    contentLocale: DesktopExtensionContentLocale,
  ): void => {
    if (!settingsSection) return;
    const schema = installed?.state === "valid" ? installed.manifest.settingsSchema : undefined;
    if (
      !installed ||
      installed.state !== "valid" ||
      !schema ||
      schema.length === 0 ||
      !settingsClient
    ) {
      renderedSettingsKey = "";
      settingsSection.hidden = true;
      settingsSection.replaceChildren();
      return;
    }

    const key = `${installed.id}\0${installed.digest}\0${contentLocale}\0${JSON.stringify(schema)}`;
    settingsSection.hidden = false;
    if (key === renderedSettingsKey) return;
    renderedSettingsKey = key;

    const token = ++settingsLoadToken;
    const extensionId = installed.id;
    let currentRevision = 0;
    let currentValues: JsonObject = mergeSettingsWithDefaults(schema, {});
    let hydrated = false;
    let pendingValues: JsonObject | null = null;
    let draining = false;

    const head = createEl(document, "div", "settings-extensions-detail-settings__head");
    const headingGroup = createEl(document, "div", "settings-extensions-detail-settings__heading");
    headingGroup.append(
      createEl(
        document,
        "h3",
        "settings-extensions-detail-modal__section-title",
        copy.extensionSettingsTitle,
      ),
    );
    if (!installed.enabled) {
      headingGroup.append(
        createEl(
          document,
          "span",
          "settings-extensions-detail-settings__note",
          copy.extensionSettingsDisabledHint,
        ),
      );
    }

    const headRight = createEl(document, "div", "settings-extensions-detail-settings__head-right");
    const statusEl = createEl(document, "span", "settings-extensions-detail-settings__status");
    statusEl.setAttribute("role", "status");
    statusEl.hidden = true;

    const resetButton = createEl(
      document,
      "button",
      "settings-command-button settings-command-button--secondary",
      copy.extensionSettingsReset,
    );
    resetButton.type = "button";
    resetButton.disabled = true;
    headRight.append(statusEl, resetButton);
    head.append(headingGroup, headRight);

    const noticeEl = createEl(document, "p", "settings-extensions-detail-settings__notice");
    noticeEl.setAttribute("role", "alert");
    noticeEl.hidden = true;

    const listEl = createEl(document, "div", "settings-extensions-detail-settings__list");
    const controls: Array<HTMLInputElement | HTMLSelectElement> = [];
    const syncers = new Map<string, (value: JsonValue) => void>();

    const setStatus = (
      text: string | null,
      tone: "muted" | "success" | "danger" = "muted",
    ): void => {
      if (!text) {
        statusEl.hidden = true;
        statusEl.textContent = "";
        delete statusEl.dataset.tone;
        return;
      }
      statusEl.hidden = false;
      statusEl.dataset.tone = tone;
      statusEl.textContent = text;
    };

    const setNotice = (text: string | null): void => {
      if (!text) {
        noticeEl.hidden = true;
        noticeEl.textContent = "";
        return;
      }
      noticeEl.hidden = false;
      noticeEl.textContent = text;
    };

    const setDisabled = (disabled: boolean): void => {
      resetButton.disabled = disabled;
      for (const control of controls) control.disabled = disabled;
    };

    const applyValues = (next: JsonObject): void => {
      currentValues = mergeSettingsWithDefaults(schema, next);
      for (const field of schema) {
        const val = currentValues[field.key];
        if (val !== undefined) syncers.get(field.key)?.(val);
      }
    };

    const drainWrites = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (pendingValues !== null) {
          const payload = pendingValues;
          pendingValues = null;
          try {
            const saved = await settingsClient.setSettings(extensionId, currentRevision, payload);
            if (token !== settingsLoadToken || signal.aborted) return;
            currentRevision = saved.settingsRevision;
            applyValues(saved.values);
            onSettingsSaved?.(extensionId, saved.values, saved.settingsRevision);
            setNotice(null);
            setStatus(copy.extensionSettingsSaved, "success");
          } catch (cause) {
            if (token !== settingsLoadToken || signal.aborted) return;
            if (isSettingsConflict(cause)) {
              setNotice(copy.extensionSettingsConflict);
              setStatus(null);
              try {
                const reloaded = await settingsClient.getSettings(extensionId);
                if (token !== settingsLoadToken || signal.aborted) return;
                currentRevision = reloaded.settingsRevision;
                applyValues(reloaded.values);
              } catch {
                // Keep conflict message visible.
              }
            } else {
              setStatus(null);
              setNotice(
                formatMessage(copy.extensionSettingsSaveFailed, { message: errorMessage(cause) }),
              );
            }
          }
        }
      } finally {
        draining = false;
      }
    };

    const enqueueWrite = (nextValues: JsonObject): void => {
      if (!hydrated) return;
      currentValues = { ...nextValues };
      pendingValues = { ...nextValues };
      setNotice(null);
      setStatus(copy.extensionSettingsSaving, "muted");
      void drainWrites();
    };

    for (const field of schema) {
      const row = createEl(document, "div", "settings-extensions-detail-settings__row");
      row.dataset.settingKey = field.key;
      const controlId = preferenceId(`host-ext-setting-${extensionId}-${field.key}`);
      const meta = createEl(document, "div", "settings-extensions-detail-settings__meta");
      const labelEl = createEl(
        document,
        "label",
        "settings-extensions-detail-settings__label",
        resolveLocalizedExtensionText(field.label, contentLocale),
      );
      labelEl.id = `${controlId}-label`;
      labelEl.setAttribute("for", controlId);
      meta.append(labelEl);
      if (field.description) {
        meta.append(
          createEl(
            document,
            "p",
            "settings-extensions-detail-settings__desc",
            resolveLocalizedExtensionText(field.description, contentLocale),
          ),
        );
      }

      const controlWrap = createEl(document, "div", "settings-extensions-detail-settings__control");
      if (field.type === "boolean") {
        const toggle = createPreferenceSwitch(document, controlId, labelEl.id);
        toggle.checked = Boolean(currentValues[field.key]);
        toggle.disabled = true;
        toggle.addEventListener("change", () => {
          enqueueWrite({ ...currentValues, [field.key]: toggle.checked });
        });
        syncers.set(field.key, (val) => {
          toggle.checked = Boolean(val);
        });
        controls.push(toggle);
        controlWrap.append(toggle);
      } else if (field.type === "string") {
        const input = createEl(
          document,
          "input",
          "settings-extension-schema__input settings-extension-schema__input--text",
        );
        input.type = "text";
        input.id = controlId;
        if (field.placeholder) {
          input.placeholder = resolveLocalizedExtensionText(field.placeholder, contentLocale);
        }
        input.value = String(currentValues[field.key] ?? "");
        input.disabled = true;
        input.addEventListener("change", () => {
          enqueueWrite({ ...currentValues, [field.key]: input.value });
        });
        syncers.set(field.key, (val) => {
          input.value = String(val ?? "");
        });
        controls.push(input);
        controlWrap.append(input);
      } else if (field.type === "number") {
        const input = createEl(
          document,
          "input",
          "settings-extension-schema__input settings-extension-schema__input--number",
        );
        input.type = "number";
        input.id = controlId;
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        if (field.step !== undefined) input.step = String(field.step);
        input.value = String(currentValues[field.key] ?? "");
        input.disabled = true;
        input.addEventListener("change", () => {
          const parsed = Number(input.value);
          const invalid =
            input.value.trim() === "" ||
            !Number.isFinite(parsed) ||
            (field.min !== undefined && parsed < field.min) ||
            (field.max !== undefined && parsed > field.max);
          if (invalid) {
            input.dataset.invalid = "true";
            return;
          }
          delete input.dataset.invalid;
          enqueueWrite({ ...currentValues, [field.key]: parsed });
        });
        syncers.set(field.key, (val) => {
          delete input.dataset.invalid;
          input.value = String(val ?? "");
        });
        controls.push(input);
        controlWrap.append(input);
      } else if (field.type === "range") {
        const wrap = createEl(document, "div", "settings-extension-schema__range");
        const input = createEl(document, "input", "settings-extension-schema__slider");
        input.type = "range";
        input.id = controlId;
        input.min = String(field.min);
        input.max = String(field.max);
        if (field.step !== undefined) input.step = String(field.step);
        const initVal = Number(currentValues[field.key] ?? field.min);
        input.value = String(initVal);
        input.disabled = true;
        const output = createEl(
          document,
          "output",
          "settings-extension-schema__range-value",
          String(initVal),
        );
        input.addEventListener("input", () => {
          output.textContent = input.value;
        });
        input.addEventListener("change", () => {
          const parsed = Number(input.value);
          output.textContent = input.value;
          if (Number.isFinite(parsed)) enqueueWrite({ ...currentValues, [field.key]: parsed });
        });
        syncers.set(field.key, (val) => {
          const text = String(val ?? field.min);
          input.value = text;
          output.textContent = text;
        });
        controls.push(input);
        wrap.append(input, output);
        controlWrap.append(wrap);
      } else if (field.type === "select") {
        const select = createEl(document, "select", "settings-extension-schema__select");
        select.id = controlId;
        select.disabled = true;
        for (const option of field.options) {
          const opt = document.createElement("option");
          opt.value = option.value;
          opt.textContent = resolveLocalizedExtensionText(option.label, contentLocale);
          select.append(opt);
        }
        select.value = String(currentValues[field.key] ?? "");
        select.addEventListener("change", () => {
          enqueueWrite({ ...currentValues, [field.key]: select.value });
        });
        syncers.set(field.key, (val) => {
          select.value = String(val ?? "");
        });
        controls.push(select);
        controlWrap.append(select);
      }

      row.append(meta, controlWrap);
      listEl.append(row);
    }

    resetButton.addEventListener("click", () => {
      if (!hydrated) return;
      const defaults: JsonObject = { ...currentValues };
      for (const field of schema) {
        defaults[field.key] = fieldDefaultValue(field);
      }
      applyValues(defaults);
      enqueueWrite(defaults);
    });

    settingsSection.replaceChildren(head, noticeEl, listEl);
    setStatus(copy.extensionSettingsLoading, "muted");

    void settingsClient.getSettings(extensionId).then(
      (result) => {
        if (token !== settingsLoadToken || signal.aborted) return;
        hydrated = true;
        currentRevision = result.settingsRevision;
        applyValues(result.values);
        setStatus(null);
        setDisabled(false);
      },
      (cause) => {
        if (token !== settingsLoadToken || signal.aborted) return;
        setStatus(null);
        setNotice(
          formatMessage(copy.extensionSettingsLoadFailed, { message: errorMessage(cause) }),
        );
      },
    );
  };

  const renderActions = (
    extensionId: string,
    displayName: string,
    installed: HostExtensionListItem | undefined,
    catalogEntry: HostExtensionCatalogEntry | undefined,
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

      if (
        onOpenPage &&
        installed.state === "valid" &&
        installed.enabled &&
        installed.manifest.page
      ) {
        const openPageButton = createEl(document, "button", "settings-command-button");
        openPageButton.type = "button";
        openPageButton.dataset.action = "open-page";
        openPageButton.disabled = state.mutating;
        openPageButton.append(
          createRendererSettingsIcon("external-link", 13),
          createEl(document, "span", "", copy.openPage),
        );
        openPageButton.addEventListener("click", () => {
          if (openPageButton.disabled) return;
          dialog?.close();
          onOpenPage(installed);
        });
        nodes.push(openPageButton);
      }

      if (
        onOpenSettings &&
        installed.state === "valid" &&
        installed.enabled &&
        !installed.manifest.page &&
        state.hasSettingsPage?.(extensionId)
      ) {
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
            if (currentState) {
              renderContent(extensionId, currentItem, currentCatalogEntry, currentState);
            }
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
            if (currentState) {
              renderContent(extensionId, currentItem, currentCatalogEntry, currentState);
            }
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
    installed: HostExtensionListItem | undefined,
    catalogEntry: HostExtensionCatalogEntry | undefined,
    state: DesktopExtensionDetailModalState,
  ): void => {
    if (
      !dialog ||
      !iconSlot ||
      !titleRow ||
      !titleEl ||
      !metaRow ||
      !capabilityRow ||
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
    const displayName =
      installed?.state === "valid"
        ? extensionDisplayName(installed, contentLocale)
        : catalogEntry
          ? catalogDisplayName(catalogEntry, contentLocale)
          : extensionId;
    const updateAvailable = hasCatalogUpdate(installed, catalogEntry);

    dialog.dataset.extensionId = extensionId;
    if (installed) {
      dialog.dataset.extensionState = itemStatusState(installed);
    } else {
      delete dialog.dataset.extensionState;
    }
    if (state.activeMutationId === extensionId) dialog.dataset.busy = "true";
    else delete dialog.dataset.busy;

    const categories =
      (installed?.state === "valid" ? installed.manifest.categories : undefined) ??
      catalogEntry?.categories;
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
      const statusState = itemStatusState(installed);
      const statusBadge = createEl(
        document,
        "span",
        "settings-extensions-badge",
        copy.states[statusState],
      );
      statusBadge.dataset.state = statusState;
      statusBadge.dataset.tone = statusTone(statusState);
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

    // Supported platform and capability badges.
    const capabilities =
      installed?.state === "valid"
        ? itemCapabilities(installed)
        : catalogEntry
          ? catalogCapabilities(catalogEntry)
          : null;
    const targets =
      installed?.state === "valid"
        ? itemTargets(installed)
        : catalogEntry
          ? catalogEntry.targets
          : [];
    const platformBadge = derivePlatformBadge(targets, copy);
    const capabilityNodes: HTMLElement[] = [];
    if (platformBadge) {
      const platform = createEl(document, "div", "settings-extensions-detail-modal__platform");
      const row = createEl(document, "div", "settings-extensions-detail-modal__platform-row");
      row.append(
        createEl(document, "span", "", copy.platformLabel),
        createExtensionPlatformBadgeElement(document, platformBadge),
      );
      platform.append(row);
      if (platformBadge.kind === "web") {
        platform.append(
          createEl(
            document,
            "p",
            "settings-extensions-detail-modal__platform-notice",
            copy.platformWebOnlyNotice,
          ),
        );
      }
      capabilityNodes.push(platform);
    }
    for (const badge of deriveCapabilityBadges(capabilities, copy)) {
      const el = createEl(document, "span", "settings-extensions-cap-badge", badge.label);
      el.dataset.capability = badge.kind;
      capabilityNodes.push(el);
    }
    capabilityRow.hidden = capabilityNodes.length === 0;
    capabilityRow.replaceChildren(...capabilityNodes);

    // Header metadata: author, version, category chips, GitHub repository link.
    const metaNodes: HTMLElement[] = [];
    const author =
      (installed?.state === "valid" ? installed.manifest.author : undefined) ??
      catalogEntry?.author;
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

    const installedVersion = installed?.state === "valid" ? installed.manifest.version : undefined;
    const catalogVersion = catalogEntry?.version;
    if (installedVersion) {
      const versionLabel =
        updateAvailable && catalogVersion
          ? `v${installedVersion.replace(/^v/u, "")} → v${catalogVersion.replace(/^v/u, "")}`
          : `v${installedVersion.replace(/^v/u, "")}`;
      metaNodes.push(
        createEl(document, "span", "settings-extensions-detail-modal__version", versionLabel),
      );
    } else if (catalogVersion) {
      metaNodes.push(
        createEl(
          document,
          "span",
          "settings-extensions-detail-modal__version",
          `v${catalogVersion.replace(/^v/u, "")}`,
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
      (installed?.state === "valid" ? installed.manifest.repository : undefined) ??
        catalogEntry?.repository,
    );
    const formattedStars = formatPositiveExtensionCount(catalogEntry?.stars);
    const formattedDownloads = formatPositiveExtensionCount(catalogEntry?.downloads);
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

    // Action bar (Install / Update / Toggle / Open Page / Open Settings / Uninstall).
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

    // Inline declarative settingsSchema form (when available).
    renderInlineSettings(installed, contentLocale);

    // Safe-subset Markdown bilingual details (fallback to description).
    const rawDetails =
      (installed?.state === "valid"
        ? resolveOptionalLocalizedText(installed.manifest.details, contentLocale)
        : null) ??
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
    closeLightbox();
    settingsLoadToken += 1;
    const previous = dialog;
    dialog = null;
    openExtensionId = null;
    activeScreenshotIndex = null;
    renderedIconKey = "";
    renderedScreenshotsKey = "";
    renderedDetailsKey = "";
    renderedSettingsKey = "";
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
    capabilityRow = null;
    actionBar = null;
    modalToggle = null;
    feedbackBar = null;
    attentionBar = null;
    settingsSection = null;
    descriptionSection = null;
    screenshotsSection = null;
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

    capabilityRow = createEl(document, "div", "settings-extensions-detail-modal__capabilities");
    capabilityRow.hidden = true;

    metaRow = createEl(document, "div", "settings-extensions-detail-modal__meta");
    headerIdentity.append(titleRow, capabilityRow, metaRow);
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

    settingsSection = createEl(document, "section", "settings-extensions-detail-settings");
    settingsSection.hidden = true;

    descriptionSection = createEl(document, "div", "settings-extensions-detail-modal__description");
    descriptionSection.hidden = true;

    // Screenshots gallery; clicking a thumbnail opens the floating viewport lightbox.
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

    galleryGrid = createEl(document, "div", "settings-extensions-detail-modal__gallery");
    screenshotsSection.append(screenshotsHeading, galleryGrid);

    modalBody.append(
      feedbackBar,
      attentionBar,
      settingsSection,
      descriptionSection,
      screenshotsSection,
    );
    surface.append(modalHeader, modalBody);
    modal.append(surface);

    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.close();
    });

    modal.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation?.();
      if (activeScreenshotIndex !== null) {
        closeLightbox();
        return;
      }
      modal.close();
    });

    modal.addEventListener("cancel", (event) => {
      if (activeScreenshotIndex !== null) {
        event.preventDefault();
        closeLightbox();
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
    installed: HostExtensionListItem | undefined;
    catalogEntry: HostExtensionCatalogEntry | undefined;
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
        closeLightbox();
        renderedIconKey = "";
        renderedScreenshotsKey = "";
        renderedDetailsKey = "";
        renderedSettingsKey = "";
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
