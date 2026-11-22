import {
  HOST_EXTENSION_ZIP_MAX_BYTES,
  hostExtensionInstallSourceSchema,
  type HostExtensionInstallSource,
} from "@codexhost/shared-contracts";
import {
  arrayBufferToBase64,
  createEl,
  errorMessage,
  formatByteSize,
  formatMessage,
  parseGitHubInstallSource,
} from "./desktop-extensions-shared.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { preferenceId } from "./preference-ui.js";

type ImportMode = "github" | "zip" | "localDir";

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
  readonly onImport: (source: HostExtensionInstallSource) => Promise<void>;
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

    let mode: ImportMode = "github";
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

    const githubTabButton = createEl(document, "button", "settings-extensions-segmented__tab");
    githubTabButton.type = "button";
    githubTabButton.dataset.importMode = "github";
    githubTabButton.setAttribute("role", "tab");
    githubTabButton.append(
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

    const localDirTabButton = createEl(document, "button", "settings-extensions-segmented__tab");
    localDirTabButton.type = "button";
    localDirTabButton.dataset.importMode = "localDir";
    localDirTabButton.setAttribute("role", "tab");
    localDirTabButton.append(
      createRendererSettingsIcon("session-import", 13),
      createEl(document, "span", "", copy.importTabLocalDir),
    );

    modeTabs.append(githubTabButton, zipTabButton, localDirTabButton);

    // Body
    const modalBody = createEl(document, "div", "settings-extensions-import-modal__body");

    // Panel 1: GitHub repository / URL
    const githubPanel = createEl(document, "div", "settings-extensions-import-modal__panel");
    githubPanel.dataset.importPanel = "github";

    const urlField = createEl(document, "div", "settings-extensions-import-modal__field");
    const urlInputId = preferenceId("desktop-ext-import-url");
    const urlLabel = createEl(document, "label", "", copy.importUrlLabel);
    urlLabel.setAttribute("for", urlInputId);
    const urlInput = createEl(document, "input", "settings-extensions-import-modal__input");
    urlInput.id = urlInputId;
    urlInput.type = "text";
    urlInput.placeholder = copy.importUrlPlaceholder;
    urlInput.dataset.importField = "github";
    const urlHint = createEl(document, "small", "", copy.importUrlHint);
    urlField.append(urlLabel, urlInput, urlHint);

    const extraRow1 = createEl(document, "div", "settings-extensions-import-modal__row");
    const refField = createEl(document, "div", "settings-extensions-import-modal__field");
    const refInputId = preferenceId("desktop-ext-import-ref");
    const refLabel = createEl(document, "label", "", copy.importRefLabel);
    refLabel.setAttribute("for", refInputId);
    const refInput = createEl(document, "input", "settings-extensions-import-modal__input");
    refInput.id = refInputId;
    refInput.type = "text";
    refInput.placeholder = copy.importRefPlaceholder;
    refInput.dataset.importField = "ref";
    refField.append(refLabel, refInput);

    const subpathField = createEl(document, "div", "settings-extensions-import-modal__field");
    const subpathInputId = preferenceId("desktop-ext-import-subpath");
    const subpathLabel = createEl(document, "label", "", copy.importSubpathLabel);
    subpathLabel.setAttribute("for", subpathInputId);
    const subpathInput = createEl(document, "input", "settings-extensions-import-modal__input");
    subpathInput.id = subpathInputId;
    subpathInput.type = "text";
    subpathInput.placeholder = copy.importSubpathPlaceholder;
    subpathInput.dataset.importField = "subpath";
    subpathField.append(subpathLabel, subpathInput);
    extraRow1.append(refField, subpathField);

    const extraRow2 = createEl(document, "div", "settings-extensions-import-modal__row");
    const tagField = createEl(document, "div", "settings-extensions-import-modal__field");
    const tagInputId = preferenceId("desktop-ext-import-tag");
    const tagLabel = createEl(document, "label", "", copy.importTagLabel);
    tagLabel.setAttribute("for", tagInputId);
    const tagInput = createEl(document, "input", "settings-extensions-import-modal__input");
    tagInput.id = tagInputId;
    tagInput.type = "text";
    tagInput.placeholder = copy.importTagPlaceholder;
    tagInput.dataset.importField = "tag";
    tagField.append(tagLabel, tagInput);

    const assetField = createEl(document, "div", "settings-extensions-import-modal__field");
    const assetInputId = preferenceId("desktop-ext-import-asset");
    const assetLabel = createEl(document, "label", "", copy.importAssetLabel);
    assetLabel.setAttribute("for", assetInputId);
    const assetInput = createEl(document, "input", "settings-extensions-import-modal__input");
    assetInput.id = assetInputId;
    assetInput.type = "text";
    assetInput.placeholder = copy.importAssetPlaceholder;
    assetInput.dataset.importField = "asset";
    assetField.append(assetLabel, assetInput);
    extraRow2.append(tagField, assetField);

    githubPanel.append(urlField, extraRow1, extraRow2);

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

    // Panel 3: Local directory
    const localDirPanel = createEl(document, "div", "settings-extensions-import-modal__panel");
    localDirPanel.dataset.importPanel = "localDir";
    localDirPanel.hidden = true;

    const localDirField = createEl(document, "div", "settings-extensions-import-modal__field");
    const localDirInputId = preferenceId("desktop-ext-import-local-dir");
    const localDirLabel = createEl(document, "label", "", copy.importLocalDirLabel);
    localDirLabel.setAttribute("for", localDirInputId);
    const localDirInput = createEl(document, "input", "settings-extensions-import-modal__input");
    localDirInput.id = localDirInputId;
    localDirInput.type = "text";
    localDirInput.placeholder = copy.importLocalDirPlaceholder;
    localDirInput.dataset.importField = "localDir";
    const localDirHint = createEl(document, "small", "", copy.importLocalDirHint);
    localDirField.append(localDirLabel, localDirInput, localDirHint);
    localDirPanel.append(localDirField);

    const errorEl = createEl(
      document,
      "p",
      "settings-credential-dialog__error settings-extensions-import-modal__error",
    );
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;

    modalBody.append(modeTabs, githubPanel, zipPanel, localDirPanel, errorEl);

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
      githubTabButton.setAttribute("aria-selected", String(mode === "github"));
      zipTabButton.setAttribute("aria-selected", String(mode === "zip"));
      localDirTabButton.setAttribute("aria-selected", String(mode === "localDir"));
      githubPanel.hidden = mode !== "github";
      zipPanel.hidden = mode !== "zip";
      localDirPanel.hidden = mode !== "localDir";
    };

    const setBusy = (next: boolean): void => {
      busy = next;
      modal.setAttribute("aria-busy", String(next));
      closeButton.disabled = next;
      cancelButton.disabled = next;
      submitButton.disabled = next;
      submitButton.textContent = next ? copy.importSubmitting : copy.importSubmit;
      githubTabButton.disabled = next;
      zipTabButton.disabled = next;
      localDirTabButton.disabled = next;
      urlInput.disabled = next;
      refInput.disabled = next;
      tagInput.disabled = next;
      assetInput.disabled = next;
      subpathInput.disabled = next;
      localDirInput.disabled = next;
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
      if (file.size > HOST_EXTENSION_ZIP_MAX_BYTES) {
        selectedFile = null;
        syncSelectedFile();
        setError(
          formatMessage(copy.installFailed, {
            message: `ZIP exceeds ${formatByteSize(HOST_EXTENSION_ZIP_MAX_BYTES)}`,
          }),
        );
        return;
      }
      selectedFile = file;
      syncSelectedFile();
    };

    const switchMode = (next: ImportMode): void => {
      if (busy || mode === next) return;
      mode = next;
      setError(null);
      syncMode();
    };
    githubTabButton.addEventListener("click", () => switchMode("github"));
    zipTabButton.addEventListener("click", () => switchMode("zip"));
    localDirTabButton.addEventListener("click", () => switchMode("localDir"));

    for (const input of [urlInput, refInput, tagInput, assetInput, subpathInput, localDirInput]) {
      input.addEventListener("input", () => setError(null));
    }

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
        let source: HostExtensionInstallSource;

        if (mode === "github") {
          const rawUrl = urlInput.value.trim();
          if (!rawUrl) {
            setError(copy.importErrorEmptyUrl);
            return;
          }
          const parsedGitHub = parseGitHubInstallSource({
            repoOrUrl: rawUrl,
            ref: refInput.value,
            tag: tagInput.value,
            asset: assetInput.value,
            subpath: subpathInput.value,
          });
          if (!parsedGitHub) {
            setError(copy.importErrorInvalidUrl);
            return;
          }
          source = parsedGitHub;
        } else if (mode === "localDir") {
          const rawDir = localDirInput.value.trim();
          if (!rawDir) {
            setError(copy.importErrorEmptyLocalDir);
            return;
          }
          const parsedDir = hostExtensionInstallSourceSchema.safeParse({
            type: "localDir",
            localDir: rawDir,
          });
          if (!parsedDir.success) {
            setError(copy.importErrorInvalidLocalDir);
            return;
          }
          source = parsedDir.data;
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
            type: "zip",
            base64: arrayBufferToBase64(buffer),
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
