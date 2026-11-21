import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceGitStatus } from "@codexhost/shared-contracts";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import {
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { readWorkspaceGitStatus } from "./api.ts";
import css from "./HostGitDock.module.css";

type Props = PropsRuntime<"conversation.composer.dock"> & PropsLocale<"codexhostImport">;

export function HostGitDock({ sessionId, useSession, t }: Props) {
  const running = useSession((session) => session.running);
  const [snapshot, setSnapshot] = useState<{ id: string; value: WorkspaceGitStatus }>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useAnchoredPosition({
    open,
    anchorRef: anchor,
    panelRef: panel,
    side: "top",
    gap: 8,
    margin: 12,
  });
  useDismissOnOutsidePointer(anchor, open, close, panel);
  useEffect(() => {
    close();
  }, [sessionId, close]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, close]);

  useEffect(() => {
    let disposed = false;
    let active: AbortController | undefined;
    const load = async () => {
      if (disposed || active || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      active = controller;
      setBusy(true);
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const value = await readWorkspaceGitStatus(sessionId, controller.signal);
        if (!disposed && !controller.signal.aborted) setSnapshot({ id: sessionId, value });
      } catch {
        if (!disposed && document.visibilityState !== "hidden")
          setSnapshot({ id: sessionId, value: { state: "unavailable", reason: "git-failed" } });
      } finally {
        window.clearTimeout(timeout);
        if (active === controller) active = undefined;
        if (!disposed) setBusy(false);
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") active?.abort();
      else void load();
    };
    const focus = () => {
      void load();
    };
    refresh.current = focus;
    void load();
    const timer = window.setInterval(focus, 10_000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      active?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
    // Turn completion changes running and refreshes the actual working tree.
  }, [sessionId, running]);

  const status = snapshot?.id === sessionId ? snapshot.value : undefined;
  if (
    !status ||
    status.state === "not-repository" ||
    (status.state === "unavailable" && status.reason === "no-directory")
  )
    return null;
  const ready = status.state === "ready" ? status : undefined;
  const label =
    ready?.branch ?? (ready ? `HEAD · ${ready.head?.slice(0, 7) ?? "—"}` : t("git.unavailable"));
  const rows = ready
    ? [
        [t("git.branch"), label],
        [t("git.root"), ready.root],
        [t("git.upstream"), ready.upstream ?? "—"],
        ...(ready.upstream ? [[t("git.sync"), `↑${ready.ahead} ↓${ready.behind}`]] : []),
        [t("git.staged"), String(ready.staged)],
        [t("git.unstaged"), String(ready.unstaged)],
        [t("git.untracked"), String(ready.untracked)],
        [t("git.conflicted"), String(ready.conflicted)],
      ]
    : [];
  return (
    <span ref={anchor} className={css.anchor} data-composer-stat="codexhost-git">
      <button
        type="button"
        className={css.pill}
        aria-label={`${t("git.details")}: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="3" r="1.5" />
          <path d="M4 4.5v7M12 4.5v1A4 4 0 0 1 8 9H4" />
        </svg>
        <span className={css.label}>{label}</span>
        {ready && ready.changedFiles > 0 && (
          <span className={css.changes}>● {ready.changedFiles}</span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className={css.panel}
            role="dialog"
            aria-label={t("git.details")}
            style={position ?? { visibility: "hidden", left: 0, top: 0 }}
          >
            <header>{t("git.details")}</header>
            {ready ? (
              <>
                <dl>
                  {rows.map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  {ready.head === null
                    ? t("git.unborn")
                    : ready.changedFiles === 0
                      ? t("git.clean")
                      : t("git.changed", { n: ready.changedFiles })}
                </p>
                {ready.upstream && <p>{t("git.localRefs")}</p>}
                <p>
                  {t("git.checkedAt", { time: new Date(ready.checkedAt).toLocaleTimeString() })}
                </p>
              </>
            ) : (
              <p>
                {status.state === "unavailable" && status.reason === "remote"
                  ? t("git.remote")
                  : t("git.failed")}
              </p>
            )}
            <button type="button" disabled={busy} onClick={() => refresh.current()}>
              {t("git.refresh")}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
