/** Web settings for installing and managing interface extensions on this computer. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconInfoOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  Switch,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webLocalAccessRequiredDetailsSchema,
  type WebUiExtension,
  type WebUiExtensionMeta,
  type WebUiExtensionsState,
} from "@codexhost/shared-contracts";
import { ApiError } from "./api.ts";
import { uiExtensionsApi } from "./ui-extensions-api.ts";
import { formatWebExtensionError } from "./web-extension-errors.ts";
import { InstallWebExtensionDialog } from "./InstallWebExtensionDialog.tsx";
import { ExtensionProjectLink } from "./ExtensionProjectLink.tsx";
import { ExtensionArtwork } from "./ExtensionArtwork.tsx";
import css from "./WebExtensionsSection.module.css";

type View =
  | { kind: "loading" }
  | { kind: "ready"; data: WebUiExtensionsState }
  | { kind: "non-local"; url: string }
  | { kind: "failed"; message: string };

export interface WebExtensionsFace {
  resolveText: (text: NonNullable<WebUiExtensionMeta["title"]>) => string;
}

function extensionText(extension: WebUiExtension, resolveText: WebExtensionsFace["resolveText"]) {
  return {
    title: extension.meta?.title === undefined ? extension.name : resolveText(extension.meta.title),
    description:
      extension.meta?.description === undefined
        ? undefined
        : resolveText(extension.meta.description) || undefined,
  };
}

function errorView(error: unknown): Exclude<View, { kind: "loading" } | { kind: "ready" }> {
  if (error instanceof ApiError && error.code === "auth/local-access-required") {
    const details = webLocalAccessRequiredDetailsSchema.safeParse(error.details);
    return { kind: "non-local", url: details.success ? details.data.url : "http://127.0.0.1" };
  }
  return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

/** Settings section; the server determines whether the current access may manage extensions. */
export function WebExtensionsSection({
  t,
  resolveText,
}: PropsLocale<"codexhostImport"> & WebExtensionsFace): ReactNode {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [installOpen, setInstallOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void uiExtensionsApi.list(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setView({ kind: "ready", data });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setView(errorView(cause));
      },
    );
    return () => controller.abort();
  }, []);

  const run = async (
    key: string,
    action: () => Promise<WebUiExtensionsState>,
    onSuccess?: () => void,
  ): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setPending(key);
    setError(null);
    try {
      setView({ kind: "ready", data: await action() });
      onSuccess?.();
      return true;
    } catch (cause) {
      const failure = errorView(cause);
      if (failure.kind === "non-local") setView(failure);
      else
        setError(
          t("extensions.actionFailed", { message: formatWebExtensionError(failure.message, t) }),
        );
      return false;
    } finally {
      running.current = false;
      setPending(null);
    }
  };
  const recovery = (
    <div className={css.recovery}>
      <a className={css.link} href="/extensions">
        {t("extensions.recovery")}
      </a>
      <a className={css.link} href="/?extensions=off">
        {t("extensions.builtinsOnly")}
      </a>
    </div>
  );

  if (view.kind === "loading") return <p className={css.hint}>{t("extensions.loading")}</p>;
  if (view.kind === "non-local")
    return (
      <p className={css.notice} data-web-extensions-notice="non-local">
        {t("extensions.localOnly", { url: view.url })}
      </p>
    );
  if (view.kind === "failed")
    return (
      <div className={css.page}>
        <p className={css.error} role="alert">
          {t("extensions.loadFailed", { message: view.message })}
        </p>
        {error !== null && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
        <div>
          <button
            type="button"
            className={css.button}
            disabled={pending !== null}
            onClick={() => void run("refresh", () => uiExtensionsApi.list())}
          >
            {t("extensions.retry")}
          </button>
        </div>
        {recovery}
      </div>
    );

  const { extensions, loadedIds, safeMode, storeError } = view.data;
  const busy = pending !== null;
  const selectedEntry = extensions.find((extension) => extension.id === selectedId);
  const selected =
    selectedEntry === undefined
      ? undefined
      : { ...selectedEntry, ...extensionText(selectedEntry, resolveText) };
  const toggle = (id: string, enabled: boolean) => {
    void run(id, () => uiExtensionsApi.setEnabled(id, enabled));
  };
  return (
    <div className={css.page} data-web-extensions>
      {selected === undefined ? (
        <header className={css.header}>
          <div className={css.heading}>
            <h2 className={css.title}>{t("settings.extensions")}</h2>
            <div className={css.intro}>
              <p className={css.hint}>{t("extensions.description")}</p>
              <Tooltip
                label={t("extensions.restart")}
                side="bottom"
                maxWidth={320}
                portal
                openOnClick
              >
                <button type="button" className={css.iconButton} aria-label={t("extensions.info")}>
                  <IconInfoOutlineRegular size={15} />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className={css.actions}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t("extensions.refresh")}
              title={t("extensions.refresh")}
              disabled={busy}
              aria-busy={pending === "refresh"}
              onClick={() => void run("refresh", () => uiExtensionsApi.list())}
            >
              <IconRefreshOutlineRegular size={18} />
            </button>
            <Button
              variant="primary"
              icon={<IconPlusOutlineRegular size={16} />}
              disabled={busy || storeError !== undefined}
              onClick={() => {
                setError(null);
                setInstallOpen(true);
              }}
            >
              {t("extensions.add")}
            </Button>
          </div>
        </header>
      ) : (
        <button
          type="button"
          className={css.back}
          onClick={() => {
            setSelectedId(null);
            setConfirming(null);
            setError(null);
          }}
        >
          <IconChevronLeftOutlineRegular />
          {t("settings.extensions")}
        </button>
      )}
      <InstallWebExtensionDialog
        t={t}
        open={installOpen}
        busy={pending === "install"}
        error={error}
        onClose={() => setInstallOpen(false)}
        onInstall={(spec, registry) =>
          run(
            "install",
            () => uiExtensionsApi.install(spec, registry),
            () => setInstallOpen(false),
          )
        }
      />
      {safeMode && <p className={css.notice}>{t("extensions.safeMode")}</p>}
      {storeError !== undefined && (
        <p className={css.error} role="alert">
          {t("extensions.storeError", { message: storeError })}
        </p>
      )}
      {error !== null && !installOpen && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      {selected !== undefined ? (
        <section className={css.detail} data-web-extension-detail={selected.id}>
          <header className={css.header}>
            <ExtensionArtwork src={selected.meta?.icon} />
            <div className={css.actions}>
              <ExtensionProjectLink url={selected.projectUrl} t={t} />
              {confirming === selected.id && (
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
                  {t("extensions.cancel")}
                </Button>
              )}
              <Button
                variant="outline"
                className={confirming === selected.id ? css.danger : undefined}
                disabled={busy || storeError !== undefined}
                onClick={() => {
                  if (confirming !== selected.id) {
                    setConfirming(selected.id);
                    return;
                  }
                  void run(
                    selected.id,
                    () => uiExtensionsApi.remove(selected.id),
                    () => {
                      setSelectedId(null);
                      setConfirming(null);
                    },
                  );
                }}
              >
                {t("extensions.remove")}
              </Button>
              <Switch
                label={selected.title}
                checked={selected.enabledTargets.includes("web")}
                disabled={busy || storeError !== undefined}
                onChange={(enabled) => toggle(selected.id, enabled)}
              />
            </div>
          </header>
          <div className={css.rowText}>
            <h2 className={css.title}>{selected.title}</h2>
            {selected.title !== selected.name && <p className={css.meta}>{selected.name}</p>}
            {selected.description !== undefined && (
              <p className={css.description}>{selected.description}</p>
            )}
            <p className={css.meta}>
              {selected.version} · DSH ·{" "}
              {t(
                selected.enabledTargets.includes("web")
                  ? "extensions.enabled"
                  : "extensions.disabled",
              )}
            </p>
          </div>
          <p className={css.source}>{t("extensions.source", { source: selected.source })}</p>
          {selected.meta?.error !== undefined && (
            <p className={css.notice}>
              {t("extensions.metadataError", { message: selected.meta.error })}
            </p>
          )}
          <p className={css.notice}>{t("extensions.restart")}</p>
          {loadedIds.includes(selected.id) && (
            <p className={css.hint}>{t("extensions.includedAtStartup")}</p>
          )}
          {confirming === selected.id && (
            <p className={css.notice}>{t("extensions.confirmRemove", { name: selected.name })}</p>
          )}
          {selected.loadError !== undefined && (
            <p className={css.error} role="alert">
              {t("extensions.extensionError", {
                message: formatWebExtensionError(selected.loadError, t),
              })}
            </p>
          )}
        </section>
      ) : extensions.length === 0 ? (
        <p className={css.hint}>{t("extensions.empty")}</p>
      ) : (
        <section className={css.group}>
          <h3 className={css.groupTitle}>
            {t("extensions.installed")} <span className={css.count}>{extensions.length}</span>
          </h3>
          <ul className={css.list}>
            {extensions.map((extension) => {
              const enabled = extension.enabledTargets.includes("web");
              const loaded = loadedIds.includes(extension.id);
              const { title, description } = extensionText(extension, resolveText);
              return (
                <li key={extension.id} className={css.row} data-web-extension={extension.id}>
                  <button
                    type="button"
                    className={css.open}
                    aria-label={title}
                    onClick={() => {
                      setSelectedId(extension.id);
                      setConfirming(null);
                    }}
                  >
                    <ExtensionArtwork src={extension.meta?.icon} />
                    <span className={css.rowText}>
                      <span className={css.name} title={title}>
                        {title}
                      </span>
                      {description !== undefined && (
                        <span className={css.summary} title={description}>
                          {description}
                        </span>
                      )}
                      <span className={css.meta}>
                        {extension.version} · DSH ·{" "}
                        {t(enabled ? "extensions.enabled" : "extensions.disabled")}
                      </span>
                    </span>
                    <IconChevronRightOutlineRegular className={css.chevron} />
                  </button>
                  <div className={css.actions}>
                    <ExtensionProjectLink url={extension.projectUrl} t={t} />
                    <Switch
                      label={title}
                      checked={enabled}
                      disabled={busy || storeError !== undefined}
                      onChange={(next) => toggle(extension.id, next)}
                    />
                  </div>
                  {enabled !== loaded && !safeMode && extension.loadError === undefined && (
                    <p className={`${css.notice} ${css.rowNotice}`}>
                      {t("extensions.pendingRestart")}
                    </p>
                  )}
                  {extension.loadError !== undefined && (
                    <p className={`${css.error} ${css.rowNotice}`} role="alert">
                      {t("extensions.extensionError", {
                        message: formatWebExtensionError(extension.loadError, t),
                      })}
                    </p>
                  )}
                  {extension.meta?.error !== undefined && (
                    <p className={`${css.notice} ${css.rowNotice}`}>
                      {t("extensions.metadataError", { message: extension.meta.error })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {recovery}
    </div>
  );
}
