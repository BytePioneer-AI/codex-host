import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  delegationSendParamsSchema,
  threadManagementParamsSchema,
  threadManagementOutcomeSchema,
  threadManagementResultSchema,
  type ThreadManagementParams,
  type ThreadManagementResult,
  type ThreadManagementOutcome,
  threadSendOutcomeSchema,
  threadSendResultSchema,
  type DelegationSendParams,
  type ThreadSendOutcome,
} from "@codexhost/shared-contracts";
import { DelegationControlError, type ThreadSendResult } from "./delegation-types.js";

type Outcome = ThreadSendOutcome | ThreadManagementOutcome;
const outcomeSchema = z.union([threadSendOutcomeSchema, threadManagementOutcomeSchema]);
const receiptSchema = z.strictObject({
  fingerprint: z.string(),
  outcome: outcomeSchema.optional(),
});
const unknownOutcome = (): ThreadSendOutcome => ({
  error: {
    code: "OUTCOME_UNKNOWN",
    message:
      "The operation may have started. Inspect the target or repeat the same request ID to recover its receipt; repeating this ID never re-executes it.",
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
  readonly #pending = new Map<string, { fingerprint: string; result: Promise<Outcome> }>();
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
    return threadSendOutcomeSchema.parse(
      await this.#reserve(input.requestId, input.threadId, fingerprint, async () => {
        const result = threadSendResultSchema.parse(await send());
        return result.threadId === input.threadId ? { result } : unknownOutcome();
      }),
    );
  }

  async manage(
    raw: ThreadManagementParams,
    run: () => Promise<ThreadManagementResult>,
  ): Promise<ThreadManagementOutcome> {
    const input = threadManagementParamsSchema.parse(raw);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(["manage", input.expectedMachineId, input.action]))
      .digest("hex");
    return threadManagementOutcomeSchema.parse(
      await this.#reserve(
        input.requestId,
        "threadId" in input.action ? input.action.threadId : undefined,
        fingerprint,
        async () => {
          const result = threadManagementResultSchema.parse(await run());
          return result.operation === input.action.operation &&
            (!("threadId" in input.action) || result.threadId === input.action.threadId)
            ? { result }
            : unknownOutcome();
        },
      ),
    );
  }

  async #reserve(
    requestId: string,
    threadId: string | undefined,
    fingerprint: string,
    run: () => Promise<Outcome>,
  ): Promise<Outcome> {
    const pending = this.#pending.get(requestId);
    if (pending) return pending.fingerprint === fingerprint ? pending.result : this.#conflict();
    const result = this.#execute({ requestId, threadId }, fingerprint, run);
    this.#pending.set(requestId, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.#pending.delete(requestId);
    }
  }

  #conflict(): ThreadSendOutcome {
    return {
      error: {
        code: "INVALID_ARGUMENT",
        message: "Request ID was already used for a different Thread, message, or operation",
      },
    };
  }

  async #execute(
    input: { requestId: string; threadId: string | undefined },
    fingerprint: string,
    run: () => Promise<Outcome>,
  ): Promise<Outcome> {
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
    let outcome: Outcome;
    if (input.threadId && this.#starting.has(input.threadId)) {
      outcome = {
        error: { code: "THREAD_BUSY", message: "Another send is starting on this Thread" },
      };
    } else {
      if (input.threadId) this.#starting.add(input.threadId);
      try {
        outcome = await run();
      } catch (error) {
        outcome = failed(error);
      } finally {
        if (input.threadId) this.#starting.delete(input.threadId);
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
