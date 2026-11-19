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
}

let loading: Promise<WebSettingsPages> | undefined;

function loadPages(): Promise<WebSettingsPages> {
  loading ??= new Promise<WebSettingsPages>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "codexhost-settings.js";
    script.onload = () => {
      const pages = (window as { __codexhostWebSettingsV1?: WebSettingsPages })
        .__codexhostWebSettingsV1;
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

export function HostSettingsSection({
  t,
  pageId,
  locale,
  colorScheme,
}: HostSettingsSectionFace & PropsLocale<"codexhostImport">) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const activeLocale = useSyncExternalStore(locale.subscribe, locale.get);
  const activeScheme = useSyncExternalStore(colorScheme.subscribe, colorScheme.get);
  useEffect(() => {
    let disposed = false;
    let unmount: (() => void) | undefined;
    setError("");
    loadPages()
      .then((pages) => {
        if (disposed || !host.current) return;
        unmount = pages.mount(pageId, host.current, {
          locale: activeLocale,
          colorScheme: activeScheme,
        });
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      unmount?.();
    };
  }, [pageId, activeLocale, activeScheme]);
  return (
    <>
      {error && <div className={css.error}>{t("settings.unavailable", { message: error })}</div>}
      <div ref={host} className={css.host} />
    </>
  );
}
