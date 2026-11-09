/** Install form adapted from DSH ui-plugin-manager's PluginManagerPage (MIT). */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  IconChevronDownOutlineRegular,
  Modal,
  observeComposition,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { webUiExtensionRegistrySchema } from "@codexhost/shared-contracts";
import css from "./InstallWebExtensionDialog.module.css";

type RegistryChoice = "official" | "mirror" | "custom";
const REGISTRIES = {
  official: "https://registry.npmjs.org/",
  mirror: "https://registry.npmmirror.com/",
};

type Props = PropsLocale<"codexhostImport"> & {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onInstall: (spec: string, registry: string) => Promise<boolean>;
};

export function InstallWebExtensionDialog({
  t,
  open,
  busy,
  error,
  onClose,
  onInstall,
}: Props): ReactNode {
  const [spec, setSpec] = useState("");
  const [registry, setRegistry] = useState<RegistryChoice>("official");
  const [customRegistry, setCustomRegistry] = useState("");
  const [registryError, setRegistryError] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const formId = useId();
  const guideId = useId();
  const errorId = useId();
  const registryErrorId = useId();
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null);

  useEffect(() => {
    if (!open) return;
    const guard = observeComposition(document);
    composition.current = guard;
    return () => {
      guard.dispose();
      composition.current = null;
    };
  }, [open]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const source = spec.trim();
    if (busy || source === "") return;
    const parsed = webUiExtensionRegistrySchema.safeParse(
      registry === "custom" ? customRegistry : REGISTRIES[registry],
    );
    setRegistryError(!parsed.success);
    if (!parsed.success) return;
    void onInstall(source, parsed.data).then((installed) => {
      if (installed) setSpec("");
    });
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("extensions.add")}
      closeLabel={t("extensions.close")}
      description={t("extensions.sourceHint")}
      className={css.dialog}
      contentClassName={css.content}
      footer={
        <div className={css.footer}>
          <p className={css.scope}>{t("extensions.scope")}</p>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            className={css.wide}
            disabled={busy || spec.trim() === ""}
            aria-busy={busy}
          >
            {t(busy ? "extensions.installing" : "extensions.install")}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        className={css.body}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && composition.current?.guards(event.nativeEvent))
            event.preventDefault();
        }}
      >
        <div className={css.field}>
          <input
            type="text"
            data-modal-autofocus
            value={spec}
            placeholder={t("extensions.sourcePlaceholder")}
            aria-label={t("extensions.sourceLabel")}
            aria-describedby={error === null ? undefined : errorId}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setSpec(event.currentTarget.value)}
          />
        </div>
        {error !== null && (
          <p id={errorId} className={css.error} role="alert">
            {error}
          </p>
        )}
        <div className={css.options}>
          <button
            type="button"
            className={css.guideToggle}
            aria-expanded={guideOpen}
            aria-controls={guideId}
            onClick={() => setGuideOpen(!guideOpen)}
          >
            <IconChevronDownOutlineRegular className={css.chevron} size={14} aria-hidden="true" />
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
                setRegistryError(false);
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
              aria-invalid={registryError}
              aria-describedby={registryError ? registryErrorId : undefined}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              onChange={(event) => {
                setCustomRegistry(event.currentTarget.value);
                setRegistryError(false);
              }}
            />
            {registryError && (
              <span id={registryErrorId} className={css.error} role="alert">
                {t("extensions.registryInvalid")}
              </span>
            )}
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
      </form>
    </Modal>
  );
}
