/**
 * Shared NDJSON event stream subscriber for `GET api/ch/v1/events`.
 *
 * Shares a single connection per browser tab via per-document ref-counting and coordinates
 * across visible same-origin tabs via Web Locks + BroadcastChannel so concurrent tabs do not
 * exhaust the browser's HTTP/1.1 per-origin connection pool.
 */
import { clientChannelEventSchema, type ClientChannelCursor } from "@codexhost/shared-contracts";

export interface SubscribeHostExtensionEventsOptions {
  readonly document?: Document | undefined;
  readonly onExtensionsChanged: (revision: number) => void;
  readonly onReconnect?: (() => void) | undefined;
}

interface EventListener {
  readonly onExtensionsChanged: (revision: number) => void;
  readonly onReconnect?: (() => void) | undefined;
}

type BroadcastPayload =
  | { readonly type: "extensions-changed"; readonly revision: number }
  | { readonly type: "reconnect" };

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const LOCK_AND_CHANNEL_NAME = "codexhost:host-extensions-events:v1";

interface SharedStreamHandle {
  subscribe(listener: EventListener): () => void;
}

// The Web bootstrap and the CodexHost UI plugin bundle this module separately.
// Put the ref-counted stream on the document so both bundles use the same connection.
const STREAM_KEY = Symbol.for("codexhost.host-extension-events.v1");
type StreamDocument = Document & { [STREAM_KEY]?: SharedStreamHandle };
let fallbackStream: SharedStreamHandle | undefined;

function canCoordinateAcrossTabs(): boolean {
  return (
    typeof BroadcastChannel === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.locks?.request === "function"
  );
}

function createSharedEventStream(
  doc: Document | undefined,
  onEmpty: () => void,
): SharedStreamHandle {
  const listeners = new Set<EventListener>();
  const crossTab = canCoordinateAcrossTabs();
  const channel = crossTab ? new BroadcastChannel(LOCK_AND_CHANNEL_NAME) : undefined;

  let disposed = false;
  let isLeader = false;
  let hasConnectedOnce = false;
  let cursor: ClientChannelCursor | undefined;
  let streamAbort: AbortController | undefined;
  let lockAbort: AbortController | undefined;
  let releaseLock: (() => void) | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = INITIAL_BACKOFF_MS;

  const emitExtensionsChanged = (revision: number, propagate: boolean): void => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener.onExtensionsChanged(revision);
      } catch {
        // Isolate subscriber errors.
      }
    }
    if (propagate && channel) {
      try {
        channel.postMessage({ type: "extensions-changed", revision } satisfies BroadcastPayload);
      } catch {
        // Ignore closed-channel races during teardown.
      }
    }
  };

  const emitReconnect = (propagate: boolean): void => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener.onReconnect?.();
      } catch {
        // Isolate subscriber errors.
      }
    }
    if (propagate && channel) {
      try {
        channel.postMessage({ type: "reconnect" } satisfies BroadcastPayload);
      } catch {
        // Ignore closed-channel races during teardown.
      }
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const abortStream = (): void => {
    streamAbort?.abort();
    streamAbort = undefined;
  };

  const scheduleReconnect = (): void => {
    clearReconnect();
    if (disposed || !isLeader || doc?.visibilityState === "hidden") return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (disposed || !isLeader || doc?.visibilityState === "hidden") return;
    abortStream();
    const controller = new AbortController();
    streamAbort = controller;

    const query =
      cursor !== undefined
        ? `?epoch=${encodeURIComponent(cursor.epoch)}&after=${encodeURIComponent(String(cursor.sequence))}`
        : "";

    try {
      const response = await fetch(`api/ch/v1/events${query}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/x-ndjson" },
        signal: controller.signal,
      });

      if (!response.ok || response.body === null) {
        scheduleReconnect();
        return;
      }

      backoffMs = INITIAL_BACKOFF_MS;
      if (hasConnectedOnce) {
        emitReconnect(true);
      }
      hasConnectedOnce = true;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || disposed || !isLeader || controller.signal.aborted) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              const parsed = clientChannelEventSchema.safeParse(JSON.parse(line));
              if (parsed.success) {
                const event = parsed.data;
                cursor = event.cursor;
                if (event.type === "extensions-changed") {
                  emitExtensionsChanged(event.revision, true);
                } else if (event.type === "hello" && event.reset) {
                  emitReconnect(true);
                }
              }
            } catch {
              // Ignore malformed heartbeat or non-JSON lines.
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
    } catch {
      // Transport drop or abort; reconnect below if still active leader.
    } finally {
      if (streamAbort === controller) {
        streamAbort = undefined;
      }
      if (!disposed && isLeader && !controller.signal.aborted) {
        scheduleReconnect();
      }
    }
  };

  const stopLeadership = (): void => {
    isLeader = false;
    clearReconnect();
    abortStream();
    lockAbort?.abort();
    lockAbort = undefined;
    const release = releaseLock;
    releaseLock = undefined;
    release?.();
  };

  const startLeadership = (): void => {
    if (disposed || doc?.visibilityState === "hidden") return;
    if (!crossTab) {
      if (isLeader) return;
      isLeader = true;
      backoffMs = INITIAL_BACKOFF_MS;
      void connect();
      return;
    }
    if (isLeader || lockAbort !== undefined) return;
    const controller = new AbortController();
    lockAbort = controller;
    void navigator.locks
      .request(LOCK_AND_CHANNEL_NAME, { signal: controller.signal }, async () => {
        if (disposed || controller.signal.aborted || doc?.visibilityState === "hidden") return;
        isLeader = true;
        backoffMs = INITIAL_BACKOFF_MS;
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
          // If this tab takes over leadership from another tab, resync subscribers.
          if (hasConnectedOnce) emitReconnect(false);
          void connect();
        });
      })
      .catch(() => {
        // Expected AbortError when tab hides or all subscribers disconnect before acquiring lock.
      })
      .finally(() => {
        if (lockAbort === controller) lockAbort = undefined;
      });
  };

  const onChannelMessage = (event: MessageEvent<unknown>): void => {
    if (disposed || isLeader) return;
    const payload = event.data as Partial<BroadcastPayload> | null | undefined;
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "extensions-changed" && typeof payload.revision === "number") {
      emitExtensionsChanged(payload.revision, false);
    } else if (payload.type === "reconnect") {
      emitReconnect(false);
    }
  };
  channel?.addEventListener("message", onChannelMessage);

  const onVisibilityChange = (): void => {
    if (disposed) return;
    if (doc?.visibilityState === "hidden") {
      stopLeadership();
      return;
    }
    // Resync local subscribers after returning from hidden state, then rejoin leader election.
    emitReconnect(false);
    startLeadership();
  };
  doc?.addEventListener("visibilitychange", onVisibilityChange);

  startLeadership();

  const destroy = (): void => {
    if (disposed) return;
    disposed = true;
    stopLeadership();
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
    onEmpty();
  };

  return {
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          destroy();
        }
      };
    },
  };
}

export function subscribeHostExtensionEvents(
  options: SubscribeHostExtensionEventsOptions,
): () => void {
  const { onExtensionsChanged, onReconnect } = options;
  const doc: StreamDocument | undefined = options.document;
  let shared = doc ? doc[STREAM_KEY] : fallbackStream;
  if (!shared) {
    shared = createSharedEventStream(doc, () => {
      if (doc) delete doc[STREAM_KEY];
      else fallbackStream = undefined;
    });
    if (doc) doc[STREAM_KEY] = shared;
    else fallbackStream = shared;
  }
  return shared.subscribe({ onExtensionsChanged, onReconnect });
}
