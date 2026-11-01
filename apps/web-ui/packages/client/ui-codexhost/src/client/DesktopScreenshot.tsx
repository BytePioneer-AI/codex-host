import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  ImageLightbox,
  IconCloseOutlineRegular,
  IconLoadingOutlineRegular,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { DesktopScreenshot } from "./desktop-screenshot.ts";
import css from "./DesktopScreenshot.module.css";

export interface DesktopScreenshotFace {
  screenshot: DesktopScreenshot;
}
type Locale = PropsLocale<"codexhostImport">;

export function DesktopScreenshotButton({
  screenshot,
  sessionId,
  t,
}: PropsRuntime<"conversation.input.right"> & DesktopScreenshotFace & Locale) {
  const state = useSyncExternalStore(screenshot.subscribe, screenshot.getSnapshot);
  // A late capture from the previous conversation must not enter the new one.
  useLayoutEffect(
    () => () => {
      if (sessionId !== undefined) screenshot.close(sessionId);
    },
    [screenshot, sessionId],
  );
  if (sessionId === undefined) return null;
  return (
    <Tooltip portal side="top" label={t(state.pending ? "desktop.pending" : "desktop.label")}>
      <button
        type="button"
        className={css.entry}
        aria-label={t("desktop.label")}
        aria-busy={state.pending}
        disabled={state.pending}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void screenshot.refresh(sessionId)}
      >
        {state.pending ? (
          <span className={css.spinner} aria-hidden="true">
            <IconLoadingOutlineRegular size={16} />
          </span>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="16" height="11" rx="2" />
            <path d="M10 14v3M6 17h8" />
          </svg>
        )}
      </button>
    </Tooltip>
  );
}

export function DesktopScreenshotPreview({
  screenshot,
  sessionId,
  t,
}: PropsRuntime<"conversation.input.notice"> & DesktopScreenshotFace & Locale) {
  const state = useSyncExternalStore(screenshot.subscribe, screenshot.getSnapshot);
  const { image, pending, error } = state;
  if (sessionId === undefined || state.sessionId !== sessionId) return null;
  if (image === undefined && !pending && error === undefined) return null;
  return (
    <section className={css.preview} aria-label={t("desktop.label")} aria-busy={pending}>
      <header className={css.header}>
        <strong>{t("desktop.primary")}</strong>
        <div className={css.actions}>
          <button
            type="button"
            onClick={() => void screenshot.refresh(sessionId)}
            disabled={pending}
          >
            {t("desktop.refresh")}
          </button>
          <button
            type="button"
            aria-label={t("desktop.close")}
            onClick={() => screenshot.close(sessionId)}
          >
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>
      </header>
      {pending && (
        <p role="status" className={css.pending}>
          <span className={css.spinner} aria-hidden="true">
            <IconLoadingOutlineRegular size={16} />
          </span>
          <span>{t("desktop.pending")}</span>
        </p>
      )}
      {error !== undefined && (
        <p role="status" className={css.error}>
          {t(`desktop.error.${error}`)} {image === undefined ? "" : t("desktop.stale")}
        </p>
      )}
      {image !== undefined && (
        <>
          <ScreenshotImage key={image.url} url={image.url} t={t} />
          <p>{t("desktop.captured", { time: new Date(image.capturedAt).toLocaleString() })}</p>
        </>
      )}
    </section>
  );
}

function ScreenshotImage({ url, t }: { url: string } & Locale) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={css.image}
        aria-label={t("desktop.enlarge")}
        onClick={() => setOpen(true)}
      >
        <img src={url} alt={t("desktop.primary")} />
      </button>
      {open && (
        <ImageLightbox
          src={url}
          alt={t("desktop.primary")}
          labels={{ dialog: t("desktop.label"), close: t("desktop.close") }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
