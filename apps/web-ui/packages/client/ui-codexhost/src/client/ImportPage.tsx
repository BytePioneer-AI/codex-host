/** Main-column page listing native Harness sessions that can be imported. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconClockOutlineRegular,
  IconDataOutlineRegular,
  IconFolderCloseRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconWarningOutlineRegular,
  RemotePluginIcon,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { importApi, type ImportCandidate, type ImportSource } from "./api.ts";
import css from "./ImportPage.module.css";

export interface ImportPageFace {
  /** Refresh the catalog and reveal the committed Thread, unless the page was disposed. */
  openSession: (threadId: string, signal: AbortSignal) => void | Promise<void>;
}

export type ImportPageProps = ImportPageFace & PropsLocale<"codexhostImport">;

const TAB_ICON_SIZE = 14;

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

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function ImportPage({ openSession, t }: ImportPageProps): ReactNode {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [reload, setReload] = useState(0);
  const [items, setItems] = useState<ImportCandidate[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [imported, setImported] = useState<Record<string, string>>({});
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let live = true;
    setError(null);
    importApi.sources().then(
      ({ harnesses }) => {
        if (!live) return;
        setSources(harnesses);
        setActive((current) =>
          harnesses.some((source) => source.harnessId === current)
            ? current
            : (harnesses[0]?.harnessId ?? null),
        );
      },
      (reason: unknown) => {
        if (live) setError(messageOf(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [reload]);

  useEffect(() => {
    if (active === null) return;
    let live = true;
    setItems(null);
    setError(null);
    const timer = setTimeout(
      () => {
        importApi.candidates({ harnessId: active, query, offset, limit: pageSize }).then(
          ({ candidates, total: count }) => {
            if (!live) return;
            // A concurrent import/deletion may have removed the final page.
            if (offset > 0 && offset >= count) {
              setOffset(Math.max(0, Math.ceil(count / pageSize) - 1) * pageSize);
              return;
            }
            setItems(candidates);
            setTotal(count);
          },
          (reason: unknown) => {
            if (live) setError(messageOf(reason));
          },
        );
      },
      query === "" ? 0 : 200,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, query, offset, pageSize, reload]);

  const home = useMemo(() => {
    const match = /^(\/Users\/[^/]+|\/home\/[^/]+)/u.exec(items?.[0]?.cwd ?? "");
    return match?.[1];
  }, [items]);
  const displayPath = (path: string): string =>
    home !== undefined && (path === home || path.startsWith(`${home}/`))
      ? `~${path.slice(home.length)}`
      : path;

  const choose = async (candidate: ImportCandidate): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (active === null || pending.current || !signal || signal.aborted) return;
    const key = JSON.stringify([active, candidate.nativeSessionId]);
    let threadId = imported[key];
    pending.current = true;
    setBusy(candidate.nativeSessionId);
    setActionError(null);
    try {
      if (!threadId) {
        const result = await importApi.importSession(active, candidate.nativeSessionId);
        threadId = result.threadId;
        if (signal.aborted) return;
        setImported((current) => ({ ...current, [key]: result.threadId }));
      }
      if (!signal.aborted) await openSession(threadId, signal);
    } catch (reason: unknown) {
      if (!signal.aborted)
        setActionError(t(threadId ? "openFailed" : "importFailed", { message: messageOf(reason) }));
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(null);
    }
  };

  const resetList = (): void => {
    setItems(null);
    setOffset(0);
    setActionError(null);
  };

  const refresh = (): void => {
    setItems(null);
    setReload((current) => current + 1);
  };

  return (
    <div className={css.page}>
      <div className={css.inner}>
        <header className={css.header}>
          <div className={css.heading}>
            <h1 className={css.title}>{t("title")}</h1>
            <p className={css.subtitle}>{t("subtitle")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className={css.refresh}
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={busy !== null}
            onClick={refresh}
          >
            {t("refresh")}
          </Button>
        </header>
        {sources !== null && sources.length === 0 && (
          <div className={css.status}>{t("noSources")}</div>
        )}
        {sources !== null && sources.length > 1 && (
          <div className={css.tabs} role="tablist" aria-label={t("sources")}>
            {sources.map((source) => (
              <button
                key={source.harnessId}
                type="button"
                role="tab"
                aria-selected={source.harnessId === active}
                className={css.tab}
                data-active={source.harnessId === active || undefined}
                disabled={busy !== null}
                onClick={() => {
                  if (source.harnessId === active) return;
                  resetList();
                  setActive(source.harnessId);
                }}
              >
                <span className={css.tabIcon} aria-hidden="true">
                  <RemotePluginIcon
                    id={source.harnessId}
                    src={`/harness-icons/${encodeURIComponent(source.harnessId)}`}
                    presentationUrl="/harness-icons/presentation.json"
                    size={TAB_ICON_SIZE}
                    fallback={<IconDataOutlineRegular size={TAB_ICON_SIZE} />}
                  />
                </span>
                {source.name}
              </button>
            ))}
          </div>
        )}
        {sources !== null && sources.length > 0 && (
          <label className={css.searchField}>
            <IconSearchOutlineRegular size={16} className={css.searchIcon} />
            <input
              className={css.search}
              type="search"
              value={query}
              aria-label={t("search")}
              placeholder={t("search")}
              disabled={busy !== null}
              onChange={(event) => {
                resetList();
                setQuery(event.target.value);
              }}
            />
          </label>
        )}
        {error !== null && (
          <div role="alert" className={css.callout} data-tone="error">
            <IconWarningOutlineRegular size={16} className={css.calloutIcon} />
            <span>{t("error", { message: error })}</span>
          </div>
        )}
        {actionError !== null && (
          <div role="alert" className={css.callout} data-tone="error">
            <IconWarningOutlineRegular size={16} className={css.calloutIcon} />
            <span>{actionError}</span>
          </div>
        )}
        {error === null && (sources === null || (active !== null && items === null)) && (
          <div className={css.status}>
            <StateDot state="ongoing" />
            {t("loading")}
          </div>
        )}
        {items !== null && items.length === 0 && (
          <div className={css.empty}>
            <IconSearchOutlineRegular size={22} className={css.emptyIcon} />
            {t("empty")}
          </div>
        )}
        {items !== null && items.length > 0 && (
          <ul className={css.list}>
            {items.map((candidate) => {
              const threadId = imported[JSON.stringify([active, candidate.nativeSessionId])];
              return (
                <li key={candidate.nativeSessionId} className={css.row}>
                  <div className={css.rowText}>
                    <div className={css.rowTitle}>{candidate.title ?? t("untitled")}</div>
                    <div className={css.rowMeta}>
                      <span className={css.metaItem} title={candidate.cwd}>
                        <IconFolderCloseRegular size={13} className={css.metaIcon} />
                        <span className={css.metaText}>{displayPath(candidate.cwd)}</span>
                      </span>
                      <span className={css.metaItem}>
                        <IconClockOutlineRegular size={13} className={css.metaIcon} />
                        {relativeTime(candidate.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant={threadId ? "outline" : "primary"}
                    size="sm"
                    className={css.action}
                    disabled={busy !== null}
                    onClick={() => void choose(candidate)}
                  >
                    {busy === candidate.nativeSessionId
                      ? t("importing")
                      : threadId
                        ? t("open")
                        : t("import")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {active !== null && (
          <div className={css.footer}>
            <label className={css.pageSize}>
              {t("pageSize")}
              <select
                className={css.select}
                aria-label={t("pageSize")}
                value={pageSize}
                disabled={busy !== null}
                onChange={(event) => {
                  resetList();
                  setPageSize(Number(event.target.value));
                }}
              >
                {[20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <div className={css.pager}>
              {items !== null && (
                <span className={css.range}>
                  {t("range", {
                    start: String(total === 0 ? 0 : offset + 1),
                    end: String(offset + items.length),
                    total: String(total),
                  })}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className={css.pageButton}
                aria-label={t("previous")}
                title={t("previous")}
                disabled={busy !== null || items === null || offset === 0}
                onClick={() => {
                  setItems(null);
                  setOffset(Math.max(0, offset - pageSize));
                }}
              >
                <IconChevronLeftOutlineRegular size={14} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={css.pageButton}
                aria-label={t("next")}
                title={t("next")}
                disabled={busy !== null || items === null || offset + pageSize >= total}
                onClick={() => {
                  setItems(null);
                  setOffset(offset + pageSize);
                }}
              >
                <IconChevronRightOutlineRegular size={14} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
