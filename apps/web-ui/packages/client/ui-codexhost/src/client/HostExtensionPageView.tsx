import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, IconRefreshOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  HostExtensionInstallation,
  HostExtensionPageColorScheme,
} from "@codexhost/shared-contracts";
import type { HostSettingsSource } from "./HostSettingsSection.tsx";
import { subscribeHostExtensionEvents } from "./host-extensions-events.ts";
import { createWebExtensionSurface } from "./native-extensions/surface.ts";
import surfaceCss from "./native-extensions/surface.module.css";
import {
  extensionPageIconUrl,
  extensionPageTitle,
  type ExtensionLocale,
  type Translate,
} from "./web-extensions-helpers.ts";
import { ExtensionIcon } from "./WebExtensionCard.tsx";
import css from "./HostExtensionPageView.module.css";

export interface HostExtensionPageViewProps {
  readonly item: HostExtensionInstallation;
  readonly catalogIcon?: string | undefined;
  readonly locale: HostSettingsSource<string>;
  readonly colorScheme: HostSettingsSource<HostExtensionPageColorScheme>;
  readonly contentLocale: ExtensionLocale;
  readonly t: Translate;
}

export function HostExtensionPageView({
  item,
  catalogIcon,
  locale,
  colorScheme,
  contentLocale,
  t,
}: HostExtensionPageViewProps): ReactNode {
  const activeLocale = useSyncExternalStore(locale.subscribe, locale.get);
  const activeScheme = useSyncExternalStore(colorScheme.subscribe, colorScheme.get);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const translate = useRef(t);
  translate.current = t;

  const { id, activationId, digest, manifest } = item;
  const pageEntry = manifest.page?.entry;
  const pageStyle = manifest.page?.style;
  const hasBackend = manifest.backend !== undefined;
  const pageTitle = extensionPageTitle(manifest, contentLocale);
  const version = manifest.version.replace(/^v/u, "");
  const iconUrl = extensionPageIconUrl(item) ?? catalogIcon;

  useEffect(() => {
    const container = mountRef.current;
    if (!container || pageEntry === undefined) return;

    setPhase("loading");
    setErrorText(null);
    let closed = false;
    const surface = createWebExtensionSurface({
      container,
      identity: { id, activationId, digest },
      kind: "page",
      spec: { apiVersion: 1, entry: pageEntry, style: pageStyle },
      appearance: { locale, colorScheme },
      hasBackend,
      noBackendMessage: () => translate.current("extensions.page.noBackend", { id }),
    });
    const refresh = () => {
      void surface.refreshSettings();
    };
    const unsubscribe = subscribeHostExtensionEvents({
      document: container.ownerDocument,
      onExtensionsChanged: refresh,
      onReconnect: refresh,
    });
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      surface.dispose();
    };
    void surface.mount().then(
      () => {
        if (!closed) setPhase("ready");
      },
      (cause: unknown) => {
        if (closed) return;
        close();
        setErrorText(cause instanceof Error ? cause.message : String(cause));
        setPhase("error");
      },
    );
    return close;
  }, [
    id,
    activationId,
    digest,
    pageEntry,
    pageStyle,
    hasBackend,
    locale,
    colorScheme,
    reloadNonce,
  ]);

  return (
    <section
      className={css.root}
      data-host-extension-page={item.id}
      data-locale={activeLocale}
      data-color-scheme={activeScheme}
    >
      <header className={css.header}>
        <div className={css.identity}>
          <ExtensionIcon src={iconUrl} size="sidebar" />
          <h2 className={css.title} title={pageTitle}>
            {pageTitle}
          </h2>
          <span className={css.version}>v{version}</span>
        </div>
        <button
          type="button"
          className={css.reloadButton}
          data-action="page-reload"
          aria-label={t("extensions.page.reload")}
          title={t("extensions.page.reload")}
          onClick={() => setReloadNonce((n) => n + 1)}
        >
          <IconRefreshOutlineRegular size={15} />
        </button>
      </header>

      <div className={`${css.stage} ${surfaceCss.theme}`}>
        {phase === "loading" && (
          <p className={css.status} role="status">
            {t("extensions.page.loading")}
          </p>
        )}

        {phase === "error" && (
          <div className={css.errorBox} role="alert">
            <div className={css.errorCopy}>
              <h3 className={css.errorTitle}>{t("extensions.page.loadFailedTitle")}</h3>
              <p className={css.errorMessage}>{errorText ?? ""}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
              {t("extensions.retry")}
            </Button>
          </div>
        )}

        <div ref={mountRef} className={css.mountRoot} hidden={phase === "error"} />
      </div>
    </section>
  );
}
