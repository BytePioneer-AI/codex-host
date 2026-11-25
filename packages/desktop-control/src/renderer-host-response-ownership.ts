interface NativeResponseClient {
  addRequestLifecycleListener?(listener: (event: unknown) => void): () => void;
  onResult(id: unknown, result: unknown, metrics?: unknown): void;
  onError(id: unknown, error: unknown, metrics?: unknown): void;
}

interface NativeResponseTarget {
  location?: { origin: string };
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

/** Self-contained for Renderer injection. Desktop dispatches replies by current
 * Host Client, which can change after a request was sent. Keep only the IDs of
 * Host requests started by this Client and complete them through its native API.
 * No dispatch, replay, transaction interpretation or replacement Promise. */
export function retainRendererHostResponses(
  client: NativeResponseClient,
  hostId: string,
  target: NativeResponseTarget,
): () => void {
  if (
    typeof client.addRequestLifecycleListener !== "function" ||
    typeof target.addEventListener !== "function" ||
    typeof target.removeEventListener !== "function"
  )
    return () => {};

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const pending = new Set<string | number>();
  let retired = false;
  let unsubscribe = (): void => {};
  const detach = (): void => {
    target.removeEventListener?.("message", receive);
    unsubscribe();
  };
  const receive = (event: Event): void => {
    const { source, origin, data } = event as Event & {
      source?: unknown;
      origin?: unknown;
      data?: unknown;
    };
    // Match Desktop's native window-message trust boundary: reject iframe/other
    // window senders and mismatched non-opaque origins, while allowing preload.
    if (source != null && source !== target) return;
    const ownOrigin = target.location?.origin;
    if (source === target && ownOrigin && ownOrigin !== "null" && origin !== ownOrigin) return;
    if (!isRecord(data) || data.type !== "mcp-response" || data.hostId !== hostId) return;
    const message = data.message;
    if (!isRecord(message)) return;
    const id = message.id;
    if ((typeof id !== "string" && typeof id !== "number") || !pending.has(id)) return;
    const hasError = isRecord(message.error);
    if (!hasError && !Object.prototype.hasOwnProperty.call(message, "result")) return;
    // Native message-bus and window listeners get first delivery. Their lifecycle
    // completion removes the ID; only a reply orphaned by Client replacement is
    // delivered here. Never complete a normally routed request twice.
    queueMicrotask(() => {
      if (!pending.has(id)) return;
      if (hasError) client.onError(id, message.error, data.hostMetrics);
      else client.onResult(id, message.result, data.hostMetrics);
    });
  };
  target.addEventListener("message", receive);
  unsubscribe = client.addRequestLifecycleListener((event) => {
    if (!isRecord(event) || event.hostId !== hostId) return;
    const id = event.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    if (
      !retired &&
      event.type === "started" &&
      typeof event.method === "string" &&
      event.method.startsWith("codexhost/")
    )
      pending.add(id);
    else if (event.type === "completed" || event.type === "failed") {
      pending.delete(id);
      if (retired && pending.size === 0) detach();
    }
  });
  return () => {
    // Retirement changes future routing, not ownership of outstanding replies.
    retired = true;
    if (pending.size === 0) detach();
  };
}
