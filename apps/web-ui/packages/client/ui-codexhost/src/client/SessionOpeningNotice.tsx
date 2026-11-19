/** ID resolution remains visible and retryable without hiding the conversation shell. */
import { useSyncExternalStore } from "react";
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./HostConnectionStatus.module.css";

export function SessionOpeningNotice({
  navigation,
  t,
}: {
  navigation: Pick<UiWorkspace, "opening" | "retryOpening">;
} & PropsLocale<"codexhostImport">) {
  const opening = useSyncExternalStore(
    navigation.opening.subscribe,
    navigation.opening.getSnapshot,
  );
  if (opening.state === "idle") return null;
  return (
    <div
      className={css.status}
      role={opening.state === "error" ? "alert" : "status"}
      data-session-opening={opening.state}
    >
      <div className={css.copy}>
        <span>{t(opening.state === "loading" ? "opening.loading" : "opening.error")}</span>
        <span className={css.detail}>{opening.sessionId}</span>
        {opening.state === "error" ? <span className={css.detail}>{opening.message}</span> : null}
      </div>
      {opening.state === "error" ? (
        <button type="button" className={css.retry} onClick={() => navigation.retryOpening()}>
          {t("connection.retry")}
        </button>
      ) : null}
    </div>
  );
}
