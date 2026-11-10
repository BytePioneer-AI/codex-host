/**
 * Wire transport matching the DSH Connection protocol:
 * - unary RPC: `POST /api/<namespace>/<method>` with a `client-request` envelope;
 * - streams: one WebSocket at `/api/remote.mux` multiplexing logical streams.
 */

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  createDshStreamUplink,
  type DshStreamInput,
  type DshStreamUplink,
} from "@codexhost/dsh-web-backend/stream-input";

export { SessionRuntimeError as RpcError } from "@codexhost/session-runtime";
import { SessionRuntimeError as RpcError } from "@codexhost/session-runtime";
import type { RequestAuth } from "./auth.ts";
import { SessionListTiming } from "./session-list-timing.ts";

export interface RpcContext {
  readonly method: string;
  readonly relay: boolean;
  /** Per-request diagnostics for session/list; never shared between browser requests. */
  readonly sessionListTiming?: SessionListTiming;
  /** The HTTP request's authentication; absent with `--no-auth` and for in-process calls. */
  readonly auth?: RequestAuth;
  /** Run only after the HTTP response has been flushed (settings changes restart Web). */
  readonly afterResponse?: (callback: () => void) => void;
}

export type RpcHandler = (args: Record<string, unknown>, context: RpcContext) => unknown;

type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } };

export class RpcRegistry {
  private around?: (
    method: string,
    args: Record<string, unknown>,
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  /** Session ownership routing; authentication has already been checked by the HTTP gateway. */
  routeSessions(router: NonNullable<RpcRegistry["around"]>): void {
    this.around = router;
  }
  private readonly handlers = new Map<string, RpcHandler>();
  /** Methods answered by a generic fallback; recorded so the console can list what is still missing. */
  readonly unhandled = new Map<string, number>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async dispatch(
    method: string,
    payload: unknown,
    auth?: RequestAuth,
    afterResponse?: RpcContext["afterResponse"],
    relay = false,
    sessionListTiming?: SessionListTiming,
  ): Promise<RpcResult> {
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      this.unhandled.set(method, (this.unhandled.get(method) ?? 0) + 1);
      return {
        ok: false,
        error: {
          code: "gateway/not-found",
          message: `codexhost: no handler for ${method}`,
          details: {},
        },
      };
    }
    const args = (
      typeof payload === "object" && payload !== null && "args" in payload
        ? (payload as { args: unknown }).args
        : {}
    ) as Record<string, unknown>;
    try {
      const next = async () =>
        handler(args ?? {}, {
          method,
          relay,
          ...(sessionListTiming === undefined ? {} : { sessionListTiming }),
          ...(auth === undefined ? {} : { auth }),
          ...(afterResponse === undefined ? {} : { afterResponse }),
        });
      const value = this.around ? await this.around(method, args ?? {}, next) : await next();
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      if (error instanceof RpcError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        };
      }
      console.error(`[rpc] ${method} failed`, error);
      return {
        ok: false,
        error: {
          code: "gateway/internal",
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      };
    }
  }

  /**
   * Handle one HTTP request body.
   * @param body - raw JSON text of the client-request envelope.
   * @param auth - the request's authentication, passed to the handler.
   * @returns the server-response envelope text.
   */
  async handleHttp(
    body: string,
    auth?: RequestAuth,
    afterResponse?: RpcContext["afterResponse"],
    relay = false,
    onSessionListTiming?: (timing: SessionListTiming, ok: boolean) => void,
  ): Promise<string> {
    let envelope: { type?: string; rpcId?: string; method?: string; payload?: unknown };
    try {
      envelope = JSON.parse(body) as typeof envelope;
    } catch {
      return JSON.stringify({
        type: "server-response",
        rpcId: "",
        result: {
          ok: false,
          error: { code: "gateway/invalid", message: "invalid JSON", details: {} },
        },
      });
    }
    const timing =
      envelope.method === "session/list"
        ? new SessionListTiming(typeof envelope.rpcId === "string" ? envelope.rpcId : undefined)
        : undefined;
    const result = await this.dispatch(
      String(envelope.method ?? ""),
      envelope.payload,
      auth,
      afterResponse,
      relay,
      timing,
    );
    const serialize = () => {
      const reply = JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result });
      if (timing) timing.responseBytes = Buffer.byteLength(reply);
      return reply;
    };
    let reply: string;
    try {
      reply = timing ? timing.measureSync("serialize", serialize) : serialize();
    } catch (error) {
      timing?.report(false);
      throw error;
    }
    if (timing) {
      if (onSessionListTiming) onSessionListTiming(timing, result.ok);
      else timing.report(result.ok);
    }
    return reply;
  }
}

