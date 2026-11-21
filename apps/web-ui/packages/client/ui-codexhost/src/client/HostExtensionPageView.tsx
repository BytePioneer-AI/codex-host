/**
 * Cross-platform standalone `page` container for the Web Plugins center.
 *
 * Exposes `HOST_EXTENSION_PAGE_CSS_VARIABLES`, mounts optional `page.style` via
 * `hostExtensionAssetUrl`, dynamically imports `page.entry`, constructs a standard
 * `HostExtensionPageApi` (`hostTarget: "web"`), and guarantees abort + disposer cleanup on
 * close, disable, uninstall, or generation change.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconRefreshOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  HOST_EXTENSION_PAGE_API_VERSION,
  HOST_EXTENSION_PAGE_CSS_VARIABLES,
  hostExtensionAssetUrl,
  resolveLocalizedExtensionText,
  type DesktopExtensionDispose,
  type HostExtensionPageApi,
  type HostExtensionPageColorScheme,
  type HostExtensionPageModule,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import type { HostSettingsSource } from "./HostSettingsSection.tsx";
import { subscribeHostExtensionEvents } from "./host-extensions-events.ts";
import {
  hostExtensionsApi,
  isHostExtensionRevisionConflictError,
} from "./web-native-extension-management-api.ts";
import {
  resolveHostIconUrl,
  toExtensionLocale,
  type ExtensionLocale,
  type HostExtensionValidItem,
  type Translate,
} from "./web-extensions-helpers.ts";
import { ExtensionIcon } from "./WebExtensionCard.tsx";
import css from "./HostExtensionPageView.module.css";

function cloneJsonObject(values: JsonObject): JsonObject {
  try {
    return structuredClone(values);
  } catch {
    return JSON.parse(JSON.stringify(values)) as JsonObject;
  }
}

export interface HostExtensionPageViewProps {
  readonly item: HostExtensionValidItem;
  readonly catalogIcon?: string | undefined;
  readonly locale: HostSettingsSource<string>;
  readonly colorScheme: HostSettingsSource<HostExtensionPageColorScheme>;
  readonly contentLocale: ExtensionLocale;
  readonly t: Translate;
  readonly onBack: () => void;
}

export function HostExtensionPageView({
  item,
  catalogIcon,
  locale,
  colorScheme,
  contentLocale,
  t,
  onBack,
}: HostExtensionPageViewProps): ReactNode {
  const activeLocale = useSyncExternalStore(locale.subscribe, locale.get);
  const activeScheme = useSyncExternalStore(colorScheme.subscribe, colorScheme.get);

  const [reloadNonce, setReloadNonce] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const pageSpec = item.manifest.page;
  const pageTitle = pageSpec?.title
    ? resolveLocalizedExtensionText(pageSpec.title, contentLocale)
    : resolveLocalizedExtensionText(item.manifest.name, contentLocale);
  const version = item.manifest.version.replace(/^v/u, "");
  const iconUrl = resolveHostIconUrl(item, catalogIcon);

  // Keep CSS variables explicitly synced on the stage element per contract.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.setProperty(
      HOST_EXTENSION_PAGE_CSS_VARIABLES.background,
      "var(--dsw-alias-bg-layer-1)",
    );
    stage.style.setProperty(
      HOST_EXTENSION_PAGE_CSS_VARIABLES.surface,
      "var(--dsw-alias-bg-layer-2)",
    );
    stage.style.setProperty(
      HOST_EXTENSION_PAGE_CSS_VARIABLES.text,
      "var(--dsw-alias-label-primary)",
    );
    stage.style.setProperty(
      HOST_EXTENSION_PAGE_CSS_VARIABLES.mutedText,
      "var(--dsw-alias-label-secondary)",
    );
    stage.style.setProperty(HOST_EXTENSION_PAGE_CSS_VARIABLES.border, "var(--dsw-alias-border-l2)");
    stage.style.setProperty(
      HOST_EXTENSION_PAGE_CSS_VARIABLES.accent,
      "var(--dsw-alias-state-business-primary)",
    );
    stage.style.setProperty(
      HOST_EXTENSION_PAGE_CSS_VARIABLES.danger,
      "var(--dsw-alias-state-error-primary)",
    );
    stage.style.setProperty(HOST_EXTENSION_PAGE_CSS_VARIABLES.radius, "12px");
  }, [activeScheme]);

  useEffect(() => {
    const mountRoot = mountRef.current;
    if (!mountRoot || !pageSpec) return;

    const controller = new AbortController();
    const { id, activationId, digest } = item;
    const hasBackend = Boolean(item.manifest.backend);

    let disposed = false;
    let activeDisposer: DesktopExtensionDispose | undefined;
    let styleLink: HTMLLinkElement | undefined;
    let settingsRevision: number | null = null;
    const storageListeners = new Set<(values: JsonObject) => void>();
    const localeListeners = new Set<(next: string) => void>();
    const schemeListeners = new Set<(next: HostExtensionPageColorScheme) => void>();

    setPhase("loading");
    setErrorText(null);
    mountRoot.replaceChildren();

    const guard = (): void => {
      if (disposed) throw new Error(`Extension page "${id}" is closed`);
      controller.signal.throwIfAborted();
    };

    const notifyStorageListeners = (values: JsonObject): void => {
      if (disposed || controller.signal.aborted) return;
      for (const listener of [...storageListeners]) {
        try {
          listener(cloneJsonObject(values));
        } catch (error) {
          console.error(`[host-extension-page] storage.onChange failed (${id})`, error);
        }
      }
    };

    let lastObservedLocale = toExtensionLocale(locale.get());
    const unsubLocale = locale.subscribe(() => {
      if (disposed || controller.signal.aborted) return;
      const next = toExtensionLocale(locale.get());
      if (next === lastObservedLocale) return;
      lastObservedLocale = next;
      for (const listener of [...localeListeners]) {
        try {
          listener(next);
        } catch (error) {
          console.error(`[host-extension-page] onLocaleChange failed (${id})`, error);
        }
      }
    });

    let lastObservedScheme = colorScheme.get();
    const unsubScheme = colorScheme.subscribe(() => {
      if (disposed || controller.signal.aborted) return;
      const next = colorScheme.get();
      if (next === lastObservedScheme) return;
      lastObservedScheme = next;
      for (const listener of [...schemeListeners]) {
        try {
          listener(next);
        } catch (error) {
          console.error(`[host-extension-page] onColorSchemeChange failed (${id})`, error);
        }
      }
    });

    // Propagate external settings changes (e.g. from Desktop or declarative settings form).
    const unsubEvents = subscribeHostExtensionEvents({
      document,
      onExtensionsChanged: () => {
        if (disposed || controller.signal.aborted || storageListeners.size === 0) return;
        void hostExtensionsApi
          .settingsGet({ id, activationId }, controller.signal)
          .then((result) => {
            if (disposed || controller.signal.aborted) return;
            if (settingsRevision !== null && result.settingsRevision === settingsRevision) return;
            settingsRevision = result.settingsRevision;
            notifyStorageListeners(result.values);
          })
          .catch(() => undefined);
      },
    });

    const pageApi: HostExtensionPageApi = {
      id,
      apiVersion: HOST_EXTENSION_PAGE_API_VERSION,
      hostTarget: "web",
      get locale() {
        return toExtensionLocale(locale.get());
      },
      onLocaleChange(listener) {
        guard();
        localeListeners.add(listener);
        return () => {
          localeListeners.delete(listener);
        };
      },
      get colorScheme() {
        return colorScheme.get();
      },
      onColorSchemeChange(listener) {
        guard();
        schemeListeners.add(listener);
        return () => {
          schemeListeners.delete(listener);
        };
      },
      signal: controller.signal,
      assets: {
        async url(relativePath: string): Promise<string> {
          guard();
          return hostExtensionAssetUrl({ id, activationId, digest, path: relativePath });
        },
      },
      storage: {
        async get(): Promise<JsonObject> {
          guard();
          const result = await hostExtensionsApi.settingsGet(
            { id, activationId },
            controller.signal,
          );
          guard();
          settingsRevision = result.settingsRevision;
          return cloneJsonObject(result.values);
        },
        async set(values: JsonObject): Promise<JsonObject> {
          guard();
          if (settingsRevision === null) {
            const current = await hostExtensionsApi.settingsGet(
              { id, activationId },
              controller.signal,
            );
            guard();
            settingsRevision = current.settingsRevision;
          }
          let saved;
          try {
            saved = await hostExtensionsApi.settingsSet({
              id,
              activationId,
              expectedSettingsRevision: settingsRevision,
              values: cloneJsonObject(values),
            });
          } catch (cause) {
            if (!isHostExtensionRevisionConflictError(cause)) throw cause;
            guard();
            const latest = await hostExtensionsApi.settingsGet(
              { id, activationId },
              controller.signal,
            );
            guard();
            settingsRevision = latest.settingsRevision;
            saved = await hostExtensionsApi.settingsSet({
              id,
              activationId,
              expectedSettingsRevision: settingsRevision,
              values: cloneJsonObject(values),
            });
          }
          guard();
          settingsRevision = saved.settingsRevision;
          notifyStorageListeners(saved.values);
          return cloneJsonObject(saved.values);
        },
        onChange(listener) {
          guard();
          storageListeners.add(listener);
          return () => {
            storageListeners.delete(listener);
          };
        },
      },
      backend: {
        async invoke(method: string, params?: JsonValue): Promise<JsonValue> {
          guard();
          if (!hasBackend) {
            throw new Error(t("extensions.page.noBackend", { id }));
          }
          const reply = await hostExtensionsApi.backendInvoke(
            {
              id,
              activationId,
              method,
              ...(params === undefined ? {} : { params }),
            },
            controller.signal,
          );
          guard();
          return reply.result;
        },
      },
    };

    const runDisposerSafely = (disposer: DesktopExtensionDispose | undefined): void => {
      if (typeof disposer !== "function") return;
      try {
        void Promise.resolve(disposer()).catch((error: unknown) => {
          console.error(`[host-extension-page] disposer failed (${id})`, error);
        });
      } catch (error) {
        console.error(`[host-extension-page] disposer failed (${id})`, error);
      }
    };

    if (pageSpec.style) {
      const styleUrl = hostExtensionAssetUrl({
        id,
        activationId,
        digest,
        path: pageSpec.style,
      });
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("data-cx-page-style", id);
      link.href = styleUrl;
      (document.head ?? document.documentElement).append(link);
      styleLink = link;
    }

    const entryUrl = hostExtensionAssetUrl({
      id,
      activationId,
      digest,
      path: pageSpec.entry,
    });

    void (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ entryUrl)) as
          Partial<HostExtensionPageModule> | null | undefined;
        if (disposed || controller.signal.aborted) return;
        if (!mod || typeof mod.mount !== "function") {
          throw new Error(`Extension page "${id}" must export a mount(root, api) function`);
        }
        const maybeDispose = await mod.mount(mountRoot, pageApi);
        if (disposed || controller.signal.aborted) {
          if (typeof maybeDispose === "function") runDisposerSafely(maybeDispose);
          return;
        }
        if (typeof maybeDispose === "function") {
          activeDisposer = maybeDispose;
        } else if (maybeDispose !== undefined) {
          throw new Error(`Extension page "${id}" mount() returned an invalid disposer`);
        }
        setPhase("ready");
      } catch (cause: unknown) {
        if (disposed || controller.signal.aborted) return;
        setErrorText(cause instanceof Error ? cause.message : String(cause));
        setPhase("error");
      }
    })();

    return () => {
      disposed = true;
      if (!controller.signal.aborted) controller.abort();
      unsubLocale();
      unsubScheme();
      unsubEvents();
      storageListeners.clear();
      localeListeners.clear();
      schemeListeners.clear();
      const disposer = activeDisposer;
      activeDisposer = undefined;
      runDisposerSafely(disposer);
      styleLink?.remove();
      styleLink = undefined;
      mountRoot.replaceChildren();
    };
  }, [
    item.id,
    item.activationId,
    item.digest,
    item.manifest.page,
    item.manifest.backend,
    locale,
    colorScheme,
    reloadNonce,
    t,
  ]);

  return (
    <section
      className={css.root}
      data-host-extension-page={item.id}
      data-locale={activeLocale}
      data-color-scheme={activeScheme}
    >
      <header className={css.header}>
        <div className={css.headerLeft}>
          <button type="button" className={css.backButton} data-action="page-back" onClick={onBack}>
            <IconChevronLeftOutlineRegular size={14} />
            <span>{t("extensions.page.back")}</span>
          </button>

          <div className={css.identity}>
            <ExtensionIcon src={iconUrl} categories={item.manifest.categories} size="card" />
            <div className={css.titleWrap}>
              <h2 className={css.title} title={pageTitle}>
                {pageTitle}
              </h2>
              <span className={css.version}>v{version}</span>
            </div>
          </div>
        </div>

        <div className={css.actions}>
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
        </div>
      </header>

      <div ref={stageRef} className={css.stage}>
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
