/** Main-column page listing native Harness sessions that can be imported. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { importApi, type ImportCandidate, type ImportSource } from "./api.ts";
import css from "./ImportPage.module.css";

/** Business face injected by the panel registration. */
export interface ImportPageFace {
  /** Show one imported (or already mapped) Session in the conversation column. */
  openSession: (sessionId: string) => void;
}

export type ImportPageProps = ImportPageFace & PropsLocale<"codexhostImport">;

const PAGE_SIZE = 100;

function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${String(days)}d`;
  return new Date(epochMs).toLocaleDateString();
}

/**
 * Import page: Harness tabs, a search box, and the candidate list.
 * @param props - injected navigation plus the panel locale seat.
 * @returns the page.
 */
export function ImportPage({ openSession, t }: ImportPageProps): ReactNode {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ImportCandidate[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    importApi.sources().then(
      (value) => {
        if (!live) return;
        setSources(value.sources);
        setActive((current) => current ?? value.sources[0]?.harnessId ?? null);
      },
      (reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (active === null) return;
    let live = true;
    setItems(null);
    setError(null);
    const timer = setTimeout(
      () => {
        importApi.candidates(active, query, PAGE_SIZE).then(
          (value) => {
            if (!live) return;
            setItems(value.items);
            setTotal(value.total);
          },
          (reason: unknown) => {
            if (live) setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
      },
      query === "" ? 0 : 200,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, query]);

  const home = useMemo(() => {
    const match = /^(\/Users\/[^/]+|\/home\/[^/]+)/u.exec(items?.[0]?.cwd ?? "");
    return match?.[1];
  }, [items]);
  const displayPath = (path: string): string =>
    home !== undefined && path.startsWith(home) ? `~${path.slice(home.length)}` : path;

  const choose = (candidate: ImportCandidate): void => {
    if (candidate.imported !== undefined) {
      openSession(candidate.imported);
      return;
    }
    setBusy(candidate.nativeSessionId);
    importApi.importSession(candidate.harnessId, candidate.nativeSessionId).then(
      ({ sessionId }) => {
        setBusy(null);
        setItems(
          (current) =>
            current?.map((item) =>
              item.nativeSessionId === candidate.nativeSessionId
                ? { ...item, imported: sessionId }
                : item,
            ) ?? null,
        );
        openSession(sessionId);
      },
      (reason: unknown) => {
        setBusy(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <div className={css.page}>
      <div className={css.inner}>
        <header className={css.header}>
          <h1 className={css.title}>{t("title")}</h1>
          <p className={css.subtitle}>{t("subtitle")}</p>
        </header>
        {sources !== null && sources.length === 0 && (
          <div className={css.status}>{t("noSources")}</div>
        )}
        {sources !== null && sources.length > 1 && (
          <div className={css.tabs} role="tablist">
            {sources.map((source) => (
              <button
                key={source.harnessId}
                type="button"
                role="tab"
                aria-selected={source.harnessId === active}
                className={css.tab}
                data-active={source.harnessId === active || undefined}
                onClick={() => {
                  setActive(source.harnessId);
                }}
              >
                {source.name}
              </button>
            ))}
          </div>
        )}
        {sources !== null && sources.length > 0 && (
          <input
            className={css.search}
            type="search"
            value={query}
            placeholder={t("search")}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        )}
        {error !== null && (
          <div className={`${css.status} ${css.error}`}>{t("error", { message: error })}</div>
        )}
        {error === null && active !== null && items === null && (
          <div className={css.status}>{t("loading")}</div>
        )}
        {items !== null && items.length === 0 && <div className={css.status}>{t("empty")}</div>}
        {items !== null && items.length > 0 && (
          <>
            <ul className={css.list}>
              {items.map((candidate) => (
                <li key={candidate.nativeSessionId} className={css.row}>
                  <div className={css.rowText}>
                    <div className={css.rowTitle}>{candidate.title ?? t("untitled")}</div>
                    <div className={css.rowMeta}>
                      {displayPath(candidate.cwd)}
                      {" · "}
                      {relativeTime(candidate.updatedAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={css.action}
                    disabled={busy !== null}
                    onClick={() => {
                      choose(candidate);
                    }}
                  >
                    {busy === candidate.nativeSessionId
                      ? t("importing")
                      : candidate.imported !== undefined
                        ? t("open")
                        : t("import")}
                  </button>
                </li>
              ))}
            </ul>
            {total > items.length && (
              <div className={css.footer}>
                {t("more", { shown: String(items.length), total: String(total) })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