/** One logical stream as seen by an endpoint handler. */
export interface StreamSink {
  readonly id: string;
  /** Set by the accepted physical connection, never by a logical open payload. */
  readonly relay?: boolean;
  readonly closed: boolean;
  /** Physical mux input; absent on output-only in-process test/application sinks. */
  readonly input?: DshStreamInput;
  push(value: unknown): void;
  end(): void;
  fail(code: string, message: string, details?: object): void;
  onClose(listener: () => void): void;
}

export type StreamHandler = (
  args: Record<string, unknown>,
  sink: StreamSink,
) => void | Promise<void>;

/** Fallback owner for a stream no Web endpoint registered: the embedded DSH gateway. */
export type StreamFallback = (
  endpoint: string,
  args: Record<string, unknown>,
  sink: StreamSink,
) => boolean;

export class StreamRegistry {
  private sessionRouter?: (
    endpoint: string,
    args: Record<string, unknown>,
    sink: StreamSink,
    next: (sink: StreamSink) => Promise<void>,
  ) => boolean | Promise<boolean>;
  routeSessions(router: NonNullable<StreamRegistry["sessionRouter"]>): void {
    this.sessionRouter = router;
  }
  private readonly handlers = new Map<string, StreamHandler>();
  private fallback: StreamFallback | undefined;
  readonly unhandled = new Map<string, number>();

  register(endpoint: string, handler: StreamHandler): void {
    this.handlers.set(endpoint, handler);
  }

  /** Install the owner consulted for endpoints this registry does not register. */
  setFallback(fallback: StreamFallback): void {
    this.fallback = fallback;
  }

  /** Attach the mux protocol to one WebSocket. */
  attach(socket: WebSocket, relay = false): void {
    const inputBytes = 256 * 1024;
    const streams = new Map<
      string,
      { sink: StreamSink; inbox: DshStreamUplink; close: () => void }
    >();
    const send = (message: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.on("message", (data) => {
      let message: {
        type?: string;
        streamId?: string;
        endpoint?: string;
        payload?: unknown;
        value?: unknown;
      };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const streamId = String(message.streamId ?? "");
      if (message.type === "ping") {
        if (typeof message.streamId === "string" && message.streamId.length > 0)
          send({ type: "pong", streamId: message.streamId });
        return;
      }
      if (message.type === "open") {
        if (streams.has(streamId)) {
          streams.get(streamId)?.sink.fail("gateway/protocol", "Duplicate stream identity");
          return;
        }
        const endpoint = String(message.endpoint ?? "");
        const inbox = createDshStreamUplink(inputBytes, endpoint, (failure) => {
          sink.fail(failure.code, failure.message, failure.details);
        });
        const listeners: Array<() => void> = [];
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          streams.delete(streamId);
          void inbox.return();
          for (const listener of listeners.splice(0)) {
            try {
              listener();
            } catch (error) {
              console.error("[mux] close listener failed", error);
            }
          }
        };
        const sink: StreamSink = {
          id: streamId,
          relay,
          input: {
            items: inbox,
            window: {
              maxBytes: inputBytes,
              frameOverheadBytes:
                Buffer.byteLength(JSON.stringify({ type: "item", streamId, value: null }), "utf8") -
                "null".length,
            },
          },
          get closed() {
            return closed;
          },
          push(value) {
            if (!closed) send({ type: "item", streamId, value });
          },
          end() {
            if (closed) return;
            send({ type: "end", streamId });
            close();
          },
          fail(code, errorMessage, details = {}) {
            if (closed) return;
            send({ type: "error", streamId, error: { code, message: errorMessage, details } });
            close();
          },
          onClose(listener) {
            if (closed) listener();
            else listeners.push(listener);
          },
        };
        streams.set(streamId, { sink, inbox, close });
        const payload = message.payload as { args?: Record<string, unknown> } | undefined;
        const args = payload?.args ?? {};
        const handler = this.handlers.get(endpoint);
        if (handler === undefined) {
          if (this.fallback?.(endpoint, args, sink) === true) return;
          this.unhandled.set(endpoint, (this.unhandled.get(endpoint) ?? 0) + 1);
          // Keep unknown streams open and silent: most DSH followers tolerate an idle stream better than an error.
          return;
        }
        Promise.resolve()
          .then(async () => {
            if (
              await this.sessionRouter?.(endpoint, args, sink, async (forward) =>
                handler(args, forward),
              )
            )
              return;
            await handler(args, sink);
          })
          .catch((error: unknown) => {
            console.error(`[mux] ${endpoint} failed`, error);
            sink.fail("gateway/internal", error instanceof Error ? error.message : String(error));
          });
        return;
      }
      if (message.type === "item") {
        streams.get(streamId)?.inbox.push(message.value, Buffer.byteLength(String(data), "utf8"));
      } else if (message.type === "end") {
        // Client end half-closes input; output can still drain and acknowledge it.
        streams.get(streamId)?.inbox.end();
      } else if (message.type === "cancel") {
        streams.get(streamId)?.close();
      }
    });
    socket.on("close", () => {
      for (const stream of [...streams.values()]) stream.close();
    });
  }
}

