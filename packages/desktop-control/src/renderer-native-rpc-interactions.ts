import type {
  NativeOwnedManager,
  NativeRpcLease,
  NativeRpcManager,
} from "./renderer-native-rpc-contracts.js";

/** Main-process managers consume server requests before window broadcasting.
 * Their interaction events identify the request; the native conversation holds
 * its authoritative payload. Subscribe once, including outstanding interactions
 * on reconnect, without polling or replaying turns. */
export function retainNativeRpcInteractions(
  upstream: NativeRpcManager,
  manager: NativeOwnedManager,
  hostId: string,
) {
  let disposed = false;
  const retained = new Set<NativeRpcLease>();
  const requests = new Map<string, Set<string | number>>();
  const reads = new Map<string, { promise: Promise<void>; dirty: boolean }>();
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  const read = (threadId: string): Promise<void> => {
    const existing = reads.get(threadId);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }
    const entry = { promise: Promise.resolve(), dirty: false };
    reads.set(threadId, entry);
    entry.promise = Promise.resolve()
      .then(async () => {
        do {
          if (disposed) break;
          entry.dirty = false;
          const pending = upstream.getConversation(threadId);
          retained.add(pending);
          try {
            const conversation = await pending;
            // An interaction can resolve while this snapshot is in flight. Wait
            // for the event-triggered fresh read before showing any stale prompt.
            if (
              disposed ||
              entry.dirty ||
              !record(conversation) ||
              !Array.isArray(conversation.requests)
            )
              continue;
            const previous = requests.get(threadId) ?? new Set();
            const next = new Set<string | number>();
            for (const request of conversation.requests) {
              if (
                !record(request) ||
                typeof request.method !== "string" ||
                !record(request.params) ||
                (request.params.threadId ?? request.params.conversationId) !== threadId ||
                (typeof request.id !== "string" && typeof request.id !== "number")
              )
                continue;
              next.add(request.id);
              if (!previous.has(request.id)) manager.onRequest(request);
            }
            if (next.size) requests.set(threadId, next);
            else requests.delete(threadId);
          } finally {
            if (retained.delete(pending)) pending[Symbol.dispose]();
          }
        } while (!disposed && entry.dirty);
      })
      .finally(() => {
        reads.delete(threadId);
      });
    return entry.promise;
  };
  const event = (value: unknown): void => {
    if (disposed || !record(value) || typeof value.conversationId !== "string") return;
    // A broken connection is retired by the service owner; it must not leave an
    // unhandled rejection in Desktop or trigger a request retry loop.
    void read(value.conversationId).catch(() => undefined);
  };
  const subscribe = (input: Parameters<NativeRpcManager["subscribe"]>[0]) => {
    const pending = upstream.subscribe(input);
    retained.add(pending);
    return Promise.resolve(pending).then((lease) => {
      if (disposed) lease[Symbol.dispose]();
      else retained.add(lease);
    });
  };
  const subscriptions = [
    "approval-request",
    "user-input-request",
    "mcp-elicitation-request",
    "approval-resolved",
  ].map((name) => subscribe({ type: "event", key: { hostId }, event: name, listener: event }));
  subscriptions.push(
    subscribe({
      type: "notification",
      key: { hostId },
      methods: ["serverRequest/resolved"],
      listener(value) {
        if (record(value) && record(value.params) && typeof value.params.threadId === "string")
          event({ conversationId: value.params.threadId });
      },
    }),
  );
  const ready = Promise.all(subscriptions).then(async () => {
    if (disposed) return;
    const pending = upstream.getWorkInProgress();
    retained.add(pending);
    try {
      const work = await pending;
      if (disposed) return;
      if (!Array.isArray(work)) throw new Error("Native RPC interaction snapshot is unavailable");
      const threadIds = new Set(
        work.flatMap((item: unknown) =>
          record(item) && typeof item.conversationId === "string" ? [item.conversationId] : [],
        ),
      );
      await Promise.all([...threadIds].map(read));
    } finally {
      if (retained.delete(pending)) pending[Symbol.dispose]();
    }
  });
  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const lease of retained) lease[Symbol.dispose]();
      retained.clear();
      requests.clear();
    },
  };
}
