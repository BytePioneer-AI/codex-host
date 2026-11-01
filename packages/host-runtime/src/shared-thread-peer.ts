import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  parseJsonFrame,
  readLfFrames,
  writeJsonFrame,
  type JsonObject,
  type JsonRpcId,
} from "@codexhost/protocol-core";

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Host-private RPC. Responses are per caller; events describe the one execution. */
export interface SharedThreadPeer {
  request(method: string, params: JsonObject): Promise<JsonObject>;
  respond(message: JsonObject): Promise<void>;
  subscribe(listener: (message: JsonObject) => void): () => void;
  readonly closed: Promise<void>;
  close(): void;
}

export class StreamThreadPeer implements SharedThreadPeer {
  readonly #prefix = `shared:${randomUUID()}:`;
  readonly #pending = new Map<
    string,
    {
      resolve(value: JsonObject): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly #listeners = new Set<(message: JsonObject) => void>();
  readonly #ended = Promise.withResolvers<undefined>();
  readonly closed = this.#ended.promise;
  #sequence = 0;
  #stopped = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly stop: () => void,
  ) {
    void this.#read()
      .catch(() => undefined)
      .finally(() => this.close());
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#stopped) throw new Error("Shared Thread Host is disconnected");
    const id = `${this.#prefix}${++this.#sequence}`;
    const result = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            "Shared Thread request timed out; outcome is unknown; do not retry automatically",
          ),
        );
      }, 120_000);
      this.#pending.set(id, { resolve, reject, timer });
    });
    // Attach the rejection handler before a write can yield or fail.
    void result.catch(() => undefined);
    try {
      await writeJsonFrame(this.output, { id, method, params });
      return await result;
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(id);
      throw error;
    }
  }

  respond(message: JsonObject): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("Shared Thread Host is disconnected"));
    return writeJsonFrame(this.output, message);
  }

  subscribe(listener: (message: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #read(): Promise<void> {
    for await (const frame of readLfFrames(this.input)) {
      const message = parseJsonFrame(frame);
      if (!object(message)) throw new Error("Invalid shared Thread response");
      if (typeof message.method !== "string") {
        const pending = typeof message.id === "string" ? this.#pending.get(message.id) : undefined;
        if (pending) {
          this.#pending.delete(String(message.id));
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
      } else {
        for (const listener of this.#listeners) listener(message);
      }
    }
  }

  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Shared Thread Host disconnected; request outcome may be unknown"));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.stop();
    this.#ended.resolve(undefined);
  }
}

export function rpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}
