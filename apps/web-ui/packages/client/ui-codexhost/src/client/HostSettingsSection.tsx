/**
 * One CodexHost settings page (connections, accounts, usage, updates, about),
 * rendered by the same page code as the console from `codexhost-settings.js`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./HostSettingsSection.module.css";

interface WebSettingsPages {
  mount(
    pageId: string,
    host: HTMLElement,
    options: { locale: string; colorScheme: "light" | "dark" },
  ): () => void;
}

export interface HostSettingsSource<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export interface HostSettingsSectionFace {
  pageId: string;
  locale: HostSettingsSource<string>;
  colorScheme: HostSettingsSource<"light" | "dark">;
  shadowCss?: string;
}

let loading: Promise<WebSettingsPages> | undefined;

function registeredPages(): WebSettingsPages | undefined {
  return (window as { __codexhostWebSettingsV1?: WebSettingsPages }).__codexhostWebSettingsV1;
}

function loadPages(): Promise<WebSettingsPages> {
  loading ??= new Promise<WebSettingsPages>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "codexhost-settings.js";
    script.onload = () => {
      const pages = registeredPages();
      if (pages) resolve(pages);
      else reject(new Error("codexhost-settings.js did not register its pages"));
    };
    script.onerror = () => {
      reject(new Error("codexhost-settings.js could not be loaded"));
    };
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

export function preloadHostSettings(): void {
  void loadPages().catch(() => undefined);
}

export function HostSettingsSection({
  t,
  pageId,
  locale,
  colorScheme,
  shadowCss,
}: HostSettingsSectionFace & PropsLocale<"codexhostImport">) {
  const host = useRef<HTMLDivElement>(null);
  const [waitingForPages, setWaitingForPages] = useState(() => registeredPages() === undefined);
  const [error, setError] = useState("");
  const activeLocale = useSyncExternalStore(locale.subscribe, locale.get);
  const activeScheme = useSyncExternalStore(colorScheme.subscribe, colorScheme.get);
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let unmount: (() => void) | undefined;
    setError("");
    loadPages()
      .then((pages) => {
        if (disposed || !host.current) return;
        // Let the browser paint the active sidebar tab highlight before running synchronous page mount.
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (disposed || !host.current) return;
          unmount = pages.mount(pageId, host.current, {
            locale: activeLocale,
            colorScheme: activeScheme,
          });
          if (shadowCss && host.current.shadowRoot) {
            const extraSheet = new CSSStyleSheet();
            extraSheet.replaceSync(shadowCss);
            host.current.shadowRoot.adoptedStyleSheets = [
              ...host.current.shadowRoot.adoptedStyleSheets,
              extraSheet,
            ];
          }
          setWaitingForPages(false);
        });
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      unmount?.();
    };
  }, [pageId, activeLocale, activeScheme, shadowCss]);
  return (
    <>
      {error ? (
        <div className={css.error}>{t("settings.unavailable", { message: error })}</div>
      ) : waitingForPages ? (
        <p role="status" className={css.loading}>
          {t("settings.loading")}
        </p>
      ) : null}
      <div ref={host} className={css.host} />
    </>
  );
}
