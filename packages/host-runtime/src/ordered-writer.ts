import type { Writable } from "node:stream";
import {
  writeFrame,
  writeJsonFrame,
  type JsonObject,
  type JsonValue,
} from "@codexhost/protocol-core";

const TEXT_DELTAS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
]);
const MAX_DELTA_LENGTH = 64 * 1024;
const MAX_QUEUED_BATCHES = 4;

function deltaIdentity(value: JsonValue): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || "id" in value) return null;
  if (typeof value.method !== "string" || !TEXT_DELTAS.has(value.method)) return null;
  const params = value.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  if (
    typeof params.delta !== "string" ||
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string"
  )
    return null;
  // Include every non-text field, including reasoning indices and envelope
  // extensions. Unknown native metadata must never be merged away.
  return JSON.stringify({ ...value, params: { ...params, delta: "" } });
}

/** Batches adjacent native text deltas; every other write is an ordering barrier. */
export class OrderedWriter {
  #tail = Promise.resolve();
  #pending: { identity: string; value: JsonObject; length: number; parts: string[] } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queuedBatches = 0;

  constructor(
    private readonly stream: Writable,
    private readonly intercept: (value: JsonValue) => boolean = () => false,
    private readonly batchMs = 16,
    private readonly diagnose: (error: unknown) => void = () => undefined,
  ) {}

  frame(frame: Buffer<ArrayBufferLike>, value?: JsonValue): Promise<void> {
    if (this.#queuedBatches >= MAX_QUEUED_BATCHES)
      return this.#tail.then(() => this.frame(frame, value));
    const identity = this.batchMs > 0 && value !== undefined ? deltaIdentity(value) : null;
    if (identity && value && typeof value === "object" && !Array.isArray(value)) {
      const params = value.params as JsonObject;
      const delta = params.delta as string;
      if (
        this.#pending?.identity !== identity ||
        this.#pending.length + delta.length > MAX_DELTA_LENGTH
      ) {
        this.#flush();
        if (this.#queuedBatches >= MAX_QUEUED_BATCHES)
          return this.#tail.then(() => this.frame(frame, value));
      }
      if (!this.#pending) {
        this.#pending = { identity, value, length: 0, parts: [] };
        this.#timer = setTimeout(() => {
          void this.#flush().catch(this.diagnose);
        }, this.batchMs);
      }
      this.#pending.parts.push(delta);
      this.#pending.length += delta.length;
      if (this.#pending.length >= MAX_DELTA_LENGTH) return this.#flush();
      // Do not await the timer: native output delivery is sequential. Waiting
      // here would prevent the next delta from joining this batch.
      return Promise.resolve();
    }
    this.#flush();
    return this.#enqueue(() => writeFrame(this.stream, frame));
  }

  json(value: JsonValue): Promise<void> {
    this.#flush();
    if (this.intercept(value)) return Promise.resolve();
    return this.#enqueue(() => writeJsonFrame(this.stream, value));
  }

  async drain(): Promise<void> {
    await this.#flush();
    await this.#tail;
  }

  #flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return this.#tail;
    const value = {
      ...pending.value,
      params: { ...(pending.value.params as JsonObject), delta: pending.parts.join("") },
    };
    this.#queuedBatches++;
    return this.#enqueue(async () => {
      try {
        await writeJsonFrame(this.stream, value);
      } finally {
        this.#queuedBatches--;
      }
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(this.diagnose);
    return next;
  }
}
