import { IconDownloadOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./DocumentDownload.module.css";

/** Downloads the original bytes, independent of the selected preview renderer. */
export function DocumentDownload({
  absolutePath,
  sessionId,
  label,
}: {
  readonly absolutePath: string;
  readonly sessionId: string;
  readonly label: string;
}) {
  const query = new URLSearchParams({ sessionId, path: absolutePath });
  return (
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
  );
}
