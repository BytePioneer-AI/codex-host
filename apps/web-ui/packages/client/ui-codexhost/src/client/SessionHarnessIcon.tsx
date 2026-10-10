/** Sidebar branding reads durable per-session metadata without retaining/opening history. */
import { useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { IconDataOutlineRegular, RemotePluginIcon } from "@deepseek-ai/dsh-client-ui-primitives";

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
      style={{ display: "inline-flex", width: 16, height: 16, flexShrink: 0 }}
    >
      <RemotePluginIcon
        id={identity.id}
        src={`/harness-icons/${encodeURIComponent(identity.id)}`}
        presentationUrl="/harness-icons/presentation.json"
        size={16}
        fallback={<IconDataOutlineRegular size={16} />}
      />
    </span>
  );
}
