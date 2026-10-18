/** Overlay-only: leftover avatar-overlay must not ingest other Threads' live work. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const BLOCKED_METHODS = new Set(["thread/started"]);

export function isAvatarOverlayHref(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.pathname === "/avatar-overlay.html") return true;
    return url.searchParams.get("initialRoute") === "/avatar-overlay";
  } catch {
    return false;
  }
}

export function overlayBlocksHostNotification(
  method: string,
  threadId: string | undefined,
  allowedRealtimeThreadIds: ReadonlySet<string>,
): boolean {
  if (method.startsWith("thread/realtime/")) {
    return false;
  }
  if (threadId !== undefined && allowedRealtimeThreadIds.has(threadId)) {
    return false;
  }
  if (BLOCKED_METHODS.has(method)) return true;
  return method.startsWith("turn/") || method.startsWith("item/");
}

export function notificationThreadId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (typeof params.threadId === "string" && params.threadId.length > 0) return params.threadId;
  const thread = params.thread;
  if (isRecord(thread) && typeof thread.id === "string" && thread.id.length > 0) {
    return thread.id;
  }
  return undefined;
}

export interface OverlayIsolationTarget {
  location?: { href: string };
  addEventListener(
    type: "message",
    listener: (event: OverlayIsolationMessageEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: OverlayIsolationMessageEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void;
}

export interface OverlayIsolationMessageEvent {
  data?: unknown;
  stopImmediatePropagation(): void;
}

export interface OverlayIsolationHandle {
  status: "disabled" | "active";
  dispose(): void;
}

/**
 * Avatar overlay is a persistent Desktop webcontents. Host notifications are
 * posted to every window. Without this filter, a leftover overlay upserts
 * CLI-created Threads and Desktop rebinds the same Turn twice.
 */
export function installOverlayThreadIsolation(
  target: OverlayIsolationTarget | null = typeof globalThis === "undefined"
    ? null
    : (globalThis as unknown as OverlayIsolationTarget),
): OverlayIsolationHandle {
  if (!target || typeof target.addEventListener !== "function") {
    return { status: "disabled", dispose() {} };
  }
  const href = target.location?.href;
  if (typeof href !== "string" || !isAvatarOverlayHref(href)) {
    return { status: "disabled", dispose() {} };
  }
  // Native stream ownership can outlive the call. A primary follower still
  // receives this Thread's updates through the overlay owner after hangup.
  const voiceThreadIds = new Set<string>();
  const listener = (event: OverlayIsolationMessageEvent): void => {
    const message = event.data;
    if (!isRecord(message) || message.type !== "mcp-notification") return;
    if (typeof message.method !== "string") return;
    const threadId = notificationThreadId(message.params);
    if (message.method === "thread/realtime/started" && threadId) {
      voiceThreadIds.add(threadId);
      return;
    }
    if (overlayBlocksHostNotification(message.method, threadId, voiceThreadIds)) {
      event.stopImmediatePropagation();
    }
    if (message.method === "thread/deleted" && threadId) voiceThreadIds.delete(threadId);
  };
  target.addEventListener("message", listener, true);
  return {
    status: "active",
    dispose() {
      target.removeEventListener("message", listener, true);
    },
  };
}
