import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconCloseOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderOpenOutlineRegular,
  Toast,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./DocumentDownload.module.css";

const MAX_IOS_SHARE_BYTES = 50 * 1024 * 1024;

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  flac: "audio/flac",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  log: "text/plain",
  m4a: "audio/mp4",
  md: "text/markdown",
  mjs: "text/javascript",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  py: "text/plain",
  sh: "text/plain",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  ts: "text/plain",
  tsx: "text/plain",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "text/plain",
  yml: "text/plain",
  zip: "application/zip",
};

type IosReadyDownload =
  | { readonly kind: "share"; readonly file: File; readonly name: string }
  | { readonly kind: "open"; readonly url: string; readonly name: string };

function fileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/u);
  return parts[parts.length - 1] || "download";
}

function inferMimeType(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

function isIosStandalonePwa(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ios =
    /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function pickShareableFile(blob: Blob, name: string): File | null {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
    return null;
  }
  const preferredType = inferMimeType(name);
  const preferred = new File([blob], name, { type: preferredType });
  try {
    if (navigator.canShare({ files: [preferred] })) return preferred;
  } catch {
    // Fall through to generic binary type probe.
  }
  if (preferredType !== "application/octet-stream") {
    const generic = new File([blob], name, { type: "application/octet-stream" });
    try {
      if (navigator.canShare({ files: [generic] })) return generic;
    } catch {
      return null;
    }
  }
  return null;
}

interface WorkspaceDownloadLabels {
  readonly downloadFailedLabel: string;
  readonly downloadReadyLabel: (name: string) => string;
  readonly downloadSaveLabel: string;
  readonly downloadOpenLabel: string;
  readonly downloadDismissLabel: string;
}

function useWorkspaceFileDownload({
  filePath,
  sessionId,
  downloadFailedLabel,
  onToast,
}: {
  readonly filePath: string;
  readonly sessionId: string;
  readonly downloadFailedLabel: string;
  readonly onToast: (text: string) => void;
}) {
  const query = new URLSearchParams({ sessionId, path: filePath });
  const downloadUrl = `/api/workspace-file/download?${query}`;
  const fileName = fileBaseName(filePath);
  const [downloading, setDownloading] = useState(false);
  const [ready, setReady] = useState<IosReadyDownload | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const iosPwa = isIosStandalonePwa();

  useEffect(() => {
    setReady(null);
    return () => {
      downloadAbortRef.current?.abort();
      downloadAbortRef.current = null;
    };
  }, [filePath, sessionId]);

  const openTicketSheet = async (
    signal: AbortSignal,
    preopenedWindow: Window | null,
  ): Promise<void> => {
    try {
      const response = await fetch("/api/workspace-file/download-ticket", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, path: filePath }),
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const payload = (await response.json()) as { ticket?: unknown; name?: unknown };
      if (typeof payload.ticket !== "string" || payload.ticket.length === 0) {
        throw new Error("missing download ticket");
      }
      const ticketUrl = `/api/workspace-file/download?ticket=${encodeURIComponent(payload.ticket)}`;
      const resolvedName =
        typeof payload.name === "string" && payload.name.length > 0 ? payload.name : fileName;
      if (preopenedWindow && !preopenedWindow.closed) {
        preopenedWindow.location.replace(ticketUrl);
        return;
      }
      setReady({ kind: "open", url: ticketUrl, name: resolvedName });
    } catch {
      if (preopenedWindow && !preopenedWindow.closed) preopenedWindow.close();
      if (signal.aborted) return;
      onToast(downloadFailedLabel);
    }
  };

  const startIosPwaDownload = () => {
    if (downloading) return;
    downloadAbortRef.current?.abort();
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    setReady(null);
    setDownloading(true);
    const canTryShare =
      typeof navigator.share === "function" && typeof navigator.canShare === "function";
    // When Web Share is unavailable (e.g. plain HTTP LAN), open the sheet window synchronously
    // inside the click gesture so iOS presents a dismissible modal overlay instead of blocking it.
    const preopenedWindow = canTryShare ? null : window.open("about:blank", "_blank");
    void (async () => {
      try {
        if (!canTryShare) {
          await openTicketSheet(controller.signal, preopenedWindow);
          return;
        }
        const head = await fetch(downloadUrl, {
          method: "HEAD",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!head.ok) {
          onToast(downloadFailedLabel);
          return;
        }
        const rawLength = head.headers.get("content-length");
        const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
        if (Number.isFinite(contentLength) && contentLength > MAX_IOS_SHARE_BYTES) {
          await openTicketSheet(controller.signal, null);
          return;
        }
        const response = await fetch(downloadUrl, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) {
          onToast(downloadFailedLabel);
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const shareFile = pickShareableFile(blob, fileName);
        if (!shareFile) {
          await openTicketSheet(controller.signal, null);
          return;
        }
        try {
          await navigator.share({ files: [shareFile] });
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          if (cause instanceof DOMException && cause.name === "NotAllowedError") {
            // Fetching took longer than iOS's transient user-activation window; let one tap
            // invoke navigator.share synchronously with the already-fetched file.
            setReady({ kind: "share", file: shareFile, name: fileName });
            return;
          }
          await openTicketSheet(controller.signal, null);
        }
      } catch {
        if (preopenedWindow && !preopenedWindow.closed) preopenedWindow.close();
        if (!controller.signal.aborted) onToast(downloadFailedLabel);
      } finally {
        if (downloadAbortRef.current === controller) {
          downloadAbortRef.current = null;
          setDownloading(false);
        }
      }
    })();
  };

  return { downloadUrl, downloading, iosPwa, ready, setReady, startIosPwaDownload };
}

function ReadyDownloadBar({
  ready,
  labels,
  onClear,
  onFailed,
}: {
  readonly ready: IosReadyDownload;
  readonly labels: WorkspaceDownloadLabels;
  readonly onClear: () => void;
  readonly onFailed: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={css.readyBar} role="status">
      <span className={css.readyName}>{labels.downloadReadyLabel(ready.name)}</span>
      {ready.kind === "share" ? (
        <button
          type="button"
          className={css.readyAction}
          onClick={() => {
            const file = ready.file;
            onClear();
            void navigator.share({ files: [file] }).catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === "AbortError") return;
              onFailed();
            });
          }}
        >
          {labels.downloadSaveLabel}
        </button>
      ) : (
        <a
          href={ready.url}
          target="_blank"
          rel="noopener noreferrer"
          className={css.readyAction}
          onClick={onClear}
        >
          {labels.downloadOpenLabel}
        </a>
      )}
      <button
        type="button"
        className={css.readyClose}
        aria-label={labels.downloadDismissLabel}
        onClick={onClear}
      >
        <IconCloseOutlineRegular />
      </button>
    </div>,
    document.body,
  );
}

