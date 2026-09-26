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
  type ThreadWatchRequest,
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
  // Watches sit above the sessions so either end may belong to any registered session.
  readonly #watchService: DelegationWatchService;

  constructor(options: { diagnose?: (error: unknown) => void } = {}) {
    this.#watchService = new DelegationWatchService(this, options);
  }

  get size(): number {
    return this.#registrations.size;
  }

  register(registration: DelegationControlRegistration): () => void {
    this.#registrations.add(registration);
    return () => this.#registrations.delete(registration);
  }

  async inspect(input: HarnessInspectInput) {
    const registrations = [...this.#registrations];
    return only(
      registrations,
      "Harness inspection requires exactly one active Host Runtime session",
    ).inspect(input);
  }

  async listHarnesses() {
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
    return (await this.#registrationForThread(input.threadId)).read(input);
  }

  async wait(input: ThreadWaitInput) {
    return (await this.#registrationForThread(input.threadId)).wait(input);
  }

  async watch(request: ThreadWatchRequest) {
    const notifyThreadId = request.notifyThreadId ?? (await this.#inferCaller(request.threadId));
    return this.#watchService.watch({ ...request, notifyThreadId });
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

  /**
   * A caller without a Host-provided Thread identity (native Codex) is the only
   * Thread with an active Turn besides the one it is watching.
   */
  async #inferCaller(watchedThreadId: string): Promise<string> {
    const active = await Promise.all(
      [...this.#registrations].map((registration) => registration.activeThreadIds?.() ?? []),
    );
    const candidates = [...new Set(active.flat())].filter((id) => id !== watchedThreadId);
    const caller = candidates.length === 1 ? candidates[0] : undefined;
    if (caller) return caller;
    throw new DelegationControlError(
      "PARENT_THREAD_AMBIGUOUS",
      candidates.length === 0
        ? "The notified Thread cannot be inferred because no other active Turn was found; pass --notify"
        : "The notified Thread cannot be inferred uniquely; pass --notify explicitly",
      { activeThreadIds: candidates },
    );
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
