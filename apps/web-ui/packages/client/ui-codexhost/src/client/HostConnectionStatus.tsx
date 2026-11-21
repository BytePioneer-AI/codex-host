import { useState, useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type { HostObservable, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { Toast, useSustainedRecovery } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./HostConnectionStatus.module.css";
import { computerOffline } from "./auth-watch.ts";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    nativeInteractionError: string | null;
  }
}

export function HostConnectionStatus({
  sessionId,
  useSession,
  list,
  connection,
  retryHistory,
  t,
}: PropsRuntime<"conversation.header.notice"> & {
  list: HostObservable<SessionListState>;
  connection: Pick<ConnectionHandle, "state" | "reconnect">;
  retryHistory: (id: SessionId) => Promise<void>;
} & PropsLocale<"codexhostImport">) {
  const carrier = useSyncExternalStore(connection.state.subscribe, connection.state.getSnapshot);
  const computer = useSyncExternalStore(computerOffline.subscribe, computerOffline.getSnapshot);
  const host = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () =>
      sessionId === undefined
        ? undefined
        : list.getSnapshot().byId[sessionId]?.projectionValues?.nativeConnection?.state,
  );
  const error = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () => {
      const values =
        sessionId === undefined ? undefined : list.getSnapshot().byId[sessionId]?.projectionValues;
      return values?.nativeInteractionError ?? values?.nativeConnection?.message;
    },
  );
  const historyError = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () =>
      sessionId === undefined
        ? undefined
        : list.getSnapshot().byId[sessionId]?.projectionValues?.remoteHistoryError,
  );
  const openState = useSession((session) => session.openState);
  const openError = useSession((session) => session.openError);
  const [retry, setRetry] = useState<{ id: SessionId; busy: boolean; error?: string }>();
  const retrying = retry?.id === sessionId && !!retry?.busy;
  const retryError = retry?.id === sessionId ? retry?.error : undefined;
  const retryRead = () => {
    if (sessionId === undefined || retrying) return;
    const id = sessionId;
    setRetry({ id, busy: true });
    void retryHistory(id).then(
      () => setRetry((current) => (current?.id === id ? { id, busy: false } : current)),
      (failure: unknown) =>
        setRetry((current) =>
          current?.id === id
            ? {
                id,
                busy: false,
                error: failure instanceof Error ? failure.message : String(failure),
              }
            : current,
        ),
    );
  };
  const [dismissed, setDismissed] = useState("");
  const key = `${sessionId}:${error ?? ""}`;
  const recovering = carrier === undefined || carrier === "connecting";
  const noticeRecovery = useSustainedRecovery(recovering);
  const state =
    carrier === "disconnected"
      ? "offline"
      : recovering
        ? computer
          ? "computer"
          : noticeRecovery
            ? carrier === undefined
              ? "checking"
              : "reconnecting"
            : undefined
        : host === "reconnecting"
          ? "host"
          : openState === "error" && !historyError
            ? "error"
            : undefined;
  const lastSyncedAt = useSession((session) =>
    state === undefined ? undefined : session.lastSyncedAt,
  );
  return (
    <>
      {state ? (
        <div
          className={css.status}
          role="status"
          data-web-connection={state}
          data-native-connection={host === "reconnecting" ? host : undefined}
        >
          <div className={css.copy}>
            <span>{t(`connection.${state}`)}</span>
            {lastSyncedAt !== undefined ? (
              <span className={css.detail}>
                {t("connection.lastSynced", {
                  time: new Date(lastSyncedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className={css.retry}
            disabled={state === "error" && retrying}
            onClick={state === "error" ? retryRead : () => connection.reconnect()}
          >
            {t(state === "error" && retrying ? "connection.retryingHistory" : "connection.retry")}
          </button>
        </div>
      ) : null}
      {historyError || (state === "error" && (retryError || openError)) ? (
        <div className={css.status} role="alert" data-remote-history-error={historyError?.code}>
          <div className={css.copy}>
            {historyError ? <span>{t("connection.historyStale")}</span> : null}
            <span className={css.detail}>
              {retryError ?? historyError?.message ?? openError?.message}
            </span>
          </div>
          {historyError ? (
            <button type="button" className={css.retry} disabled={retrying} onClick={retryRead}>
              {t(retrying ? "connection.retryingHistory" : "connection.retryHistory")}
            </button>
          ) : null}
        </div>
      ) : null}
      {error && dismissed !== key ? (
        <Toast key={key} text={error} holdMs={8000} onDone={() => setDismissed(key)} />
      ) : null}
    </>
  );
}