/** Reveals the file's containing folder locally and downloads the original bytes. */
export function DocumentDownload({
  filePath,
  absolutePath,
  sessionId,
  label,
  downloadFailedLabel,
  downloadReadyLabel,
  downloadSaveLabel,
  downloadOpenLabel,
  downloadDismissLabel,
  openFolderLabel,
  openFolderFailedLabel,
  revealFolder,
}: WorkspaceDownloadLabels & {
  readonly filePath: string;
  readonly absolutePath?: string;
  readonly sessionId: string;
  readonly label: string;
  readonly openFolderLabel: string;
  readonly openFolderFailedLabel: string;
  readonly revealFolder?: (
    path: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } }
  >;
}) {
  const [opening, setOpening] = useState(false);
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null);
  const showToast = (text: string) => {
    setToast((prev) => ({ seq: (prev?.seq ?? 0) + 1, text }));
  };
  const showError = (message?: string) => {
    showToast(message ? `${openFolderFailedLabel} ${message}` : openFolderFailedLabel);
  };
  const { downloadUrl, downloading, iosPwa, ready, setReady, startIosPwaDownload } =
    useWorkspaceFileDownload({
      filePath,
      sessionId,
      downloadFailedLabel,
      onToast: showToast,
    });
  const labels: WorkspaceDownloadLabels = {
    downloadFailedLabel,
    downloadReadyLabel,
    downloadSaveLabel,
    downloadOpenLabel,
    downloadDismissLabel,
  };

  return (
    <>
      {absolutePath !== undefined && revealFolder !== undefined && (
        <Tooltip label={openFolderLabel} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={openFolderLabel}
            disabled={opening}
            onClick={() => {
              setOpening(true);
              void (async () => {
                try {
                  const result = await revealFolder(absolutePath);
                  if (!result.ok) showError(result.error.message);
                } catch (error) {
                  showError(error instanceof Error ? error.message : undefined);
                } finally {
                  setOpening(false);
                }
              })();
            }}
          >
            <IconFolderOpenOutlineRegular />
          </button>
        </Tooltip>
      )}
      <Tooltip label={label} side="bottom" delayMs={500}>
        {iosPwa ? (
          <button
            type="button"
            className={css.tool}
            aria-label={label}
            aria-busy={downloading || undefined}
            disabled={downloading}
            onClick={startIosPwaDownload}
          >
            <IconDownloadOutlineRegular />
          </button>
        ) : (
          <a href={downloadUrl} download className={css.tool} aria-label={label}>
            <IconDownloadOutlineRegular />
          </a>
        )}
      </Tooltip>
      {ready && (
        <ReadyDownloadBar
          ready={ready}
          labels={labels}
          onClear={() => setReady(null)}
          onFailed={() => showToast(downloadFailedLabel)}
        />
      )}
      {toast && <Toast key={toast.seq} text={toast.text} onDone={() => setToast(null)} />}
    </>
  );
}

