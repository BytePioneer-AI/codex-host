/**
 * Lightweight NDJSON event stream subscriber for `GET api/ch/v1/events`.
 *
 * Tracks the Host cursor `(epoch, sequence)` for seamless reconnects, pauses while the
 * document is hidden, and delivers `extensions-changed` notifications to listeners.
 */
import { clientChannelEventSchema, type ClientChannelCursor } from "@codexhost/shared-contracts";

export interface SubscribeHostExtensionEventsOptions {
  readonly document?: Document | undefined;
  readonly onExtensionsChanged: (revision: number) => void;
  readonly onReconnect?: (() => void) | undefined;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function subscribeHostExtensionEvents(
  options: SubscribeHostExtensionEventsOptions,
): () => void {
  const { document: doc, onExtensionsChanged, onReconnect } = options;

  let stopped = false;
  let cursor: ClientChannelCursor | undefined;
  let streamAbort: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = INITIAL_BACKOFF_MS;
  let hasConnectedOnce = false;

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
    if (stopped || doc?.visibilityState === "hidden") return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (stopped || doc?.visibilityState === "hidden") return;
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
        onReconnect?.();
      }
      hasConnectedOnce = true;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped || controller.signal.aborted) break;
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
                  onExtensionsChanged(event.revision);
                } else if (event.type === "hello" && event.reset) {
                  onReconnect?.();
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
      // Transport drop or abort; reconnect below if still active.
    } finally {
      if (streamAbort === controller) {
        streamAbort = undefined;
      }
      if (!stopped && !controller.signal.aborted) {
        scheduleReconnect();
      }
    }
  };

  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (doc?.visibilityState === "hidden") {
      clearReconnect();
      abortStream();
      return;
    }
    backoffMs = INITIAL_BACKOFF_MS;
    clearReconnect();
    void connect();
  };

  doc?.addEventListener("visibilitychange", onVisibilityChange);
  void connect();

  return () => {
    if (stopped) return;
    stopped = true;
    clearReconnect();
    abortStream();
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
