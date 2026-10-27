import { randomUUID } from "node:crypto";
import {
  threadManagementParamsSchema,
  threadManagementResultSchema,
  type ThreadManagementInput,
  type ThreadManagementParams,
  type ThreadManagementReply,
  type ThreadManagementResult,
  type ThreadBridgeManage,
  REMOTE_THREAD_CONTROL_TIMEOUT_MS,
  REMOTE_THREAD_REPLY_MAX_BYTES,
  delegationReadParamsSchema,
  delegationSendParamsSchema,
  threadSendResultSchema,
  formatThreadReference,
  type DelegationSendParams,
  type DelegationReadParams,
  type ThreadSendOutcome,
  type ThreadBridgeSend,
  type ThreadBridgeRead,
  type ThreadBridgeReply,
} from "@codexhost/shared-contracts";
import {
  DelegationControlError,
  type ThreadReadInput,
  type ThreadSendInput,
  type ThreadSendResult,
} from "./delegation-types.js";
import type { ThreadSendReceipts } from "./thread-send-receipts.js";
import { validateRemoteThreadSnapshot } from "./remote-delegation-read.js";

const LEASE_MS = 45_000;
type Connection = {
  clientId: string;
  machineIds: readonly string[];
  sendMachineIds?: readonly string[] | undefined;
  manageMachineIds?: readonly string[] | undefined;
  expires: number;
  send(request: ThreadBridgeRead | ThreadBridgeSend | ThreadBridgeManage): Promise<void>;
};

/** Fixed Thread operations travel over an attached Desktop connection, never a public listener. */
export class ThreadBridge {
  readonly #connections = new Map<object, Map<string, Connection>>();
  readonly #pending = new Map<
    string,
    {
      owner: object;
      clientId: string;
      mutation: boolean;
      resolve(reply: ThreadBridgeReply["reply"]): void;
      reject(error: Error): void;
    }
  >();

  constructor(
    readonly machineId: string,
    readonly receipts?: ThreadSendReceipts,
  ) {}

