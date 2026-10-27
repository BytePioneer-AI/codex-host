import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import {
  DELEGATION_READ_METHOD,
  DELEGATION_SEND_METHOD,
  HOST_IDENTITY_METHOD,
  THREAD_BRIDGE_ATTACH_METHOD,
  THREAD_BRIDGE_READ_METHOD,
  THREAD_BRIDGE_SEND_METHOD,
  THREAD_BRIDGE_REPLY_METHOD,
  REMOTE_THREAD_READ_TIMEOUT_MS,
  REMOTE_THREAD_REPLY_MAX_BYTES,
  formatThreadReference,
  hostIdentitySchema,
  jsonValueSchema,
  threadBridgeReadSchema,
  threadBridgeSendSchema,
  threadSendOutcomeSchema,
  type ThreadBridgeReply,
  type ThreadReference,
} from "@codexhost/shared-contracts";
import type { RendererMessageTarget } from "./renderer-manual-compaction.js";
import { isUnsupportedMethod } from "./renderer-request-sender.js";

type Entry = { route: RendererHostRoute; machineId: string; sendSupported: boolean };

/** One bridge per window; every dispatch revalidates its native connection. */
export function createRendererThreadBridge(options: {
  routing(): RendererHostRouting | undefined;
  hostIds(): readonly string[];
  messages: RendererMessageTarget;
  clientId?: string;
}) {
  const clientId = options.clientId ?? crypto.randomUUID();
  const entries = new Map<string, Entry>();
  const unsupported = new WeakSet<RendererHostRoute>();
  const seen = new Set<string>(["local"]);
  const inFlight = new Set<string>();
  let disposed = false;
  let refreshing: Promise<void> | undefined;
  const current = (entry: Entry) =>
    !disposed && options.routing()?.forHost(entry.route.hostId) === entry.route;
  const request = async (entry: Entry, method: string, params: unknown) => {
    if (!current(entry)) throw new Error("Host connection is no longer available");
    return entry.route.manager.sendRequest(method, params, {
      priority:
        method === DELEGATION_READ_METHOD || method === DELEGATION_SEND_METHOD
          ? "interactive"
          : "background",
      timeoutMs:
        method === DELEGATION_READ_METHOD || method === DELEGATION_SEND_METHOD ? 30_000 : 8_000,
    });
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      for (const hostId of options.hostIds()) seen.add(hostId);
      for (const hostId of options.routing()?.knownHostIds?.() ?? []) seen.add(hostId);
      await Promise.all(
        [...seen].map(async (hostId) => {
          const route = options.routing()?.forHost(hostId);
          if (!route) {
            entries.delete(hostId);
            return;
          }
          if (unsupported.has(route)) return;
          if (entries.get(hostId)?.route === route) return;
          entries.delete(hostId);
          try {
            const identity = hostIdentitySchema.parse(
              await route.manager.sendRequest(
                HOST_IDENTITY_METHOD,
                {},
                { priority: "background", timeoutMs: 8_000 },
              ),
            );
            if (!disposed && options.routing()?.forHost(hostId) === route)
              entries.set(hostId, {
                route,
                machineId: identity.machineId,
                sendSupported: identity.sendSupported === true,
              });
          } catch (error) {
            if (isUnsupportedMethod(error, HOST_IDENTITY_METHOD)) unsupported.add(route);
            /* Older and disconnected Hosts cannot advertise a route. */
          }
        }),
      );
      const machineIds = [
        ...new Set([...entries.values()].filter(current).map((entry) => entry.machineId)),
      ];
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          try {
            const identity = hostIdentitySchema.parse(
              await request(entry, THREAD_BRIDGE_ATTACH_METHOD, {
                clientId,
                machineIds: machineIds.filter((id) => id !== entry.machineId),
                ...(entry.sendSupported
                  ? {
                      sendMachineIds: [
                        ...new Set(
                          [...entries.values()]
                            .filter(
                              (target) =>
                                current(target) &&
                                target.sendSupported &&
                                target.machineId !== entry.machineId,
                            )
                            .map((target) => target.machineId),
                        ),
                      ],
                    }
                  : {}),
              }),
            );
            if (identity.machineId !== entry.machineId) entries.delete(entry.route.hostId);
          } catch {
            /* Lease expiry removes an unreachable window. */
          }
        }),
      );
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const listener: Parameters<RendererMessageTarget["addEventListener"]>[1] = (event) => {
    if (disposed || (event.source != null && event.source !== options.messages)) return;
    const message = event.data as {
      type?: unknown;
      method?: unknown;
      hostId?: unknown;
      params?: unknown;
    } | null;
    if (
      message?.type !== "mcp-notification" ||
      (message.method !== THREAD_BRIDGE_READ_METHOD &&
        message.method !== THREAD_BRIDGE_SEND_METHOD) ||
      typeof message.hostId !== "string"
    )
      return;
    const mutation = message.method === THREAD_BRIDGE_SEND_METHOD;
    const parsed = mutation
      ? threadBridgeSendSchema.safeParse(message.params)
      : threadBridgeReadSchema.safeParse(message.params);
    const source = entries.get(message.hostId);
    if (!parsed.success || parsed.data.clientId !== clientId || !source || !current(source)) return;
    const read = parsed.data;
    const key = `${message.hostId}:${read.requestId}`;
    if (inFlight.has(key) || inFlight.size >= 64) return;
    inFlight.add(key);
    void (async () => {
      let reply: ThreadBridgeReply["reply"];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dispatched = false;
      try {
        const target = [...entries.values()].find(
          (entry) => entry.machineId === read.machineId && current(entry),
        );
        if (!target) throw new Error("Target machine is disconnected; reconnect it in Desktop");
        if (mutation && !target.sendSupported)
          throw new Error("Update the target Host before sending cross-machine messages");
        // Fixed target methods cannot forward again or form a loop.
        dispatched = true;
        const result = await Promise.race([
          request(target, mutation ? DELEGATION_SEND_METHOD : DELEGATION_READ_METHOD, {
            ...read.input,
            expectedMachineId: read.machineId,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Thread request timed out")),
              REMOTE_THREAD_READ_TIMEOUT_MS,
            );
          }),
        ]);
        if (!current(target)) throw new Error("Target connection changed during the request");
        const validated = { clientId, requestId: read.requestId, reply: { result } };
        if (
          new TextEncoder().encode(JSON.stringify(validated)).byteLength >
          REMOTE_THREAD_REPLY_MAX_BYTES
        )
          throw Object.assign(
            new Error("Thread reply exceeds 16 MiB; reduce the message page size"),
            { code: "RESPONSE_TOO_LARGE" },
          );
        // The Host validates the snapshot; JSON RPC has already serialized this value.
        const outcome = mutation ? threadSendOutcomeSchema.parse(result) : { result };
        reply = "error" in outcome ? outcome : { result: jsonValueSchema.parse(outcome.result) };
      } catch (error) {
        reply = {
          error: {
            code:
              mutation && dispatched
                ? "OUTCOME_UNKNOWN"
                : error instanceof Error && "code" in error && error.code === "RESPONSE_TOO_LARGE"
                  ? "RESPONSE_TOO_LARGE"
                  : "RUNTIME_UNREACHABLE",
            message:
              (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
              "Thread request failed",
          },
        };
      } finally {
        clearTimeout(timer);
      }
      await request(source, THREAD_BRIDGE_REPLY_METHOD, {
        clientId,
        requestId: read.requestId,
        reply,
      }).catch(() => undefined);
    })().finally(() => inFlight.delete(key));
  };
  options.messages.addEventListener("message", listener);
  return {
    refresh,
    async reference(threadId: string, hostId: string): Promise<string> {
      seen.add(hostId);
      await refresh();
      // A concurrent refresh may have taken its Host snapshot before this request.
      if (!entries.has(hostId)) await refresh();
      const entry = entries.get(hostId);
      if (!entry || !current(entry))
        throw new Error(
          "Update codexhost on this Host and reconnect before copying a cross-machine link",
        );
      return formatThreadReference({ threadId, hostId, machineId: entry.machineId });
    },
    async hostFor(reference: ThreadReference): Promise<string> {
      if (reference.hostId) seen.add(reference.hostId);
      await refresh();
      const entry = [...entries.values()].find(
        (entry) => entry.machineId === reference.machineId && current(entry),
      );
      if (!entry) throw new Error("The linked machine is not connected in this Desktop");
      return entry.route.hostId;
    },
    dispose() {
      disposed = true;
      entries.clear();
      options.messages.removeEventListener("message", listener);
    },
  };
}
