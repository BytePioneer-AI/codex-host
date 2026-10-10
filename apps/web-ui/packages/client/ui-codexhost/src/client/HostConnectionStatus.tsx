import { useState, useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { HostObservable, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./HostConnectionStatus.module.css";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    nativeConnection: { state: "connected" | "reconnecting"; message?: string } | null;
    nativeInteractionError: string | null;
  }
}

export function HostConnectionStatus({
  sessionId,
  list,
  t,
}: {
  sessionId: SessionId;
  list: HostObservable<SessionListState>;
} & PropsLocale<"codexhostImport">) {
  const state = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () => list.getSnapshot().byId[sessionId]?.projectionValues?.nativeConnection?.state,
  );
  const error = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () =>
      list.getSnapshot().byId[sessionId]?.projectionValues?.nativeInteractionError ??
      list.getSnapshot().byId[sessionId]?.projectionValues?.nativeConnection?.message,
  );
  const [dismissed, setDismissed] = useState("");
  const key = `${sessionId}:${error ?? ""}`;
  if (!state) return null;
  return (
    <>
      <span
        className={css.status}
        role="status"
        data-native-connection={state}
        title={state === "connected" ? t("connection.liveHint") : t("connection.reconnectingHint")}
      >
        {state === "connected" ? t("connection.live") : t("connection.reconnecting")}
      </span>
      {error && dismissed !== key ? (
        <Toast key={key} text={error} holdMs={8000} onDone={() => setDismissed(key)} />
      ) : null}
    </>
  );
}
