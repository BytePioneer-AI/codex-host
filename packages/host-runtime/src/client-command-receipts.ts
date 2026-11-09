import { createHash } from "node:crypto";
import type { ConsoleHostReply } from "./app-server-host.js";

/** Process-local retry receipts, not durable exactly-once execution. In-flight
 * entries cannot be evicted; unknown outcomes remain in the bounded window. */
interface Receipt {
  fingerprint: string;
  result: Promise<ConsoleHostReply>;
  settled: boolean;
  threadId: string | undefined;
  clientId: string | undefined;
  turnId: string | undefined;
}
export class ClientCommandReceipts {
  private entries = new Map<string, Receipt>();
  clientIdForTurn(threadId: string, turnId: string): string | undefined {
    for (const entry of this.entries.values())
      if (entry.threadId === threadId && entry.turnId === turnId) return entry.clientId;
    return undefined;
  }
  run(
    key: string,
    params: Record<string, unknown>,
    submit: () => Promise<ConsoleHostReply>,
  ): Promise<ConsoleHostReply> {
    const canonical = JSON.stringify(params, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, (value as Record<string, unknown>)[key]]),
          )
        : value,
    );
    const fingerprint = createHash("sha256").update(canonical).digest("hex");
    const existing = this.entries.get(key);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve({
            error: { code: -32602, message: "Message ID was already used with different input" },
          });
    if (this.entries.size >= 256) {
      const oldest = [...this.entries].find(([, entry]) => entry.settled)?.[0];
      if (oldest === undefined)
        return Promise.resolve({
          error: { code: -32090, message: "Too many pending client commands" },
        });
      this.entries.delete(oldest);
    }
    const result = Promise.resolve().then(submit);
    const entry: Receipt = {
      fingerprint,
      result,
      settled: false,
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      clientId:
        typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : undefined,
      turnId: undefined,
    };
    this.entries.set(key, entry);
    void result.then(
      (reply) => {
        entry.settled = true;
        if ("error" in reply && [-32602, -32072].includes(reply.error.code))
          this.entries.delete(key); // Validation/busy: definitely not submitted.
        if (
          "result" in reply &&
          reply.result &&
          typeof reply.result === "object" &&
          !Array.isArray(reply.result)
        ) {
          const turn = reply.result.turn;
          if (
            turn &&
            typeof turn === "object" &&
            !Array.isArray(turn) &&
            typeof turn.id === "string"
          )
            entry.turnId = turn.id;
        }
      },
      () => {
        entry.settled = true;
      },
    );
    return result;
  }
}
