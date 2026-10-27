import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadWaitInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import { DelegationWatchService } from "./delegation-watch.js";
import {
  machineIdSchema,
  delegationSendParamsSchema,
  threadManagementInputSchema,
  type ThreadManagementInput,
} from "@codexhost/shared-contracts";
import type { ThreadBridge } from "./thread-bridge.js";

function only<T>(values: readonly T[], message: string): T {
  const value = values.length === 1 ? values[0] : undefined;
  if (!value) {
    throw new DelegationControlError("PARENT_THREAD_AMBIGUOUS", message, {
      matchingRuntimeCount: values.length,
    });
  }
  return value;
}

export class DelegationControlRegistry implements DelegationControlApi, DelegationWatchApi {
  readonly threadBridge: ThreadBridge | undefined;
  readonly #registrations = new Set<DelegationControlRegistration>();
  #harnessCatalog: DelegationControlRegistration | undefined;
  // Watches sit above the sessions so either end may belong to any registered session.
  readonly #watchService: DelegationWatchService;

  readonly #remoteRead:
    ((input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>) | undefined;

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      threadBridge?: ThreadBridge;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
    } = {},
  ) {
    this.#remoteRead = options.remoteRead;
    this.threadBridge = options.threadBridge;
    this.#watchService = new DelegationWatchService(this, options);
  }

  get size(): number {
    return this.#registrations.size;
  }

  register(
    registration: DelegationControlRegistration,
    options: { harnessCatalog?: boolean } = {},
  ): () => void {
    this.#registrations.add(registration);
    if (options.harnessCatalog) this.#harnessCatalog = registration;
    return () => {
      this.#registrations.delete(registration);
      if (this.#harnessCatalog === registration) this.#harnessCatalog = undefined;
    };
  }

  async inspect(input: HarnessInspectInput) {
    if (this.#harnessCatalog) return this.#harnessCatalog.inspect(input);
    const registrations = [...this.#registrations];
    return only(
      registrations,
      "Harness inspection requires exactly one active Host Runtime session",
    ).inspect(input);
  }

  async listHarnesses() {
    if (this.#harnessCatalog) return this.#harnessCatalog.listHarnesses();
    return only(
      [...this.#registrations],
      "Harness discovery requires exactly one active Host Runtime session",
    ).listHarnesses();
  }

  async start(input: DelegationStartInput) {
    return (await this.#registrationForStart(input)).start(input);
  }

  async send(input: Parameters<DelegationControlApi["send"]>[0]) {
    if (input.machineId !== undefined || input.requestId !== undefined) {
      const bridge = this.threadBridge;
      if (!bridge)
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Cross-machine sending is unavailable",
        );
      const machineId = input.machineId ?? bridge.machineId;
      const parsed = delegationSendParamsSchema.safeParse({
        threadId: input.threadId,
        message: input.message,
        requestId: input.requestId,
        expectedMachineId: machineId,
      });
      if (!parsed.success)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "A valid machine identity, request ID and message are required",
        );
      if (!input.machineId && input.hostId && input.hostId !== "local")
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Copy a machine-qualified link to send to another Host",
        );
      if (machineId !== bridge.machineId) return bridge.send({ ...input, machineId });
      const outcome = await bridge.executeSend(parsed.data, async () =>
        (await this.#registrationForThread(input.threadId)).send({
          threadId: input.threadId,
          message: input.message,
        }),
      );
      if ("error" in outcome)
        throw new DelegationControlError(outcome.error.code, outcome.error.message, {
          requestId: input.requestId,
        });
      return bridge.qualifySend(
        outcome.result as Awaited<ReturnType<DelegationControlApi["send"]>>,
        { ...input, machineId },
      );
    }
    if (input.hostId && input.hostId !== "local")
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Copy a machine-qualified link to send to another Host",
      );
    return (await this.#registrationForThread(input.threadId)).send(input);
  }

  async manage(raw: ThreadManagementInput) {
    const parsed = threadManagementInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new DelegationControlError("INVALID_ARGUMENT", "Invalid Thread management request");
    const input = parsed.data;
    const bridge = this.threadBridge;
    if (!bridge)
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Thread management requires an updated Host",
      );
    if (!input.machineId && input.hostId && input.hostId !== "local")
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "A machine-qualified target is required",
      );
    const machineId = input.machineId ?? bridge.machineId;
    if (machineId !== bridge.machineId) return bridge.manage({ ...input, machineId });
    const outcome = await bridge.executeManagement(
      { expectedMachineId: machineId, requestId: input.requestId, action: input.action },
      async () => {
        const registration =
          input.action.operation === "create"
            ? (this.#harnessCatalog ??
              only(
                [...this.#registrations],
                "Thread creation requires exactly one active Host Runtime session",
              ))
            : await this.#registrationForThread(input.action.threadId);
        if (!registration.manageLocal)
          throw new DelegationControlError(
            "RUNTIME_UNREACHABLE",
            "Update the target Host to manage Threads",
          );
        return registration.manageLocal(input.action);
      },
    );
    if ("error" in outcome)
      throw new DelegationControlError(outcome.error.code, outcome.error.message, {
        requestId: input.requestId,
        machineId,
      });
    return bridge.qualifyManagement(outcome.result, { ...input, machineId });
  }

  async cancel(input: Parameters<DelegationControlApi["cancel"]>[0]) {
    return (await this.#registrationForThread(input.threadId)).cancel(input);
  }

  async read(input: ThreadReadInput) {
    if (input.machineId !== undefined) {
      if (!machineIdSchema.safeParse(input.machineId).success)
        throw new DelegationControlError("INVALID_ARGUMENT", "Invalid machine identity");
      if (!this.threadBridge)
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Cross-machine Thread reads are unavailable",
        );
      if (input.machineId !== this.threadBridge.machineId) return this.threadBridge.read(input);
      const snapshot = await (
        await this.#registrationForThread(input.threadId)
      ).read({
        threadId: input.threadId,
        view: input.view,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return {
        ...snapshot,
        machineId: input.machineId,
        ...(input.hostId ? { hostId: input.hostId } : {}),
      };
    }
    const { callerThreadId, ...read } = input;
    if (read.hostId !== undefined && read.hostId !== "local") {
      if (typeof callerThreadId === "string" && callerThreadId) {
        const callers = await this.#matching(
          (registration) =>
            registration.executionHostId?.(callerThreadId) === read.hostId &&
            registration.ownsThread(callerThreadId),
        );
        if (callers.length > 1)
          only(callers, "Calling Thread has ambiguous execution Host context");
        if (callers.length === 1) {
          const { hostId, ...local } = read;
          const snapshot = await (await this.#registrationForThread(local.threadId)).read(local);
          return { ...snapshot, hostId };
        }
      }
      if (!read.hostId || !this.#remoteRead)
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Remote Thread reading is unavailable",
        );
      return this.#remoteRead(read);
    }
    return (await this.#registrationForThread(read.threadId)).read(read);
  }

  async wait(input: ThreadWaitInput) {
    if (input.machineId !== undefined)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Machine-qualified links support thread read only",
      );
    if (input.hostId !== undefined && input.hostId !== "local")
      throw new DelegationControlError("INVALID_ARGUMENT", "Remote Hosts support thread read only");
    return (await this.#registrationForThread(input.threadId)).wait(input);
  }

  async watch(input: ThreadWatchInput) {
    return this.#watchService.watch(input);
  }

  async watches() {
    return this.#watchService.watches();
  }

  /** Stops all watches; pending notifications are dropped with the Host Runtime. */
  close(): void {
    this.#watchService.close();
  }

  async list(input: ThreadListInput) {
    if (input.parentThreadId) {
      return (await this.#registrationForThread(input.parentThreadId)).list(input);
    }
    // A shared SSH owner sees the same native backend plus all external
    // Threads. Do not duplicate its rows once per attached GUI.
    if (this.#harnessCatalog) return this.#harnessCatalog.list(input);
    const registrations = [...this.#registrations];
    if (registrations.length === 0) {
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread list requires an active Host Runtime session",
        { matchingRuntimeCount: 0 },
      );
    }
    if (registrations.length === 1) return only(registrations, "unreachable").list(input);
    const results = await Promise.all(
      registrations.map((registration) => registration.list(input)),
    );
    const threads = results
      .flatMap((result) => result.threads)
      .sort((left, right) => this.#compareThreads(left, right, input.sort))
      .slice(0, input.limit);
    return { threads, nextCursor: null };
  }

  async #registrationForStart(input: DelegationStartInput): Promise<DelegationControlRegistration> {
    const matches = await this.#matching((registration) => registration.canHandleStart(input));
    return only(
      matches,
      input.parentThreadId
        ? "Parent Thread is not owned by exactly one active Host Runtime session"
        : "Parent Thread cannot be inferred uniquely; pass --parent-thread explicitly",
    );
  }

  async #registrationForThread(threadId: string): Promise<DelegationControlRegistration> {
    const registrations = [...this.#registrations];
    const matches = await this.#matching((registration) => registration.ownsThread(threadId));
    if (matches.length === 1) return matches[0] as DelegationControlRegistration;
    if (matches.length > 1) {
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread is not owned by exactly one active Host Runtime session",
        { matchingRuntimeCount: matches.length },
      );
    }
    if (this.#harnessCatalog) return this.#harnessCatalog;
    if (registrations.length === 0) {
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread is not owned by exactly one active Host Runtime session",
        { matchingRuntimeCount: 0 },
      );
    }
    // When only one runtime session exists, forward unknown thread IDs to it so it can attempt official fallback (or return THREAD_NOT_FOUND).
    if (registrations.length === 1) return registrations[0] as DelegationControlRegistration;
    throw new DelegationControlError(
      "PARENT_THREAD_AMBIGUOUS",
      "Thread is not owned by exactly one active Host Runtime session",
      { matchingRuntimeCount: 0 },
    );
  }

  #compareThreads(
    left: Awaited<ReturnType<DelegationControlApi["list"]>>["threads"][number],
    right: Awaited<ReturnType<DelegationControlApi["list"]>>["threads"][number],
    sort: ThreadListInput["sort"],
  ): number {
    const field = sort.startsWith("created") ? "createdAt" : "updatedAt";
    const direction = sort.endsWith("asc") ? 1 : -1;
    const leftValue = left[field] ? Date.parse(left[field]) : 0;
    const rightValue = right[field] ? Date.parse(right[field]) : 0;
    return (leftValue - rightValue) * direction || left.threadId.localeCompare(right.threadId);
  }

  async #matching(
    predicate: (registration: DelegationControlRegistration) => boolean | Promise<boolean>,
  ): Promise<DelegationControlRegistration[]> {
    const registrations = [...this.#registrations];
    const matches = await Promise.all(registrations.map((registration) => predicate(registration)));
    return registrations.filter((_, index) => matches[index]);
  }
}
