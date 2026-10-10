/**
 * Wire transport matching the DSH Connection protocol:
 * - unary RPC: `POST /api/<namespace>/<method>` with a `client-request` envelope;
 * - streams: one WebSocket at `/api/remote.mux` multiplexing logical streams.
 */

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: object = {},
  ) {
    super(message);
  }
}

export interface RpcContext {
  /** Connection-scoped identity, when the browser supplied one. */
  readonly method: string;
}

export type RpcHandler = (args: Record<string, unknown>, context: RpcContext) => unknown;

type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } };

export class RpcRegistry {
  private readonly handlers = new Map<string, RpcHandler>();
  /** Methods answered by a generic fallback; recorded so the console can list what is still missing. */
  readonly unhandled = new Map<string, number>();

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async dispatch(method: string, payload: unknown): Promise<RpcResult> {
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
      const value = await handler(args ?? {}, { method });
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
   * @returns the server-response envelope text.
   */
  async handleHttp(body: string): Promise<string> {
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
    const result = await this.dispatch(String(envelope.method ?? ""), envelope.payload);
    return JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result });
  }
}

/** One logical stream as seen by an endpoint handler. */
export interface StreamSink {
  readonly id: string;
  readonly closed: boolean;
  push(value: unknown): void;
  end(): void;
  fail(code: string, message: string): void;
  onClose(listener: () => void): void;
}

export type StreamHandler = (
  args: Record<string, unknown>,
  sink: StreamSink,
) => void | Promise<void>;

export class StreamRegistry {
  private readonly handlers = new Map<string, StreamHandler>();
  readonly unhandled = new Map<string, number>();

  register(endpoint: string, handler: StreamHandler): void {
    this.handlers.set(endpoint, handler);
  }

  /** Attach the mux protocol to one WebSocket. */
  attach(socket: WebSocket): void {
    const streams = new Map<string, { sink: StreamSink; close: () => void }>();
    const send = (message: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.on("message", (data) => {
      let message: { type?: string; streamId?: string; endpoint?: string; payload?: unknown };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      const streamId = String(message.streamId ?? "");
      if (message.type === "open") {
        const endpoint = String(message.endpoint ?? "");
        const listeners: Array<() => void> = [];
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          streams.delete(streamId);
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
          fail(code, errorMessage) {
            if (closed) return;
            send({ type: "error", streamId, error: { code, message: errorMessage, details: {} } });
            close();
          },
          onClose(listener) {
            if (closed) listener();
            else listeners.push(listener);
          },
        };
        streams.set(streamId, { sink, close });
        const handler = this.handlers.get(endpoint);
        if (handler === undefined) {
          this.unhandled.set(endpoint, (this.unhandled.get(endpoint) ?? 0) + 1);
          // Keep unknown streams open and silent: most DSH followers tolerate an idle stream better than an error.
          return;
        }
        const payload = message.payload as { args?: Record<string, unknown> } | undefined;
        Promise.resolve(handler(payload?.args ?? {}, sink)).catch((error: unknown) => {
          console.error(`[mux] ${endpoint} failed`, error);
          sink.fail("gateway/internal", error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (message.type === "cancel" || message.type === "end") {
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
