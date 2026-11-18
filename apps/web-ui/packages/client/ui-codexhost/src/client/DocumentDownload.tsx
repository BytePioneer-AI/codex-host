import { useState } from "react";
import {
  IconDownloadOutlineRegular,
  IconFolderOpenOutlineRegular,
  Toast,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./DocumentDownload.module.css";

/** Reveals the file's containing folder locally and downloads the original bytes. */
export function DocumentDownload({
  absolutePath,
  sessionId,
  label,
  openFolderLabel,
  remoteUnsupportedLabel,
  openFolderFailedLabel,
}: {
  readonly absolutePath: string;
  readonly sessionId: string;
  readonly label: string;
  readonly openFolderLabel: string;
  readonly remoteUnsupportedLabel: string;
  readonly openFolderFailedLabel: string;
}) {
  const query = new URLSearchParams({ sessionId, path: absolutePath });
  const [opening, setOpening] = useState(false);
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null);
  const showError = (text: string) => {
    setToast((prev) => ({ seq: (prev?.seq ?? 0) + 1, text }));
  };
  return (
    <>
      <Tooltip label={openFolderLabel} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.tool}
          aria-label={openFolderLabel}
          disabled={opening}
          onClick={() => {
            setOpening(true);
            void fetch("/api/workspace-file/open-folder", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId, path: absolutePath }),
            })
              .then((response) => {
                if (!response.ok) {
                  showError(
                    response.status === 403 ? remoteUnsupportedLabel : openFolderFailedLabel,
                  );
                }
              })
              .catch(() => {
                showError(openFolderFailedLabel);
              })
              .finally(() => {
                setOpening(false);
              });
          }}
        >
          <IconFolderOpenOutlineRegular />
        </button>
      </Tooltip>
      <Tooltip label={label} side="bottom" delayMs={500}>
        <a
          href={`/api/workspace-file/download?${query}`}
          download
          className={css.tool}
          aria-label={label}
        >
          <IconDownloadOutlineRegular />
        </a>
      </Tooltip>
      {toast && <Toast key={toast.seq} text={toast.text} onDone={() => setToast(null)} />}
    </>
  );
}
