import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  delegationSendParamsSchema,
  threadSendOutcomeSchema,
  threadSendResultSchema,
  type DelegationSendParams,
  type ThreadSendOutcome,
} from "@codexhost/shared-contracts";
import { DelegationControlError, type ThreadSendResult } from "./delegation-types.js";

const receiptSchema = z.strictObject({
  fingerprint: z.string(),
  outcome: threadSendOutcomeSchema.optional(),
});
const unknownOutcome = (): ThreadSendOutcome => ({
  error: {
    code: "OUTCOME_UNKNOWN",
    message:
      "The send may have started. Read the target Thread before submitting a new request ID; repeating this ID never starts another Turn.",
  },
});

function failed(error: unknown): ThreadSendOutcome {
  if (
    error instanceof DelegationControlError &&
    (["INVALID_ARGUMENT", "THREAD_BUSY", "THREAD_NOT_FOUND"].includes(error.code) ||
      (error.code === "DELEGATION_FAILED" &&
        (error.details?.readOnly === true || error.details?.notStarted === true)))
  ) {
    return threadSendOutcomeSchema.parse({
      error: { code: error.code, message: error.message.slice(0, 4096) },
    });
  }
  return unknownOutcome();
}

/** Reserve before dispatch. Incomplete receipts survive Runtime restarts and never re-execute. */
export class ThreadSendReceipts {
  readonly #pending = new Map<
    string,
    { fingerprint: string; result: Promise<ThreadSendOutcome> }
  >();
  readonly #starting = new Set<string>();
  constructor(readonly directory: string) {}

  async execute(
    raw: DelegationSendParams,
    send: () => Promise<ThreadSendResult>,
  ): Promise<ThreadSendOutcome> {
    const input = delegationSendParamsSchema.parse(raw);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input.expectedMachineId, input.threadId, input.message]))
      .digest("hex");
    const pending = this.#pending.get(input.requestId);
    if (pending) return pending.fingerprint === fingerprint ? pending.result : this.#conflict();
    const result = this.#execute(input, fingerprint, send);
    this.#pending.set(input.requestId, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.#pending.delete(input.requestId);
    }
  }

  #conflict(): ThreadSendOutcome {
    return {
      error: {
        code: "INVALID_ARGUMENT",
        message: "Request ID was already used for a different Thread or message",
      },
    };
  }

  async #execute(
    input: DelegationSendParams,
    fingerprint: string,
    send: () => Promise<ThreadSendResult>,
  ): Promise<ThreadSendOutcome> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${input.requestId}.json`);
    const handle = await open(filename, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (!handle) {
      try {
        const receipt = receiptSchema.parse(JSON.parse(await readFile(filename, "utf8")));
        return receipt.fingerprint !== fingerprint
          ? this.#conflict()
          : (receipt.outcome ?? unknownOutcome());
      } catch {
        return unknownOutcome();
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ fingerprint }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    let outcome: ThreadSendOutcome;
    if (this.#starting.has(input.threadId)) {
      outcome = {
        error: { code: "THREAD_BUSY", message: "Another send is starting on this Thread" },
      };
    } else {
      this.#starting.add(input.threadId);
      try {
        const result = threadSendResultSchema.parse(await send());
        outcome = result.threadId === input.threadId ? { result } : unknownOutcome();
      } catch (error) {
        outcome = failed(error);
      } finally {
        this.#starting.delete(input.threadId);
      }
    }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const completed = await open(temporary, "wx", 0o600);
      try {
        await completed.writeFile(JSON.stringify({ fingerprint, outcome }));
        await completed.sync();
      } finally {
        await completed.close();
      }
      await rename(temporary, filename);
    } catch {
      return unknownOutcome();
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return outcome;
  }
}
