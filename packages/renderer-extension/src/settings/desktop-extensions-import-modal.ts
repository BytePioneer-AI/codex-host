import {
  desktopExtensionHttpUrlSchema,
  type DesktopExtensionsInstallParams,
} from "@codexhost/shared-contracts";
import {
  arrayBufferToBase64,
  createEl,
  errorMessage,
  formatByteSize,
  formatMessage,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { preferenceId } from "./preference-ui.js";

type ImportMode = "url" | "zip";

export interface DesktopExtensionImportFileLike {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DesktopExtensionImportModalController {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

export function createDesktopExtensionImportModal(options: {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly signal: AbortSignal;
  readonly messages: RendererSettingsMessages;
  readonly onImport: (source: DesktopExtensionsInstallParams["source"]) => Promise<void>;
}): DesktopExtensionImportModalController {
  const { document, host, signal, messages, onImport } = options;
  const copy = messages.desktopExtensions;

  let dialog: HTMLDialogElement | null = null;

  const cleanup = (): void => {
    signal.removeEventListener("abort", cleanup);
    const previous = dialog;
    dialog = null;
    previous?.remove();
  };

  const open = (): void => {
    if (signal.aborted || dialog?.open) return;

    let mode: ImportMode = "url";
    let busy = false;
    let selectedFile: DesktopExtensionImportFileLike | null = null;

    const modal = createEl(
      document,
      "dialog",
      "settings-account-dialog settings-extensions-import-dialog",
    );
    const titleId = preferenceId("desktop-ext-import-title");
    modal.setAttribute("aria-labelledby", titleId);

    const form = createEl(document, "form", "settings-extensions-import-modal");

    // Header
    const modalHeader = createEl(document, "div", "settings-extensions-import-modal__header");
    const headerCopy = createEl(document, "div", "settings-extensions-import-modal__copy");
    const titleEl = createEl(
      document,
      "h2",
      "settings-extensions-import-modal__title",
      copy.importDialogTitle,
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

    // Mode tabs
    const modeTabs = createEl(document, "div", "settings-extensions-segmented");
    modeTabs.setAttribute("role", "tablist");

    const urlTabButton = createEl(document, "button", "settings-extensions-segmented__tab");
    urlTabButton.type = "button";
    urlTabButton.dataset.importMode = "url";
    urlTabButton.setAttribute("role", "tab");
    urlTabButton.append(
      createRendererSettingsIcon("link", 13),
      createEl(document, "span", "", copy.importTabUrl),
    );

    const zipTabButton = createEl(document, "button", "settings-extensions-segmented__tab");
    zipTabButton.type = "button";
    zipTabButton.dataset.importMode = "zip";
    zipTabButton.setAttribute("role", "tab");
    zipTabButton.append(
      createRendererSettingsIcon("file-archive", 13),
      createEl(document, "span", "", copy.importTabZip),
    );

    modeTabs.append(urlTabButton, zipTabButton);

    // Body
    const modalBody = createEl(document, "div", "settings-extensions-import-modal__body");

    // Panel 1: GitHub URL / Release .zip URL
    const urlPanel = createEl(document, "div", "settings-extensions-import-modal__panel");
    urlPanel.dataset.importPanel = "url";

    const urlField = createEl(document, "div", "settings-extensions-import-modal__field");
    const urlInputId = preferenceId("desktop-ext-import-url");
    const urlLabel = createEl(document, "label", "", copy.importUrlLabel);
    urlLabel.setAttribute("for", urlInputId);
    const urlInput = createEl(document, "input", "settings-extensions-import-modal__input");
    urlInput.id = urlInputId;
    urlInput.type = "url";
    urlInput.placeholder = copy.importUrlPlaceholder;
    urlInput.dataset.importField = "url";
    const urlHint = createEl(document, "small", "", copy.importUrlHint);
    urlField.append(urlLabel, urlInput, urlHint);

    urlPanel.append(urlField);

    // Panel 2: Local .zip upload
    const zipPanel = createEl(document, "div", "settings-extensions-import-modal__panel");
    zipPanel.dataset.importPanel = "zip";
    zipPanel.hidden = true;

    const dropzone = createEl(document, "div", "settings-extensions-dropzone");
    const fileInput = createEl(document, "input", "settings-visually-hidden");
    fileInput.type = "file";
    fileInput.accept = ".zip,application/zip";
    fileInput.dataset.importField = "zip";

    const dropIcon = createEl(document, "div", "settings-extensions-dropzone__icon");
    dropIcon.append(createRendererSettingsIcon("upload", 20));
    const dropTitle = createEl(
      document,
      "p",
      "settings-extensions-dropzone__title",
      copy.importZipDropTitle,
    );
    const chooseFileButton = createEl(
      document,
      "button",
      "settings-command-button settings-command-button--secondary",
      copy.importZipChooseFile,
    );
    chooseFileButton.type = "button";
    chooseFileButton.addEventListener("click", () => {
      if (!busy) fileInput.click?.();
    });

    dropzone.append(dropIcon, dropTitle, chooseFileButton, fileInput);

    const selectedFileBar = createEl(document, "div", "settings-extensions-dropzone__selected");
    selectedFileBar.hidden = true;
    const selectedFileName = createEl(document, "span", "settings-extensions-dropzone__file-name");
    const clearFileButton = createEl(
      document,
      "button",
      "settings-extensions__copy-button",
      copy.importZipClear,
    );
    clearFileButton.type = "button";
    selectedFileBar.append(
      createRendererSettingsIcon("file-archive", 14),
      selectedFileName,
      clearFileButton,
    );

    zipPanel.append(dropzone, selectedFileBar);

    const errorEl = createEl(
      document,
      "p",
      "settings-credential-dialog__error settings-extensions-import-modal__error",
    );
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    modalBody.append(modeTabs, urlPanel, zipPanel, errorEl);

    // Footer actions
    const actions = createEl(document, "div", "settings-extensions-import-modal__actions");
    const cancelButton = createEl(
      document,
      "button",
      "settings-command-button settings-command-button--secondary",
      copy.importCancel,
    );
    cancelButton.type = "button";
    const submitButton = createEl(document, "button", "settings-command-button", copy.importSubmit);
    submitButton.type = "submit";
    submitButton.dataset.action = "submit-import";
    actions.append(cancelButton, submitButton);

    form.append(modalHeader, modalBody, actions);
    modal.append(form);

    const setError = (message: string | null): void => {
      if (!message) {
        errorEl.hidden = true;
        errorEl.textContent = "";
      } else {
        errorEl.hidden = false;
        errorEl.textContent = message;
      }
    };

    const syncSelectedFile = (): void => {
      if (!selectedFile) {
        selectedFileBar.hidden = true;
        selectedFileName.textContent = "";
        return;
      }
      selectedFileBar.hidden = false;
      selectedFileName.textContent = formatMessage(copy.importZipSelected, {
        name: selectedFile.name,
        size: formatByteSize(selectedFile.size),
      });
    };

    const syncMode = (): void => {
      const isUrl = mode === "url";
      urlTabButton.setAttribute("aria-selected", String(isUrl));
      zipTabButton.setAttribute("aria-selected", String(!isUrl));
      urlPanel.hidden = !isUrl;
      zipPanel.hidden = isUrl;
    };

    const setBusy = (next: boolean): void => {
      busy = next;
      modal.setAttribute("aria-busy", String(next));
      closeButton.disabled = next;
      cancelButton.disabled = next;
      submitButton.disabled = next;
      submitButton.textContent = next ? copy.importSubmitting : copy.importSubmit;
      urlTabButton.disabled = next;
      zipTabButton.disabled = next;
      urlInput.disabled = next;
      fileInput.disabled = next;
      chooseFileButton.disabled = next;
      clearFileButton.disabled = next;
    };

    const validateAndSelectFile = (file: DesktopExtensionImportFileLike | null): void => {
      setError(null);
      if (!file) {
        selectedFile = null;
        syncSelectedFile();
        return;
      }
      if (!/\.zip$/iu.test(file.name.trim())) {
        selectedFile = null;
        syncSelectedFile();
        setError(copy.importErrorInvalidExtension);
        return;
      }
      if (file.size <= 0) {
        selectedFile = null;
        syncSelectedFile();
        setError(copy.importErrorEmptyFile);
        return;
      }
      selectedFile = file;
      syncSelectedFile();
    };

    urlTabButton.addEventListener("click", () => {
      if (busy || mode === "url") return;
      mode = "url";
      setError(null);
      syncMode();
    });
    zipTabButton.addEventListener("click", () => {
      if (busy || mode === "zip") return;
      mode = "zip";
      setError(null);
      syncMode();
    });

    urlInput.addEventListener("input", () => setError(null));

    fileInput.addEventListener("change", () => {
      const files = (fileInput as unknown as { files?: ArrayLike<DesktopExtensionImportFileLike> })
        .files;
      const picked = files && files.length > 0 ? (files[0] ?? null) : null;
      validateAndSelectFile(picked);
    });

    clearFileButton.addEventListener("click", () => {
      if (busy) return;
      selectedFile = null;
      fileInput.value = "";
      setError(null);
      syncSelectedFile();
    });

    const onDragState = (active: boolean) => (event: Event) => {
      event.preventDefault();
      if (busy) return;
      if (active) dropzone.dataset.dragging = "true";
      else delete dropzone.dataset.dragging;
    };
    dropzone.addEventListener("dragenter", onDragState(true));
    dropzone.addEventListener("dragover", onDragState(true));
    dropzone.addEventListener("dragleave", onDragState(false));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      delete dropzone.dataset.dragging;
      if (busy) return;
      const transfer = (
        event as Event & {
          dataTransfer?: { files?: ArrayLike<DesktopExtensionImportFileLike> };
        }
      ).dataTransfer;
      const dropped =
        transfer?.files && transfer.files.length > 0 ? (transfer.files[0] ?? null) : null;
      validateAndSelectFile(dropped);
    });

    closeButton.addEventListener("click", () => {
      if (!busy) modal.close();
    });
    cancelButton.addEventListener("click", () => {
      if (!busy) modal.close();
    });
    modal.addEventListener("click", (event) => {
      if (!busy && event.target === modal) modal.close();
    });
    modal.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
    modal.addEventListener("close", cleanup);
    signal.addEventListener("abort", cleanup, { once: true });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      setError(null);

      const submit = async (): Promise<void> => {
        let source: DesktopExtensionsInstallParams["source"];

        if (mode === "url") {
          const rawUrl = urlInput.value.trim();
          if (!rawUrl) {
            setError(copy.importErrorEmptyUrl);
            return;
          }
          const parsedUrl = desktopExtensionHttpUrlSchema.safeParse(rawUrl);
          if (!parsedUrl.success) {
            setError(copy.importErrorInvalidUrl);
            return;
          }
          source = { type: "url", url: parsedUrl.data };
        } else {
          if (!selectedFile) {
            setError(copy.importErrorNoFile);
            return;
          }
          if (!/\.zip$/iu.test(selectedFile.name.trim())) {
            setError(copy.importErrorInvalidExtension);
            return;
          }
          if (selectedFile.size <= 0) {
            setError(copy.importErrorEmptyFile);
            return;
          }
          let buffer: ArrayBuffer;
          try {
            buffer = await selectedFile.arrayBuffer();
          } catch (readError) {
            setError(
              formatMessage(copy.importErrorReadFailed, { message: errorMessage(readError) }),
            );
            return;
          }
          if (buffer.byteLength <= 0) {
            setError(copy.importErrorEmptyFile);
            return;
          }
          source = {
            type: "zip-base64",
            fileName: selectedFile.name.trim(),
            contentBase64: arrayBufferToBase64(buffer),
          };
        }

        setBusy(true);
        try {
          await onImport(source);
          if (!signal.aborted && dialog === modal) {
            setBusy(false);
            modal.close();
          }
        } catch (installError) {
          if (signal.aborted || dialog !== modal) return;
          setBusy(false);
          setError(formatMessage(copy.installFailed, { message: errorMessage(installError) }));
        }
      };

      void submit();
    });

    syncMode();
    dialog = modal;
    host.append(modal);
    modal.showModal();
  };

  return {
    get isOpen() {
      return Boolean(dialog?.open);
    },
    open,
    close() {
      dialog?.close();
    },
    dispose() {
      if (dialog) cleanup();
    },
  };
}
