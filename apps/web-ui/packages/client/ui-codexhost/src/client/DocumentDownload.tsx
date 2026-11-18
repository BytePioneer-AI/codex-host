import { useState } from "react";
import {
  IconDownloadOutlineRegular,
  IconFolderOpenOutlineRegular,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./DocumentDownload.module.css";

/** Reveals the file's containing folder locally and downloads the original bytes. */
export function DocumentDownload({
  absolutePath,
  sessionId,
  label,
  openFolderLabel,
}: {
  readonly absolutePath: string;
  readonly sessionId: string;
  readonly label: string;
  readonly openFolderLabel: string;
}) {
  const query = new URLSearchParams({ sessionId, path: absolutePath });
  const [opening, setOpening] = useState(false);
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
            fetch("/api/workspace-file/open-folder", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId, path: absolutePath }),
            })
              .catch(() => undefined)
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
    </>
  );
}
