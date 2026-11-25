/** Sidebar branding reads durable per-session metadata without retaining/opening history. */
import { useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  harnessIconSources,
  IconDataOutlineRegular,
  RemotePluginIcon,
} from "@deepseek-ai/dsh-client-ui-primitives";

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
  const hostId = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    () => list.getSnapshot().byId[sessionId]?.projectionValues?.remoteHost?.hostId,
  );
  if (!identity) return null;
  const icon = harnessIconSources(identity.id, hostId);
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
      {identity.id === "codex" ? (
        <img
          src={icon.src}
          width={SIDEBAR_ICON_SIZE}
          height={SIDEBAR_ICON_SIZE}
          alt=""
          data-native-codex-icon
        />
      ) : (
        <RemotePluginIcon
          id={identity.id}
          src={icon.src}
          presentationUrl={icon.presentationUrl}
          size={SIDEBAR_ICON_SIZE}
          fallback={<IconDataOutlineRegular size={SIDEBAR_ICON_SIZE} />}
        />
      )}
    </span>
  );
}
