import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadWaitInput,
} from "./delegation-types.js";

function only<T>(values: readonly T[], message: string): T {
  const value = values.length === 1 ? values[0] : undefined;
  if (!value) {
    throw new DelegationControlError("PARENT_THREAD_AMBIGUOUS", message, {
      matchingRuntimeCount: values.length,
    });
  }
  return value;
}

export class DelegationControlRegistry implements DelegationControlApi {
  readonly #registrations = new Set<DelegationControlRegistration>();

  get size(): number {
    return this.#registrations.size;
  }

  register(registration: DelegationControlRegistration): () => void {
    this.#registrations.add(registration);
    return () => this.#registrations.delete(registration);
  }

  async start(input: DelegationStartInput) {
    return (await this.#registrationForStart(input)).start(input);
  }

  async read(input: ThreadReadInput) {
    return (await this.#registrationForThread(input.threadId)).read(input);
  }

  async wait(input: ThreadWaitInput) {
    return (await this.#registrationForThread(input.threadId)).wait(input);
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
    return only(
      await this.#matching((registration) => registration.ownsThread(threadId)),
      "Thread is not owned by exactly one active Host Runtime session",
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