/** Primary download CTA shown inside the unpreviewable document empty state. */
export function DocumentDownloadAction({
  filePath,
  sessionId,
  ctaLabel,
  preparingLabel,
  downloadFailedLabel,
  downloadReadyLabel,
  downloadSaveLabel,
  downloadOpenLabel,
  downloadDismissLabel,
}: WorkspaceDownloadLabels & {
  readonly filePath: string;
  readonly sessionId: string;
  readonly ctaLabel: string;
  readonly preparingLabel: string;
}) {
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null);
  const showToast = (text: string) => {
    setToast((prev) => ({ seq: (prev?.seq ?? 0) + 1, text }));
  };
  const { downloadUrl, downloading, iosPwa, ready, setReady, startIosPwaDownload } =
    useWorkspaceFileDownload({
      filePath,
      sessionId,
      downloadFailedLabel,
      onToast: showToast,
    });
  const labels: WorkspaceDownloadLabels = {
    downloadFailedLabel,
    downloadReadyLabel,
    downloadSaveLabel,
    downloadOpenLabel,
    downloadDismissLabel,
  };

  return (
    <>
      {iosPwa ? (
        <button
          type="button"
          className={css.primaryCta}
          aria-busy={downloading || undefined}
          disabled={downloading}
          onClick={startIosPwaDownload}
        >
          {downloading ? (
            <span className={css.spinner} aria-hidden="true" />
          ) : (
            <IconDownloadOutlineRegular />
          )}
          <span>{downloading ? preparingLabel : ctaLabel}</span>
        </button>
      ) : (
        <a href={downloadUrl} download className={css.primaryCta}>
          <IconDownloadOutlineRegular />
          <span>{ctaLabel}</span>
        </a>
      )}
      {ready && (
        <ReadyDownloadBar
          ready={ready}
          labels={labels}
          onClear={() => setReady(null)}
          onFailed={() => showToast(downloadFailedLabel)}
        />
      )}
      {toast && <Toast key={toast.seq} text={toast.text} onDone={() => setToast(null)} />}
    </>
  );
}
