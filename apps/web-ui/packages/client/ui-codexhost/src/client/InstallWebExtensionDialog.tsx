/** Multi-source install dialog: native .zip upload, GitHub Release, and DSH npm/URL/directory. */
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
  IconChevronDownOutlineRegular,
  IconPaperclipOutlineRegular,
  IconShieldOutlineRegular,
  Modal,
  observeComposition,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  webNativeExtensionSourceSchema,
  webUiExtensionRegistrySchema,
} from "@codexhost/shared-contracts";
import { formatByteSize } from "./web-extensions-helpers.ts";
import css from "./InstallWebExtensionDialog.module.css";

type InstallMode = "zip" | "github" | "dsh";
type RegistryChoice = "official" | "mirror" | "custom";

const REGISTRIES = {
  official: "https://registry.npmjs.org/",
  mirror: "https://registry.npmmirror.com/",
} as const;

export type InstallWebExtensionRequest =
  | { readonly format: "codexhost"; readonly kind: "zip"; readonly file: File }
  | {
      readonly format: "codexhost";
      readonly kind: "github";
      readonly repository: string;
      readonly tag?: string | undefined;
      readonly asset: string;
    }
  | { readonly format: "dsh"; readonly spec: string; readonly registry: string };

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

  // Native ZIP state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  // Native GitHub Release state
  const [repository, setRepository] = useState("");
  const [tag, setTag] = useState("");
  const [asset, setAsset] = useState("");

  // DSH state
  const [spec, setSpec] = useState("");
  const [registry, setRegistry] = useState<RegistryChoice>("official");
  const [customRegistry, setCustomRegistry] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);

  // Local validation error
  const [localError, setLocalError] = useState<string | null>(null);

  const formId = useId();
  const guideId = useId();
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
    if (file.size > DESKTOP_EXTENSION_ZIP_MAX_BYTES) {
      setSelectedFile(null);
      setLocalError(
        t("extensions.installDialog.errorZipTooLarge", {
          limit: formatByteSize(DESKTOP_EXTENSION_ZIP_MAX_BYTES),
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
      void onInstall({ format: "codexhost", kind: "zip", file: selectedFile }).then((installed) => {
        if (installed) {
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      });
      return;
    }

    if (mode === "github") {
      const trimmedRepo = repository.trim();
      const trimmedTag = tag.trim();
      const trimmedAsset = asset.trim();
      if (!trimmedRepo) {
        setLocalError(t("extensions.installDialog.errorEmptyRepo"));
        return;
      }
      if (!trimmedAsset) {
        setLocalError(t("extensions.installDialog.errorEmptyAsset"));
        return;
      }
      const parsed = webNativeExtensionSourceSchema.safeParse({
        type: "github",
        repository: trimmedRepo,
        ...(trimmedTag !== "" ? { tag: trimmedTag } : {}),
        asset: trimmedAsset,
      });
      if (!parsed.success || parsed.data.type !== "github") {
        setLocalError(t("extensions.installDialog.errorInvalidGitHub"));
        return;
      }
      void onInstall({
        format: "codexhost",
        kind: "github",
        repository: parsed.data.repository,
        ...(parsed.data.tag !== undefined ? { tag: parsed.data.tag } : {}),
        asset: parsed.data.asset,
      }).then((installed) => {
        if (installed) {
          setRepository("");
          setTag("");
          setAsset("");
        }
      });
      return;
    }

    const source = spec.trim();
    if (source === "") return;
    const parsedRegistry = webUiExtensionRegistrySchema.safeParse(
      registry === "custom" ? customRegistry : REGISTRIES[registry],
    );
    if (!parsedRegistry.success) {
      setLocalError(t("extensions.registryInvalid"));
      return;
    }
    void onInstall({ format: "dsh", spec: source, registry: parsedRegistry.data }).then(
      (installed) => {
        if (installed) setSpec("");
      },
    );
  };

  const displayError = localError ?? error;
  const canSubmit =
    !busy &&
    (mode === "zip"
      ? selectedFile !== null
      : mode === "github"
        ? repository.trim() !== "" && asset.trim() !== ""
        : spec.trim() !== "");

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
            <span>
              {mode === "dsh"
                ? t("extensions.scope")
                : t("extensions.installDialog.nativeTrustWarning")}
            </span>
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
              ["dsh", "extensions.installDialog.tabDsh"],
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
                placeholder="owner/repo"
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
                  placeholder="my-extension-web.zip"
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

        {mode === "dsh" && (
          <div className={css.panel}>
            <div className={css.field}>
              <input
                type="text"
                data-modal-autofocus
                value={spec}
                placeholder={t("extensions.sourcePlaceholder")}
                aria-label={t("extensions.sourceLabel")}
                aria-describedby={displayError === null ? undefined : errorId}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setSpec(event.currentTarget.value);
                  setLocalError(null);
                }}
              />
            </div>

            <div className={css.options}>
              <button
                type="button"
                className={css.guideToggle}
                aria-expanded={guideOpen}
                aria-controls={guideId}
                onClick={() => setGuideOpen(!guideOpen)}
              >
                <IconChevronDownOutlineRegular
                  className={css.chevron}
                  size={14}
                  aria-hidden="true"
                />
                {t("extensions.guide")}
              </button>
              <label className={css.registry}>
                <span>{t("extensions.registry")}</span>
                <select
                  aria-label={t("extensions.registry")}
                  value={registry}
                  disabled={busy}
                  onChange={(event) => {
                    setRegistry(event.currentTarget.value as RegistryChoice);
                    setLocalError(null);
                  }}
                >
                  <option value="official">{t("extensions.registryOfficial")}</option>
                  <option value="mirror">{t("extensions.registryMirror")}</option>
                  <option value="custom">{t("extensions.registryCustom")}</option>
                </select>
              </label>
            </div>

            {registry === "custom" && (
              <label className={css.field}>
                <span>{t("extensions.registryCustomUrl")}</span>
                <input
                  type="text"
                  value={customRegistry}
                  aria-label={t("extensions.registryCustomUrl")}
                  placeholder="https://npm.example.com/"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    setCustomRegistry(event.currentTarget.value);
                    setLocalError(null);
                  }}
                />
              </label>
            )}

            {guideOpen && (
              <div id={guideId} className={css.guide}>
                <p>{t("extensions.guideNpm")}</p>
                <code>dsh-theme-example · @author/theme@1.2.3</code>
                <p>{t("extensions.guideGitHub")}</p>
                <code>https://github.com/owner/plugin</code>
                <p>{t("extensions.guideDirectory")}</p>
                <code>/absolute/path/to/plugin · /absolute/path/to/plugin.tgz</code>
                <p className={css.hint}>{t("extensions.registryHint")}</p>
              </div>
            )}
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
