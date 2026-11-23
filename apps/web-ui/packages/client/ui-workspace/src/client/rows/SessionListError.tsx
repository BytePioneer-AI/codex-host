import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import css from "./WorkspaceBrowser.module.css";

type Props = Pick<WorkspaceBrowserProps, "refreshSessions" | "loadMoreSessions" | "t"> & {
  list: Pick<SessionListState, "listError" | "listErrorPage" | "listErrorWorkspaceId" | "loading">;
};

/** A list failure retries only its failed page, without acquiring any conversation. A failed
 * project page retries with the same project, so it still reads on to that project's Sessions. */
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
          if (list.listErrorPage === "more")
            loadMoreSessions(list.listErrorWorkspaceId ?? undefined);
          else refreshSessions();
        }}
      >
        {t("sessions.retry")}
      </button>
    </div>
  );
}
