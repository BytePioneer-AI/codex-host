import { randomUUID } from "node:crypto";

interface ChangeWaiter {
  afterRevision: number;
  resolve(revision: number): void;
  timeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Opaque, per-Thread change clock used by compact status and wait-many.
 * Epoch changes when the Host Runtime process is replaced so stale cursors resync.
 */
export class ThreadChangeHub {
  readonly epoch: string;
  readonly #waiters = new Set<ChangeWaiter>();
  #revision = 0;

  constructor(epoch: string = randomUUID()) {
    this.epoch = epoch;
  }

  get revision(): number {
    return this.#revision;
  }

  bump(): number {
    this.#revision += 1;
    for (const waiter of [...this.#waiters]) {
      if (this.#revision <= waiter.afterRevision) continue;
      if (waiter.timeout) clearTimeout(waiter.timeout);
      this.#waiters.delete(waiter);
      waiter.resolve(this.#revision);
    }
    return this.#revision;
  }

  wait(afterRevision: number, timeoutMs: number): Promise<number> {
    if (this.#revision > afterRevision) return Promise.resolve(this.#revision);
    if (timeoutMs <= 0) return Promise.resolve(this.#revision);
    return new Promise((resolve) => {
      const waiter: ChangeWaiter = {
        afterRevision,
        resolve,
        timeout: setTimeout(() => {
          this.#waiters.delete(waiter);
          resolve(this.#revision);
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  close(): void {
    for (const waiter of this.#waiters) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(this.#revision);
    }
    this.#waiters.clear();
  }

  encode(input: { threadId: string; turnId: string | null; status: string }): string {
    const payload = JSON.stringify({
      version: 1,
      epoch: this.epoch,
      seq: this.#revision,
      threadId: input.threadId,
      turnId: input.turnId,
      status: input.status,
    });
    return `codexhost:thread-revision:v1:${Buffer.from(payload).toString("base64url")}`;
  }
}

export function decodeThreadRevision(
  threadId: string,
  revision: string | undefined,
): { epoch: string; seq: number; threadId: string } | { invalid: true } | undefined {
  if (revision === undefined) return undefined;
  const prefix = "codexhost:thread-revision:v1:";
  if (!revision.startsWith(prefix)) return { invalid: true };
  try {
    const value = JSON.parse(
      Buffer.from(revision.slice(prefix.length), "base64url").toString("utf8"),
    ) as {
      version?: unknown;
      epoch?: unknown;
      seq?: unknown;
      threadId?: unknown;
    };
    if (
      value.version !== 1 ||
      typeof value.epoch !== "string" ||
      !Number.isSafeInteger(value.seq) ||
      (value.seq as number) < 0 ||
      value.threadId !== threadId
    ) {
      return { invalid: true };
    }
    return { epoch: value.epoch, seq: value.seq as number, threadId };
  } catch {
    return { invalid: true };
  }
}
