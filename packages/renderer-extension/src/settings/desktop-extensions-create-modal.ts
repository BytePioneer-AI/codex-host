import type { DesktopExtensionsMessages } from "./desktop-extensions-messages.js";
import { createEl } from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { preferenceId } from "./preference-ui.js";

export const DESKTOP_EXTENSION_SKILL_URL =
  "https://github.com/BytePioneer-AI/codex-host/blob/main/.agents/skills/codexhost-add-desktop-extension/SKILL.md";
export const DESKTOP_EXTENSION_REGISTRY_SUBMIT_URL =
  "https://github.com/BytePioneer-AI/codexhost-extensions-registry/issues/new/choose";

export interface DesktopExtensionCreateModalController {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

export function createDesktopExtensionCreateModal(options: {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  readonly messages: RendererSettingsMessages;
  readonly getCopy?: () => DesktopExtensionsMessages;
}): DesktopExtensionCreateModalController {
  const { document, host, signal, messages, getCopy } = options;

  let dialog: HTMLDialogElement | null = null;
  let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;

  const clearResetTimer = (): void => {
    if (copiedResetTimer !== null) {
      clearTimeout(copiedResetTimer);
      copiedResetTimer = null;
    }
  };

  const cleanup = (): void => {
    clearResetTimer();
    signal.removeEventListener("abort", cleanup);
    const previous = dialog;
    dialog = null;
    previous?.remove();
  };

  const open = (): void => {
    if (signal.aborted || dialog?.open) return;
    const copy = getCopy ? getCopy() : messages.desktopExtensions;

    const modal = createEl(
      document,
      "dialog",
      "settings-account-dialog settings-extensions-create-dialog",
    );
    const titleId = preferenceId("desktop-ext-create-title");
    modal.setAttribute("aria-labelledby", titleId);

    const panel = createEl(document, "div", "settings-extensions-create-modal");

    const modalHeader = createEl(document, "div", "settings-extensions-import-modal__header");
    const headerCopy = createEl(document, "div", "settings-extensions-import-modal__copy");
    const titleEl = createEl(
      document,
      "h2",
      "settings-extensions-import-modal__title",
      copy.createDialogTitle,
    );
    titleEl.id = titleId;
    headerCopy.append(titleEl);

    const closeButton = createEl(
      document,
      "button",
      "settings-icon-button settings-extensions-detail-modal__close",
    );
    closeButton.type = "button";
    closeButton.title = copy.closeModal;
    closeButton.setAttribute("aria-label", copy.closeModal);
    closeButton.append(createRendererSettingsIcon("close", 16));
    modalHeader.append(headerCopy, closeButton);

    const modalBody = createEl(document, "div", "settings-extensions-create-modal__body");

    const stepsList = createEl(document, "ol", "settings-extensions-create-modal__steps");
    for (const stepText of copy.createSteps) {
      stepsList.append(createEl(document, "li", "", stepText));
    }

    const promptField = createEl(document, "div", "settings-extensions-create-modal__field");
    const promptId = preferenceId("desktop-ext-create-prompt");
    const promptLabel = createEl(
      document,
      "label",
      "settings-extensions-create-modal__label",
      copy.createPromptLabel,
    );
    promptLabel.setAttribute("for", promptId);

    const promptTextarea = createEl(
      document,
      "textarea",
      "settings-extensions-create-modal__prompt",
    );
    promptTextarea.id = promptId;
    promptTextarea.rows = 10;
    promptTextarea.spellcheck = false;
    promptTextarea.value = copy.createPromptTemplate;
    promptTextarea.dataset.createField = "prompt";

    const statusLine = createEl(document, "p", "settings-extensions-create-modal__status");
    statusLine.setAttribute("role", "status");
    statusLine.hidden = true;

    promptField.append(promptLabel, promptTextarea, statusLine);
    modalBody.append(stepsList, promptField);

    const modalFooter = createEl(document, "div", "settings-extensions-create-modal__footer");
    const linksGroup = createEl(document, "div", "settings-extensions-create-modal__links");

    const docsLink = createEl(document, "a", "settings-extensions-create-modal__link");
    docsLink.href = DESKTOP_EXTENSION_SKILL_URL;
    docsLink.target = "_blank";
    docsLink.rel = "noopener noreferrer";
    docsLink.dataset.createLink = "skill";
    docsLink.append(
      createEl(document, "span", "", copy.createViewDocs),
      createRendererSettingsIcon("external-link", 12),
    );

    const submitLink = createEl(document, "a", "settings-extensions-create-modal__link");
    submitLink.href = DESKTOP_EXTENSION_REGISTRY_SUBMIT_URL;
    submitLink.target = "_blank";
    submitLink.rel = "noopener noreferrer";
    submitLink.dataset.createLink = "submit";
    submitLink.append(
      createEl(document, "span", "", copy.createSubmitMarketplace),
      createRendererSettingsIcon("external-link", 12),
    );

    linksGroup.append(docsLink, submitLink);

    const copyButton = createEl(
      document,
      "button",
      "settings-command-button settings-command-button--primary",
    );
    copyButton.type = "button";
    copyButton.dataset.action = "copy-create-prompt";
    const copyButtonIconSlot = createEl(document, "span", "settings-extensions-create-modal__icon");
    copyButtonIconSlot.append(createRendererSettingsIcon("copy", 13));
    const copyButtonLabel = createEl(document, "span", "", copy.createCopyPrompt);
    copyButton.append(copyButtonIconSlot, copyButtonLabel);

    modalFooter.append(linksGroup, copyButton);
    panel.append(modalHeader, modalBody, modalFooter);
    modal.append(panel);

    const resetCopyState = (): void => {
      clearResetTimer();
      copyButtonIconSlot.replaceChildren(createRendererSettingsIcon("copy", 13));
      copyButtonLabel.textContent = copy.createCopyPrompt;
    };

    const showStatus = (text: string, tone: "success" | "danger"): void => {
      statusLine.textContent = text;
      statusLine.dataset.tone = tone;
      statusLine.hidden = false;
    };

    const closeModal = (): void => {
      if (modal.open) modal.close();
    };

    closeButton.addEventListener("click", closeModal);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });
    modal.addEventListener("close", () => {
      clearResetTimer();
      if (dialog === modal) dialog = null;
      modal.remove();
    });

    copyButton.addEventListener("click", () => {
      const text = promptTextarea.value;
      const clipboard = document.defaultView?.navigator?.clipboard;
      if (!clipboard) {
        showStatus(copy.createCopyFailed, "danger");
        return;
      }
      void clipboard.writeText(text).then(
        () => {
          if (signal.aborted || dialog !== modal) return;
          copyButtonIconSlot.replaceChildren(createRendererSettingsIcon("check", 13));
          copyButtonLabel.textContent = copy.createPromptCopied;
          showStatus(copy.createPromptCopiedHint, "success");
          clearResetTimer();
          copiedResetTimer = setTimeout(() => {
            if (!signal.aborted && dialog === modal) resetCopyState();
          }, 2_000);
        },
        () => {
          if (signal.aborted || dialog !== modal) return;
          showStatus(copy.createCopyFailed, "danger");
        },
      );
    });

    dialog = modal;
    host.append(modal);
    modal.showModal();
  };

  signal.addEventListener("abort", cleanup, { once: true });

  return {
    get isOpen() {
      return Boolean(dialog?.open);
    },
    open,
    close() {
      if (dialog?.open) dialog.close();
    },
    dispose: cleanup,
  };
}