interface PendingWaterfall {
  event: string;
  eventId: string;
  agentId: string;
  request: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  delegatedBy: Set<string>;
}

/**
 * Application events delivered through the `$events` stream, plus Host-to-Client waterfalls
 * (approvals, questions) answered through the `$events/result` RPC.
 *
 * Pending waterfalls survive disconnects: every new client generation receives all of them, so a
 * phone that reconnects after backgrounding still sees the approval its agent is waiting on.
 */
export class EventHub {
  private readonly sinks = new Map<string, StreamSink>();
  private readonly pending = new Map<string, PendingWaterfall>();

  constructor(private readonly home: string) {}

  handler: StreamHandler = (_args, sink) => {
    const clientId = randomUUID();
    this.sinks.set(clientId, sink);
    sink.onClose(() => this.sinks.delete(clientId));
    sink.push({ type: "ready", clientId, host: { home: this.home } });
    for (const waterfall of this.pending.values()) sink.push(this.frameOf(waterfall));
  };

  emit(event: string, ...args: unknown[]): void {
    for (const sink of this.sinks.values()) sink.push({ type: "emit", event, args });
  }

  private frameOf(waterfall: PendingWaterfall): unknown {
    return {
      type: "waterfall",
      event: waterfall.event,
      eventId: waterfall.eventId,
      agentId: waterfall.agentId,
      request: waterfall.request,
    };
  }

  /**
   * Ask connected (and future) clients to answer one scoped request.
   * @returns the answer value plus a cancel function that withdraws the request.
   */
  invoke(
    event: string,
    agentId: string,
    request: Record<string, unknown>,
  ): { result: Promise<unknown>; cancel: () => void; eventId: string } {
    const eventId = randomUUID();
    const completion = Promise.withResolvers<unknown>();
    const waterfall: PendingWaterfall = {
      event,
      eventId,
      agentId,
      request,
      resolve: completion.resolve,
      reject: completion.reject,
      delegatedBy: new Set(),
    };
    this.pending.set(eventId, waterfall);
    const frame = this.frameOf(waterfall);
    for (const sink of this.sinks.values()) sink.push(frame);
    const cancel = (): void => {
      if (!this.pending.delete(eventId)) return;
      for (const sink of this.sinks.values()) sink.push({ type: "cancel", eventId });
      completion.reject(new Error("cancelled"));
    };
    return { result: completion.promise, cancel, eventId };
  }

  /** Handle one `$events/result` RPC. */
  settle(value: {
    clientId?: string;
    eventId?: string;
    outcome?: { kind?: string; value?: unknown; error?: { message?: string } };
  }): null {
    const waterfall = this.pending.get(String(value.eventId ?? ""));
    if (waterfall === undefined) return null;
    const outcome = value.outcome;
    if (outcome?.kind === "next") {
      waterfall.delegatedBy.add(String(value.clientId ?? ""));
      return null;
    }
    this.pending.delete(waterfall.eventId);
    for (const [clientId, sink] of this.sinks) {
      if (clientId !== value.clientId) sink.push({ type: "cancel", eventId: waterfall.eventId });
    }
    if (outcome?.kind === "rejected")
      waterfall.reject(new Error(outcome.error?.message ?? "rejected"));
    else waterfall.resolve(outcome?.value);
    return null;
  }
}
