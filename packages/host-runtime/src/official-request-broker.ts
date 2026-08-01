import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

const INTERNAL_REQUEST_PREFIX = "codexhost:official:";
const MAX_RETIRED_IDS = 1_024;

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OfficialRequestBroker {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #retired = new Set<string>();
  readonly #retiredOrder: string[] = [];
  readonly #send: (request: JsonObject) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #nextId: () => string;

  constructor(input: {
    send(request: JsonObject): Promise<void>;
    timeoutMs?: number;
    nextId?: () => string;
  }) {
    this.#send = input.send;
    this.#timeoutMs = input.timeoutMs ?? 30_000;
    this.#nextId = input.nextId ?? (() => `${INTERNAL_REQUEST_PREFIX}${randomUUID()}`);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.#nextId();
    if (!id.startsWith(INTERNAL_REQUEST_PREFIX) || this.#pending.has(id) || this.#retired.has(id)) {
      return Promise.reject(new Error("Official internal request ID is invalid or duplicated"));
    }
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        this.#retire(id);
        pending.reject(new Error("Official internal request timed out"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      void this.#send({ id, method, params }).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        this.#retire(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  handle(value: JsonValue): boolean {
    if (!isRecord(value) || typeof value.id !== "string") return false;
    const pending = this.#pending.get(value.id);
    if (!pending) return this.#retired.has(value.id);
    clearTimeout(pending.timeout);
    this.#pending.delete(value.id);
    this.#retire(value.id);
    pending.resolve(value);
    return true;
  }

  failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#retire(id);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #retire(id: string): void {
    if (this.#retired.has(id)) return;
    this.#retired.add(id);
    this.#retiredOrder.push(id);
    if (this.#retiredOrder.length > MAX_RETIRED_IDS) {
      const expired = this.#retiredOrder.shift();
      if (expired) this.#retired.delete(expired);
    }
  }
}
