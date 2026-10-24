import { randomUUID } from "node:crypto";
import {
  desktopThreadReadReplySchema,
  REMOTE_THREAD_READ_TIMEOUT_MS,
  REMOTE_THREAD_REPLY_MAX_BYTES,
  type DelegationReadParams,
} from "@codexhost/shared-contracts";
import { DelegationControlError, type DelegationThreadSnapshot } from "./delegation-types.js";

/** Pending reads belong only to this live connection; no Thread/source mapping is retained. */
export class DesktopThreadReader {
  readonly #pending = new Map<
    string,
    {
      threadId: string;
      resolve(value: DelegationThreadSnapshot): void;
      reject(error: unknown): void;
    }
  >();
  #closed = false;

  constructor(
    readonly notify: (params: { requestId: string; input: DelegationReadParams }) => Promise<void>,
  ) {}

  async read(input: DelegationReadParams): Promise<DelegationThreadSnapshot> {
    if (this.#closed)
      throw new DelegationControlError("RUNTIME_UNREACHABLE", "Desktop disconnected");
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<DelegationThreadSnapshot>();
    this.#pending.set(requestId, { threadId: input.threadId, resolve, reject });
    const timer = setTimeout(
      () =>
        reject(
          new DelegationControlError(
            "RUNTIME_UNREACHABLE",
            "Connected Desktop did not answer the Thread read; update both ends and reconnect",
          ),
        ),
      REMOTE_THREAD_READ_TIMEOUT_MS,
    );
    try {
      void this.notify({ requestId, input }).catch(() =>
        reject(
          new DelegationControlError(
            "RUNTIME_UNREACHABLE",
            "Desktop connection could not send the Thread read",
          ),
        ),
      );
      return await promise;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(requestId);
    }
  }

  reply(input: unknown): void {
    if (
      typeof input !== "object" ||
      input === null ||
      !("requestId" in input) ||
      typeof input.requestId !== "string"
    )
      return;
    const pending = this.#pending.get(input.requestId);
    if (!pending) return; // Late replies and replies from a different connection have no effect.
    this.#pending.delete(input.requestId);
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > REMOTE_THREAD_REPLY_MAX_BYTES) {
      pending.reject(
        new DelegationControlError(
          "RESPONSE_TOO_LARGE",
          "Desktop Thread reply exceeds the response byte limit",
        ),
      );
      return;
    }
    const parsed = desktopThreadReadReplySchema.safeParse(input);
    if (
      !parsed.success ||
      ("result" in parsed.data && parsed.data.result.threadId !== pending.threadId)
    ) {
      pending.reject(
        new DelegationControlError("INTERNAL_ERROR", "Desktop returned an invalid Thread snapshot"),
      );
    } else if ("error" in parsed.data) {
      pending.reject(new DelegationControlError(parsed.data.error.code, parsed.data.error.message));
    } else {
      // Wire JSON omits undefined optional fields; the schema validates the complete snapshot.
      pending.resolve(parsed.data.result as DelegationThreadSnapshot);
    }
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new DelegationControlError("RUNTIME_UNREACHABLE", "Desktop disconnected"));
    }
    this.#pending.clear();
  }
}
