import { useSyncExternalStore } from "react";
import type { ClientThreadImportSource } from "@codexhost/shared-contracts";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { HostObservable, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./ImportedThreadNotice.module.css";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    codexhostImportSource: ClientThreadImportSource | null;
  }
}

export function ImportedThreadNotice({
  sessionId,
  list,
  t,
}: PropsRuntime<"conversation.header.notice"> & {
  list: HostObservable<SessionListState>;
} & PropsLocale<"codexhostImport">) {
  const sourceId = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () => {
      const source =
        sessionId === undefined
          ? undefined
          : list.getSnapshot().byId[sessionId]?.projectionValues?.codexhostImportSource;
      return source?.harnessId === "codex-cli" ? source.nativeSessionId : undefined;
    },
  );
  if (!sourceId) return null;
  return (
    <div className={css.notice} data-codexhost-import-source={sourceId}>
      {t("import.sourceBranch", { sessionId: sourceId })}
    </div>
  );
}
