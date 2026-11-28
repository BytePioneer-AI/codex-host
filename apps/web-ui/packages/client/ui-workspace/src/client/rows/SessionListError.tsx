import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import css from "./WorkspaceBrowser.module.css";

type Props = Pick<WorkspaceBrowserProps, "refreshSessions" | "loadMoreSessions" | "t"> & {
  list: Pick<SessionListState, "listError" | "listErrorPage" | "loading">;
};

/** Retry a failed general catalog read. Workspace retries live under the Workspace. */
export function SessionListError({ list, refreshSessions, loadMoreSessions, t }: Props) {
  if (!list.listError) return null;
  return (
    <div role="alert">
      <span>{list.listError}</span>
      <button
        type="button"
        className={css.sessionOverflowButton}
        disabled={list.loading}
        onClick={() => {
          if (list.listErrorPage === "more") loadMoreSessions();
          else refreshSessions();
        }}
      >
        {t("sessions.retry")}
      </button>
    </div>
  );
}
