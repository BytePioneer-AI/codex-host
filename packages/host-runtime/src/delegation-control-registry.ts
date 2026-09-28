import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type ThreadAnswerInput,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadWaitInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import { DelegationWatchService } from "./delegation-watch.js";

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
  readonly #registrations = new Set<DelegationControlRegistration>();
  #harnessCatalog: DelegationControlRegistration | undefined;
  // Watches sit above the sessions so either end may belong to any registered session.
  readonly #watchService: DelegationWatchService;

  readonly #remoteRead:
    ((input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>) | undefined;

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
    } = {},
  ) {
    this.#remoteRead = options.remoteRead;
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
    return (await this.#registrationForThread(input.threadId)).send(input);
  }

  async cancel(input: Parameters<DelegationControlApi["cancel"]>[0]) {
    return (await this.#registrationForThread(input.threadId)).cancel(input);
  }

  async read(input: ThreadReadInput) {
    if (input.hostId !== undefined && input.hostId !== "local") {
      if (!input.hostId || !this.#remoteRead)
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Remote Thread reading is unavailable",
        );
      return this.#remoteRead(input);
    }
    return (await this.#registrationForThread(input.threadId)).read(input);
  }

  async wait(input: ThreadWaitInput) {
    if (input.hostId !== undefined && input.hostId !== "local")
      throw new DelegationControlError("INVALID_ARGUMENT", "Remote Hosts support thread read only");
    return (await this.#registrationForThread(input.threadId)).wait(input);
  }

  async answer(input: ThreadAnswerInput) {
    return (await this.#registrationForThread(input.threadId)).answer(input);
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
