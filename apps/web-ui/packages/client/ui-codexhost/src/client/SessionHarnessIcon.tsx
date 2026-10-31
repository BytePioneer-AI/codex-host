/** Sidebar branding reads durable per-session metadata without retaining/opening history. */
import { useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { IconDataOutlineRegular, RemotePluginIcon } from "@deepseek-ai/dsh-client-ui-primitives";

const SIDEBAR_ICON_SIZE = 14;

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    /** The bound Harness, or this draft's explicitly selected Harness; never another session's default. */
    harnessIdentity: { id: string; name: string } | null;
  }
}

export function SessionHarnessIcon({
  sessionId,
  list,
}: {
  sessionId: SessionId;
  list: HostObservable<SessionListState>;
}) {
  const identity = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () => list.getSnapshot().byId[sessionId]?.projectionValues?.harnessIdentity,
  );
  if (!identity) return null;
  return (
    <span
      data-harness-id={identity.id}
      title={identity.name}
      role="img"
      aria-label={identity.name}
      style={{
        display: "inline-flex",
        width: SIDEBAR_ICON_SIZE,
        height: SIDEBAR_ICON_SIZE,
        flexShrink: 0,
        color: "inherit",
      }}
    >
      <RemotePluginIcon
        id={identity.id}
        src={`/harness-icons/${encodeURIComponent(identity.id)}`}
        presentationUrl="/harness-icons/presentation.json"
        size={SIDEBAR_ICON_SIZE}
        fallback={<IconDataOutlineRegular size={SIDEBAR_ICON_SIZE} />}
      />
    </span>
  );
}
