import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  jsonRpcRequestSchema,
  parseJsonFrame,
  readLfFrames,
  writeJsonFrame,
  type JsonObject,
  type JsonRpcId,
} from "@codexhost/protocol-core";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import { object, rpcId, StreamThreadPeer, type SharedThreadPeer } from "./shared-thread-peer.js";

/** One AppServerHost owns every external Session, independent of GUI connections. */
export class SharedThreadOwner {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly #peer = new StreamThreadPeer(this.output, this.input, () => this.input.end());
  readonly #prefix = `shared-interaction:${randomUUID()}:`;
  readonly #interactions = new Map<string, { nativeId: JsonRpcId; message: JsonObject }>();
  readonly #listeners = new Set<(message: JsonObject) => void>();
  readonly #receipts = new Map<string, { fingerprint: string; result: Promise<JsonObject> }>();

  constructor() {
    this.#peer.subscribe((message) => {
      let event = message;
      if (rpcId(message.id)) {
        const id = `${this.#prefix}${message.id}`;
        event = { ...message, id };
        this.#interactions.set(id, { nativeId: message.id, message: event });
      } else if (message.method === "serverRequest/resolved" && object(message.params)) {
        const id = `${this.#prefix}${message.params.requestId}`;
        this.#interactions.delete(id);
        event = { ...message, params: { ...message.params, requestId: id } };
      }
      for (const listener of this.#listeners) listener(event);
    });
  }

  #request(method: string, params: JsonObject): Promise<JsonObject> {
    const key =
      method === "turn/start" && typeof params.clientUserMessageId === "string"
        ? `${params.threadId}\u0000${params.clientUserMessageId}`
        : null;
    if (!key) return this.#peer.request(method, params);
    const fingerprint = JSON.stringify(params);
    const existing = this.#receipts.get(key);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({
            error: { code: -32602, message: "Message ID was already used with different input" },
          });
    const result = this.#peer.request(method, params);
    this.#receipts.set(key, { fingerprint, result });
    void result.then(
      (reply) => {
        if (reply.error) this.#receipts.delete(key);
        while (this.#receipts.size > 256) {
          const oldest = this.#receipts.keys().next().value;
          if (oldest === undefined) break;
          this.#receipts.delete(oldest);
        }
      },
      () => this.#receipts.delete(key),
    );
    return result;
  }

  connect(): SharedThreadPeer {
    const ended = Promise.withResolvers<undefined>();
    const listeners = new Set<(message: JsonObject) => void>();
    let closed = false;
    const publish = (message: JsonObject): void => {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          peer.close();
        }
      }
    };
    this.#listeners.add(publish);
    const peer: SharedThreadPeer = {
      closed: ended.promise,
      request: (method, params) =>
        closed
          ? Promise.reject(new Error("Shared Thread client is closed"))
          : this.#request(method, params),
      respond: async (message) => {
        if (closed || typeof message.id !== "string") return;
        const pending = this.#interactions.get(message.id);
        if (!pending) return; // First answer wins, including simultaneous answers.
        // The owner's sequential input loop validates the answer, consumes
        // the interaction once and broadcasts serverRequest/resolved.
        await this.#peer.respond({ ...message, id: pending.nativeId });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        for (const { message } of this.#interactions.values()) listener(message);
        return () => listeners.delete(listener);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#listeners.delete(publish);
        listeners.clear();
        ended.resolve(undefined);
      },
    };
    void this.#peer.closed.then(() => peer.close());
    return peer;
  }

  /** Socket disconnect detaches a viewer; it never closes the owner or cancels work. */
  createSession(streams: RemoteAppServerSessionStreams): RemoteAppServerSession {
    const peer = this.connect();
    let detached = false;
    const send = (message: JsonObject): void => {
      if (detached || streams.output.destroyed) return;
      // Detach if the session's output stream stops draining.
      if (streams.output.writableLength > 8 * 1024 * 1024) {
        peer.close();
        streams.input.destroy();
        return;
      }
      void writeJsonFrame(streams.output, message).catch(() => peer.close());
    };
    const unsubscribe = peer.subscribe(send);
    return {
      run: async () => {
        try {
          for await (const frame of readLfFrames(streams.input, {
            maxFrameBytes: 128 * 1024 * 1024,
          })) {
            const message = parseJsonFrame(frame);
            const parsed = jsonRpcRequestSchema.safeParse(message);
            if (parsed.success) {
              const request = parsed.data;
              void peer.request(request.method, object(request.params) ? request.params : {}).then(
                (reply) => send({ ...reply, id: request.id }),
                () =>
                  send({
                    id: request.id,
                    error: {
                      code: -32090,
                      message: "Shared Thread Host disconnected; outcome may be unknown",
                    },
                  }),
              );
            } else if (object(message) && rpcId(message.id)) {
              await peer.respond(message);
            }
          }
          return 0;
        } catch (error) {
          // A viewer disconnect intentionally destroys only this transport input.
          // Node's async stream iterator reports that as ERR_STREAM_PREMATURE_CLOSE;
          // it is not a Harness/session failure and must not surface as a daemon error.
          if (detached) return 0;
          throw error;
        } finally {
          detached = true;
          unsubscribe();
          peer.close();
        }
      },
      disconnect: () => {
        detached = true;
        streams.input.destroy();
      },
      close: () => {
        detached = true;
        peer.close();
        streams.input.destroy();
      },
    };
  }

  close(): void {
    this.#peer.close();
    this.#receipts.clear();
    this.#interactions.clear();
  }
}