  executeSend(
    input: DelegationSendParams,
    send: () => Promise<ThreadSendResult>,
  ): Promise<ThreadSendOutcome> {
    if (input.expectedMachineId !== this.machineId)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Thread link belongs to a different machine",
      );
    if (!this.receipts)
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Cross-machine sending is unavailable on this Host",
      );
    return this.receipts.execute(input, send);
  }

  executeManagement(input: ThreadManagementParams, run: () => Promise<ThreadManagementResult>) {
    if (input.expectedMachineId !== this.machineId)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Thread operation belongs to a different machine",
      );
    if (!this.receipts)
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Thread management is unavailable on this Host",
      );
    return this.receipts.manage(input, run);
  }

  qualifyManagement(
    result: ThreadManagementResult,
    input: ThreadManagementInput,
  ): ThreadManagementReply {
    const machineId = input.machineId ?? this.machineId;
    return {
      ...result,
      machineId,
      requestId: input.requestId,
      thread: formatThreadReference({
        threadId: result.threadId,
        machineId,
        ...(input.hostId ? { hostId: input.hostId } : {}),
      }),
    };
  }

  async manage(input: ThreadManagementInput): Promise<ThreadManagementReply> {
    const params = threadManagementParamsSchema.parse({
      expectedMachineId: input.machineId,
      requestId: input.requestId,
      action: input.action,
    });
    try {
      const reply = await this.#exchange({
        machineId: params.expectedMachineId,
        operation: "manage",
        input: params,
      });
      const result = threadManagementResultSchema.safeParse(reply);
      if (
        !result.success ||
        result.data.operation !== input.action.operation ||
        ("threadId" in input.action && result.data.threadId !== input.action.threadId)
      )
        throw new DelegationControlError(
          "OUTCOME_UNKNOWN",
          "Invalid management receipt; repeat the same request ID",
        );
      return this.qualifyManagement(result.data, input);
    } catch (error) {
      if (error instanceof DelegationControlError)
        throw new DelegationControlError(error.code, error.message, {
          ...error.details,
          requestId: input.requestId,
          machineId: input.machineId,
        });
      throw error;
    }
  }

  qualifySend(result: ThreadSendResult, input: ThreadSendInput): ThreadSendResult {
    const reference = formatThreadReference({
      ...input,
      machineId: input.machineId ?? this.machineId,
    });
    return {
      ...result,
      machineId: input.machineId ?? this.machineId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      next: { read: `codexhost thread read '${reference.replaceAll("'", "'\\''")}'` },
    };
  }

  async send(input: ThreadSendInput): Promise<ThreadSendResult> {
    if (!input.machineId)
      throw new DelegationControlError("INVALID_ARGUMENT", "Machine identity is required");
    const parsed = delegationSendParamsSchema.safeParse({
      threadId: input.threadId,
      message: input.message,
      requestId: input.requestId,
      expectedMachineId: input.machineId,
    });
    if (!parsed.success)
      throw new DelegationControlError("INVALID_ARGUMENT", "Invalid Thread send request");
    try {
      const reply = await this.#exchange({
        machineId: input.machineId,
        operation: "send",
        input: parsed.data,
      });
      const result = threadSendResultSchema.safeParse(reply);
      if (!result.success || result.data.threadId !== input.threadId)
        throw new DelegationControlError(
          "OUTCOME_UNKNOWN",
          "Target returned an invalid send receipt; read the Thread before submitting another request ID",
        );
      return this.qualifySend(result.data as ThreadSendResult, input);
    } catch (error) {
      if (error instanceof DelegationControlError)
        throw new DelegationControlError(error.code, error.message, {
          ...error.details,
          requestId: input.requestId,
          thread: formatThreadReference(input),
        });
      throw error;
    }
  }

  attach(owner: object, connection: Omit<Connection, "expires">): void {
    const clients = this.#connections.get(owner) ?? new Map<string, Connection>();
    for (const [id, entry] of clients) if (entry.expires <= Date.now()) clients.delete(id);
    if (!clients.has(connection.clientId) && clients.size >= 32)
      throw new Error("Too many Desktop windows attached to this Host connection");
    clients.set(connection.clientId, { ...connection, expires: Date.now() + LEASE_MS });
    this.#connections.set(owner, clients);
  }

  detach(owner: object): void {
    this.#connections.delete(owner);
    for (const pending of this.#pending.values()) {
      if (pending.owner === owner)
        pending.reject(
          new DelegationControlError(
            pending.mutation ? "OUTCOME_UNKNOWN" : "RUNTIME_UNREACHABLE",
            pending.mutation
              ? "Desktop connection closed; a dispatched operation may have started"
              : "Desktop connection closed",
          ),
        );
    }
  }

  reply(owner: object, reply: ThreadBridgeReply): void {
    const pending = this.#pending.get(reply.requestId);
    if (!pending || pending.owner !== owner || pending.clientId !== reply.clientId) return;
    if (Buffer.byteLength(JSON.stringify(reply)) > REMOTE_THREAD_REPLY_MAX_BYTES) {
      pending.reject(
        new DelegationControlError("RESPONSE_TOO_LARGE", "Thread reply exceeds 16 MiB"),
      );
      return;
    }
    pending.resolve(reply.reply);
  }

  async read(input: ThreadReadInput) {
    const read = delegationReadParamsSchema.parse({
      threadId: input.threadId,
      view: input.view,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    if (!input.machineId)
      throw new DelegationControlError("INVALID_ARGUMENT", "Machine identity is required");
    const reply = await this.#exchange({ machineId: input.machineId, input: read });
    return {
      ...validateRemoteThreadSnapshot(reply, input.threadId),
      machineId: input.machineId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
    };
  }

  async #exchange(
    input:
      | { machineId: string; input: DelegationReadParams }
      | { machineId: string; operation: "send"; input: DelegationSendParams }
      | { machineId: string; operation: "manage"; input: ThreadManagementParams },
  ) {
    const mutation = "operation" in input;
    const { machineId } = input;
    if (!machineId)
      throw new DelegationControlError("INVALID_ARGUMENT", "Machine identity is required");
    const connection = [...this.#connections]
      .flatMap(([owner, clients]) => [...clients.values()].map((entry) => [owner, entry] as const))
      .find(
        ([, entry]) =>
          entry.expires > Date.now() &&
          (mutation
            ? input.operation === "manage"
              ? (entry.manageMachineIds ?? [])
              : (entry.sendMachineIds ?? [])
            : entry.machineIds
          ).includes(machineId),
      );
    if (!connection)
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "The target machine has no connected Desktop route; connect both Hosts in Codex Desktop",
      );
    if (this.#pending.size >= 64)
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Too many pending cross-machine requests",
      );
    const [owner, entry] = connection;
    const requestId = randomUUID();
    const deferred = Promise.withResolvers<ThreadBridgeReply["reply"]>();
    this.#pending.set(requestId, { owner, clientId: entry.clientId, mutation, ...deferred });
    const timer = setTimeout(
      () =>
        deferred.reject(
          new DelegationControlError(
            mutation ? "OUTCOME_UNKNOWN" : "RUNTIME_UNREACHABLE",
            mutation
              ? "Cross-machine request timed out; a dispatched operation may have started"
              : "Cross-machine read timed out",
          ),
        ),
      REMOTE_THREAD_CONTROL_TIMEOUT_MS,
    );
    try {
      void entry
        .send({ ...input, clientId: entry.clientId, requestId })
        .catch(() =>
          deferred.reject(
            new DelegationControlError(
              mutation ? "OUTCOME_UNKNOWN" : "RUNTIME_UNREACHABLE",
              "Desktop dispatch failed; an operation may have started",
            ),
          ),
        );
      const reply = await deferred.promise;
      if ("error" in reply) throw new DelegationControlError(reply.error.code, reply.error.message);
      return reply.result;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(requestId);
    }
  }
}
