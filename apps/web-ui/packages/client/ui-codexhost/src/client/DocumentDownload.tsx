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
  revealFolder,
}: {
  readonly absolutePath: string;
  readonly sessionId: string;
  readonly label: string;
  readonly openFolderLabel: string;
  readonly remoteUnsupportedLabel: string;
  readonly openFolderFailedLabel: string;
  readonly revealFolder: (
    path: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } }
  >;
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
            void revealFolder(absolutePath)
              .then((result) => {
                if (!result.ok) {
                  showError(
                    result.error.code === "session/open-unavailable"
                      ? remoteUnsupportedLabel
                      : openFolderFailedLabel,
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
