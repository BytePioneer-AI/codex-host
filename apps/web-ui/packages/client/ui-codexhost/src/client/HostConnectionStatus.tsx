import { useState, useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { HostObservable, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { Toast, useSustainedRecovery } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./HostConnectionStatus.module.css";
import { computerOffline } from "./auth-watch.ts";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    nativeConnection: { state: "connected" | "reconnecting"; message?: string } | null;
    nativeInteractionError: string | null;
  }
}

export function HostConnectionStatus({
  sessionId,
  useSession,
  list,
  connection,
  t,
}: PropsRuntime<"conversation.header.notice"> & {
  list: HostObservable<SessionListState>;
  connection: Pick<ConnectionHandle, "state" | "reconnect">;
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
  const openState = useSession((session) => session.openState);
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
          : openState === "error"
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
          <button type="button" className={css.retry} onClick={() => connection.reconnect()}>
            {t("connection.retry")}
          </button>
        </div>
      ) : null}
      {error && dismissed !== key ? (
        <Toast key={key} text={error} holdMs={8000} onDone={() => setDismissed(key)} />
      ) : null}
    </>
  );
}
