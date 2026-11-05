import { THREAD_STEERING_CONTEXT_PARAM } from "@codexhost/shared-contracts";
import { prepareRpcSteeringQueue } from "./renderer-rpc-steering-queue.js";
import { inspectRendererSteeringDelivery } from "./renderer-steering-delivery.js";

type Method = (...args: unknown[]) => unknown;
type Rpc = Record<PropertyKey, unknown>;
interface Controller {
  forHost(hostId: string): Rpc;
}
interface Marker {
  expectedTurnId: string;
  clientUserMessageId: string;
  delivery: "newTurn" | "activeTurn";
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invoke = (target: Rpc, name: string, ...args: unknown[]) =>
  Reflect.apply(Reflect.get(target, name) as Method, target, args);
const running = (state: unknown): boolean =>
  record(state) && (state.inProgress === true || !!state.activeTurnId);
const context = (previous: unknown, marker: Marker) => ({
  ...(record(previous) ? previous : {}),
  [THREAD_STEERING_CONTEXT_PARAM]: { kind: "application", value: JSON.stringify(marker) },
});

/** Keep native preparation and submission in the main process. Adapt the
 * Renderer-owned RPC call/prepare boundary rather than rebuilding its Manager. */
export function installRendererRpcSteering(value: unknown): (() => void) | null {
  if (!record(value) || typeof value.forHost !== "function") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, "forHost");
  if (!descriptor?.writable) return null;
  const controller = value as unknown as Controller;
  const original = controller.forHost;
  const cached = new WeakMap<object, Rpc>();
  let disposed = false;
  const wrap = (rpc: Rpc, hostId: string, owner: Rpc = rpc): Rpc => {
    const existing = cached.get(rpc);
    if (existing) return existing;
    const current = () => {
      if (disposed || original.call(controller, hostId) !== owner)
        throw new Error("Steering connection was retired");
    };
    const inspect = async (threadId: string, input: unknown) => {
      const text = Array.isArray(input)
        ? input
            .filter(record)
            .map((item) => (typeof item.text === "string" ? item.text : ""))
            .join("\n")
        : "";
      current();
      const delivery = await inspectRendererSteeringDelivery(
        (method, params) => {
          current();
          return invoke(rpc, "sendRequest", method, params);
        },
        threadId,
        text,
      );
      current();
      return delivery;
    };
    const target = async (
      threadId: string,
      messageId: unknown,
      delivery: Marker["delivery"],
    ): Promise<Marker> => {
      const state = await invoke(rpc, "getThreadExecutionState", threadId);
      current();
      if (
        !record(state) ||
        typeof state.activeTurnId !== "string" ||
        !state.activeTurnId ||
        typeof messageId !== "string" ||
        !messageId
      )
        throw new Error("Native steering target or message identity is unavailable");
      return { expectedTurnId: state.activeTurnId, clientUserMessageId: messageId, delivery };
    };
    /** Stopping the old Turn outlasts native local acceptance's 250 ms queue-row delay, and its
     * interrupted terminal then marks that row paused. A replacement therefore submits directly:
     * nothing is listed in the queue, and a failed input stays in the Composer. Any doubt keeps
     * the native request, because preparation still decides and fails closed on its own. */
    const withoutQueueRow = async (request: unknown): Promise<unknown> => {
      if (
        !record(request) ||
        request.acceptLocally !== true ||
        typeof request.conversationId !== "string"
      )
        return request;
      try {
        const state = await invoke(rpc, "getThreadExecutionState", request.conversationId);
        current();
        if (!running(state)) return request;
        const message = request.message;
        const text = record(message) && typeof message.text === "string" ? message.text : "";
        const delivery = await inspect(request.conversationId, [{ text }]);
        return delivery === "newTurn" ? { ...request, acceptLocally: false } : request;
      } catch {
        return request;
      }
    };
    const coordinator = (remote: Rpc): Rpc =>
      new Proxy(remote, {
        get(handle, key) {
          if (key === "then") {
            const then = Reflect.get(handle, key);
            return typeof then === "function"
              ? (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
                  Reflect.apply(then, handle, [(value: Rpc) => resolve(coordinator(value)), reject])
              : then;
          }
          if (key === "dup") return () => coordinator(invoke(handle, "dup") as Rpc);
          if (key !== "sendMessage" && key !== "sendQueuedMessageNow")
            return Reflect.get(handle, key);
          return async (...args: unknown[]) => {
            current();
            const index = key === "sendMessage" ? 1 : 3;
            const callback = args[index];
            if (typeof callback !== "function")
              throw new Error("Native submission preparation is unavailable");
            let marker: Marker | null = null;
            let threadId: string | undefined;
            let messageId: string | undefined;
            let finish: Awaited<ReturnType<typeof prepareRpcSteeringQueue>> | undefined;
            const apply = (prepared: Record<string, unknown>) => {
              if (!marker || !record(prepared.steer)) return prepared;
              const result = {
                ...prepared,
                steer: {
                  ...prepared.steer,
                  additionalContext: context(prepared.steer.additionalContext, marker),
                },
              };
              if (marker.delivery !== "newTurn") return result;
              if (!record(prepared.start) || !record(prepared.start.request))
                throw new Error("Native start preparation is unavailable for steering");
              return {
                ...result,
                afterInactiveTurnId: marker.expectedTurnId,
                start: {
                  ...prepared.start,
                  request: {
                    ...prepared.start.request,
                    additionalContext: context(prepared.start.request.additionalContext, marker),
                  },
                },
              };
            };
            const prepare: Method = async (...input) => {
              current();
              const prepared: unknown = await callback(...input);
              current();
              if (!record(prepared)) throw new Error("Native submission preparation is malformed");
              if (marker) return apply(prepared);
              if (
                input[1] !== "steer" ||
                !record(prepared.steer) ||
                typeof prepared.conversationId !== "string"
              )
                return prepared;
              threadId = prepared.conversationId;
              // Native prepares in "steer" mode first even for an idle Thread, then asks
              // for start preparation. An idle Thread has nothing to steer, so stay out.
              const execution = await invoke(rpc, "getThreadExecutionState", threadId);
              current();
              if (!running(execution)) return prepared;
              const delivery = await inspect(threadId, prepared.steer.input);
              if (delivery === "official") return prepared;
              const restore = prepared.steer.restoreMessage;
              messageId =
                record(restore) && typeof restore.id === "string" ? restore.id : undefined;
              const clientId = prepared.steer.clientUserMessageId ?? messageId;
              marker = await target(threadId, clientId, delivery);
              if (delivery === "activeTurn") return apply(prepared);
              if (!messageId) throw new Error("Native queued message identity is unavailable");
              finish = await prepareRpcSteeringQueue(
                hostId,
                threadId,
                (name, ...values) => invoke(rpc, name, ...values),
                (name, ...values) => invoke(remote, name, ...values),
                messageId,
              );
              const start: unknown = await callback(input[0], "start");
              current();
              if (!record(start)) throw new Error("Native start preparation is malformed");
              return apply(start);
            };
            const forwarded = [...args];
            forwarded[index] = prepare;
            if (key === "sendMessage") forwarded[0] = await withoutQueueRow(args[0]);
            const result = await invoke(handle, key, ...forwarded);
            if (
              finish &&
              record(result) &&
              result.status === "sent" &&
              typeof result.turnId === "string"
            ) {
              // Cleanup must not report failure for an already-accepted submission.
              await finish(result.turnId).catch(() =>
                console.error("codexhost could not reconcile native steering queue"),
              );
            }
            return result;
          };
        },
      });
    const wrapped = new Proxy(rpc, {
      get(handle, key) {
        if (key === "then") {
          const then = Reflect.get(handle, key);
          return typeof then === "function"
            ? (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
                Reflect.apply(then, handle, [
                  (value: Rpc) => resolve(wrap(value, hostId, owner)),
                  reject,
                ])
            : then;
        }
        if (key === "dup") return () => wrap(invoke(handle, "dup") as Rpc, hostId, owner);
        if (key === "getTurnCoordinator")
          return () => {
            current();
            return coordinator(invoke(handle, "getTurnCoordinator") as Rpc);
          };
        return Reflect.get(handle, key);
      },
    });
    cached.set(rpc, wrapped);
    return wrapped;
  };
  const forHost = (hostId: string) => wrap(original.call(controller, hostId), hostId);
  controller.forHost = forHost;
  return () => {
    disposed = true;
    if (controller.forHost === forHost) Object.defineProperty(controller, "forHost", descriptor);
  };
}
