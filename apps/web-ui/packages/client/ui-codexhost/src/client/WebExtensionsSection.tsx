/** Web settings for installing and managing interface extensions on this computer. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconPlusOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webLocalAccessRequiredDetailsSchema,
  type WebUiExtensionsState,
} from "@codexhost/shared-contracts";
import { ApiError } from "./api.ts";
import { uiExtensionsApi } from "./ui-extensions-api.ts";
import { InstallWebExtensionDialog } from "./InstallWebExtensionDialog.tsx";
import css from "./WebExtensionsSection.module.css";

type View =
  | { kind: "loading" }
  | { kind: "ready"; data: WebUiExtensionsState }
  | { kind: "non-local"; url: string }
  | { kind: "failed"; message: string };

function errorView(error: unknown): Exclude<View, { kind: "loading" } | { kind: "ready" }> {
  if (error instanceof ApiError && error.code === "auth/local-access-required") {
    const details = webLocalAccessRequiredDetailsSchema.safeParse(error.details);
    return { kind: "non-local", url: details.success ? details.data.url : "http://127.0.0.1" };
  }
  return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

/** Settings section; the server determines whether the current access may manage extensions. */
export function WebExtensionsSection({ t }: PropsLocale<"codexhostImport">): ReactNode {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [installOpen, setInstallOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
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
      else setError(t("extensions.actionFailed", { message: failure.message }));
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
  return (
    <div className={css.page} data-web-extensions>
      <p className={css.hint}>{t("extensions.description")}</p>
      <div>
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
      <p className={css.notice}>{t("extensions.restart")}</p>
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
      {extensions.length === 0 ? (
        <p className={css.hint}>{t("extensions.empty")}</p>
      ) : (
        <ul className={css.list}>
          {extensions.map((extension) => {
            const enabled = extension.enabledTargets.includes("web");
            const loaded = loadedIds.includes(extension.id);
            return (
              <li key={extension.id} className={css.row} data-web-extension={extension.id}>
                <div className={css.rowText}>
                  <div className={css.name}>{extension.name}</div>
                  <div className={css.meta}>
                    {extension.version} · DSH ·{" "}
                    {t(enabled ? "extensions.enabled" : "extensions.disabled")}
                  </div>
                  <div className={css.meta}>
                    {t("extensions.source", { source: extension.source })}
                  </div>
                  {enabled !== loaded && !safeMode && extension.loadError === undefined && (
                    <p className={css.notice}>{t("extensions.pendingRestart")}</p>
                  )}
                  {loaded && <p className={css.hint}>{t("extensions.includedAtStartup")}</p>}
                  {extension.loadError !== undefined && (
                    <p className={css.error} role="alert">
                      {t("extensions.extensionError", { message: extension.loadError })}
                    </p>
                  )}
                  {confirming === extension.id && (
                    <p className={css.notice}>
                      {t("extensions.confirmRemove", { name: extension.name })}
                    </p>
                  )}
                </div>
                <div className={css.actions}>
                  <button
                    type="button"
                    className={css.button}
                    disabled={busy || storeError !== undefined}
                    onClick={() =>
                      void run(extension.id, () =>
                        uiExtensionsApi.setEnabled(extension.id, !enabled),
                      )
                    }
                  >
                    {t(enabled ? "extensions.disable" : "extensions.enable")}
                  </button>
                  {confirming === extension.id && (
                    <button
                      type="button"
                      className={css.button}
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      {t("extensions.cancel")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={css.button}
                    data-danger={confirming === extension.id ? true : undefined}
                    disabled={busy || storeError !== undefined}
                    onClick={() => {
                      if (confirming !== extension.id) {
                        setConfirming(extension.id);
                        return;
                      }
                      void run(
                        extension.id,
                        () => uiExtensionsApi.remove(extension.id),
                        () => setConfirming(null),
                      );
                    }}
                  >
                    {t("extensions.remove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <button
          type="button"
          className={css.button}
          disabled={busy}
          onClick={() => void run("refresh", () => uiExtensionsApi.list())}
        >
          {t("extensions.refresh")}
        </button>
      </div>
      {recovery}
    </div>
  );
}
