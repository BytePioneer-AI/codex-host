/** Multi-source install dialog for unified Host extensions: local .zip, GitHub, and local directory. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Button,
  IconPaperclipOutlineRegular,
  IconShieldOutlineRegular,
  Modal,
  observeComposition,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  HOST_EXTENSION_ZIP_MAX_BYTES,
  hostExtensionInstallSourceSchema,
  type HostExtensionInstallSource,
} from "@codexhost/shared-contracts";
import { formatByteSize, parseHostGitHubSource } from "./web-extensions-helpers.ts";
import css from "./InstallWebExtensionDialog.module.css";

type InstallMode = "zip" | "github" | "localDir";

export type InstallWebExtensionRequest =
  | { readonly kind: "zip"; readonly file: File }
  | {
      readonly kind: "github";
      readonly source: Extract<HostExtensionInstallSource, { type: "github" }>;
    }
  | { readonly kind: "localDir"; readonly localDir: string };

type Props = PropsLocale<"codexhostImport"> & {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onInstall: (request: InstallWebExtensionRequest) => Promise<boolean>;
};

export function InstallWebExtensionDialog({
  t,
  open,
  busy,
  error,
  onClose,
  onInstall,
}: Props): ReactNode {
  const [mode, setMode] = useState<InstallMode>("zip");

  // Local ZIP state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  // GitHub state
  const [repository, setRepository] = useState("");
  const [refName, setRefName] = useState("");
  const [tag, setTag] = useState("");
  const [asset, setAsset] = useState("");
  const [subpath, setSubpath] = useState("");

  // Local directory state
  const [localDir, setLocalDir] = useState("");

  // Local validation error
  const [localError, setLocalError] = useState<string | null>(null);

  const formId = useId();
  const errorId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    setDragging(false);
    const guard = observeComposition(document);
    composition.current = guard;
    return () => {
      guard.dispose();
      composition.current = null;
    };
  }, [open]);

  const validateAndSelectFile = (file: File | null): void => {
    setLocalError(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!/\.zip$/iu.test(file.name.trim())) {
      setSelectedFile(null);
      setLocalError(t("extensions.installDialog.errorZipSuffix"));
      return;
    }
    if (file.size <= 0) {
      setSelectedFile(null);
      setLocalError(t("extensions.installDialog.errorZipEmpty"));
      return;
    }
    if (file.size > HOST_EXTENSION_ZIP_MAX_BYTES) {
      setSelectedFile(null);
      setLocalError(
        t("extensions.installDialog.errorZipTooLarge", {
          limit: formatByteSize(HOST_EXTENSION_ZIP_MAX_BYTES),
        }),
      );
      return;
    }
    setSelectedFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const dropped = event.dataTransfer.files[0] ?? null;
    validateAndSelectFile(dropped);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setLocalError(null);

    if (mode === "zip") {
      if (!selectedFile) {
        setLocalError(t("extensions.installDialog.errorNoFile"));
        return;
      }
      void onInstall({ kind: "zip", file: selectedFile }).then((installed) => {
        if (installed) {
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      });
      return;
    }

    if (mode === "github") {
      if (!repository.trim()) {
        setLocalError(t("extensions.installDialog.errorEmptyRepo"));
        return;
      }
      const parsed = parseHostGitHubSource({
        repoOrUrl: repository,
        ref: refName,
        tag,
        asset,
        subpath,
      });
      if (!parsed) {
        setLocalError(t("extensions.installDialog.errorInvalidGitHub"));
        return;
      }
      void onInstall({ kind: "github", source: parsed }).then((installed) => {
        if (installed) {
          setRepository("");
          setRefName("");
          setTag("");
          setAsset("");
          setSubpath("");
        }
      });
      return;
    }

    const trimmedDir = localDir.trim();
    if (!trimmedDir) {
      setLocalError(t("extensions.installDialog.errorEmptyLocalDir"));
      return;
    }
    const parsedDir = hostExtensionInstallSourceSchema.safeParse({
      type: "localDir",
      localDir: trimmedDir,
    });
    if (!parsedDir.success) {
      setLocalError(t("extensions.installDialog.errorInvalidLocalDir"));
      return;
    }
    void onInstall({ kind: "localDir", localDir: trimmedDir }).then((installed) => {
      if (installed) setLocalDir("");
    });
  };

  const displayError = localError ?? error;
  const canSubmit =
    !busy &&
    (mode === "zip"
      ? selectedFile !== null
      : mode === "github"
        ? repository.trim() !== ""
        : localDir.trim() !== "");

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("extensions.add")}
      closeLabel={t("extensions.close")}
      className={css.dialog}
      contentClassName={css.content}
      footer={
        <div className={css.footer}>
          <div className={css.trustBanner}>
            <IconShieldOutlineRegular size={14} className={css.trustIcon} />
            <span>{t("extensions.installDialog.nativeTrustWarning")}</span>
          </div>
          <div className={css.footerActions}>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t("extensions.cancel")}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!canSubmit}
              aria-busy={busy}
            >
              {t(busy ? "extensions.installing" : "extensions.install")}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id={formId}
        className={css.body}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && composition.current?.guards(event.nativeEvent)) {
            event.preventDefault();
          }
        }}
      >
        <div
          className={css.modeTabs}
          role="tablist"
          aria-label={t("extensions.installDialog.modeLabel")}
        >
          {(
            [
              ["zip", "extensions.installDialog.tabZip"],
              ["github", "extensions.installDialog.tabGitHub"],
              ["localDir", "extensions.installDialog.tabLocalDir"],
            ] as const
          ).map(([id, labelKey]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={css.modeTab}
              aria-selected={mode === id}
              disabled={busy}
              onClick={() => {
                setMode(id);
                setLocalError(null);
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {mode === "zip" && (
          <div className={css.panel}>
            <div
              className={css.dropzone}
              data-dragging={dragging ? "true" : undefined}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setDragging(false);
              }}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className={css.hiddenInput}
                disabled={busy}
                onChange={(event) => {
                  const picked = event.currentTarget.files?.[0] ?? null;
                  validateAndSelectFile(picked);
                }}
              />
              <span className={css.dropIcon} aria-hidden="true">
                <IconPaperclipOutlineRegular size={20} />
              </span>
              <p className={css.dropTitle}>{t("extensions.installDialog.zipDropTitle")}</p>
              <p className={css.hint}>{t("extensions.installDialog.zipDropHint")}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("extensions.installDialog.chooseZip")}
              </Button>
            </div>

            {selectedFile !== null && (
              <div className={css.selectedFile}>
                <span className={css.selectedFileName}>
                  {t("extensions.installDialog.zipSelected", {
                    name: selectedFile.name,
                    size: formatByteSize(selectedFile.size),
                  })}
                </span>
                <button
                  type="button"
                  className={css.clearFileButton}
                  disabled={busy}
                  onClick={() => {
                    setSelectedFile(null);
                    setLocalError(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  {t("extensions.installDialog.clearZip")}
                </button>
              </div>
            )}
          </div>
        )}

        {mode === "github" && (
          <div className={css.panel}>
            <label className={css.field}>
              <span>{t("extensions.installDialog.repoLabel")}</span>
              <input
                type="text"
                data-modal-autofocus
                value={repository}
                placeholder="owner/repo or https://github.com/owner/repo"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setRepository(event.currentTarget.value);
                  setLocalError(null);
                }}
              />
            </label>
            <div className={css.fieldRow}>
              <label className={css.field}>
                <span>{t("extensions.installDialog.refLabel")}</span>
                <input
                  type="text"
                  value={refName}
                  placeholder="main"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    setRefName(event.currentTarget.value);
                    setLocalError(null);
                  }}
                />
              </label>
              <label className={css.field}>
                <span>{t("extensions.installDialog.subpathLabel")}</span>
                <input
                  type="text"
                  value={subpath}
                  placeholder="packages/my-plugin"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    setSubpath(event.currentTarget.value);
                    setLocalError(null);
                  }}
                />
              </label>
            </div>
            <div className={css.fieldRow}>
              <label className={css.field}>
                <span>{t("extensions.installDialog.tagLabel")}</span>
                <input
                  type="text"
                  value={tag}
                  placeholder={t("extensions.installDialog.tagPlaceholder")}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    setTag(event.currentTarget.value);
                    setLocalError(null);
                  }}
                />
              </label>
              <label className={css.field}>
                <span>{t("extensions.installDialog.assetLabel")}</span>
                <input
                  type="text"
                  value={asset}
                  placeholder="my-plugin.zip"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    setAsset(event.currentTarget.value);
                    setLocalError(null);
                  }}
                />
              </label>
            </div>
            <p className={css.hint}>{t("extensions.installDialog.githubHint")}</p>
          </div>
        )}

        {mode === "localDir" && (
          <div className={css.panel}>
            <label className={css.field}>
              <span>{t("extensions.installDialog.localDirLabel")}</span>
              <input
                type="text"
                data-modal-autofocus
                value={localDir}
                placeholder="/path/to/my-plugin"
                aria-describedby={displayError === null ? undefined : errorId}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setLocalDir(event.currentTarget.value);
                  setLocalError(null);
                }}
              />
            </label>
            <p className={css.hint}>{t("extensions.installDialog.localDirHint")}</p>
          </div>
        )}

        {displayError !== null && (
          <p id={errorId} className={css.error} role="alert">
            {displayError}
          </p>
        )}
      </form>
    </Modal>
  );
}
