import { randomUUID } from "node:crypto";

import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationQuotaContinuationApi,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
  type HarnessQuotaInput,
  type ThreadAnswerInput,
  type ThreadContinueCancelInput,
  type ThreadContinueOnResetInput,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadWaitInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import {
  isMergedListCursor,
  listSortSeconds,
  mergeThreadListPages,
} from "./delegation-thread-list-merge.js";
import { DelegationWatchService, type ClientEventSink } from "./delegation-watch.js";
import type { DelegationWatchStore } from "./delegation-watch-store.js";
import { clientOrigin, originClientName } from "./external-client-origin.js";
import { interruptAndSend } from "./delegation-interrupt-send.js";
import { validateThreadExportInput, type ThreadExportInput } from "./delegation-thread-export.js";
import { QuotaContinuationService } from "./quota-continuation.js";
import type { QuotaContinuationStore } from "./quota-continuation-store.js";
import { mergeRefs, normalizeRefs, type ThreadRefsStore } from "./thread-refs.js";

const REF_CURSOR_PREFIX = "ref:";

/** Adds references to a result only when there are some, so existing output stays unchanged. */
function withRefs<T extends object>(value: T, refs: readonly string[]): T {
  return refs.length > 0 ? { ...value, refs: [...refs] } : value;
}

function only<T>(values: readonly T[], message: string): T {
  const value = values.length === 1 ? values[0] : undefined;
  if (!value) {
    throw new DelegationControlError("PARENT_THREAD_AMBIGUOUS", message, {
      matchingRuntimeCount: values.length,
    });
  }
  return value;
}

export class DelegationControlRegistry
  implements DelegationControlApi, DelegationWatchApi, DelegationQuotaContinuationApi
{
  readonly #registrations = new Set<DelegationControlRegistration>();
  // Changes whenever the session set changes, so a merged list cursor cannot outlive it. The
  // instance id keeps a cursor from matching a rebuilt Registry at the same count.
  readonly #instanceId = randomUUID();
  #registrationGeneration = 0;
  #harnessCatalog: DelegationControlRegistration | undefined;
  // Watches and quota continuations sit above sessions so either end may belong to any session.
  readonly #watchService: DelegationWatchService;
  readonly #continuationService: QuotaContinuationService;

  readonly #remoteRead:
    ((input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>) | undefined;
  readonly #refs: ThreadRefsStore | undefined;

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
      watchStore?: DelegationWatchStore;
      continuationStore?: QuotaContinuationStore;
      refs?: ThreadRefsStore;
      clientEvents?: ClientEventSink;
    } = {},
  ) {
    this.#remoteRead = options.remoteRead;
    this.#refs = options.refs;
    this.#continuationService = new QuotaContinuationService(this, {
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
      ...(options.continuationStore ? { store: options.continuationStore } : {}),
      onUnblocked: (threadId) => this.#watchService.nudge(threadId),
    });
    this.#watchService = new DelegationWatchService(this, {
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
      ...(options.watchStore ? { store: options.watchStore } : {}),
      ...(options.clientEvents ? { clientEvents: options.clientEvents } : {}),
      shouldDeferDelivery: (notifyThreadId) =>
        this.#continuationService.isThreadDeferredForQuota(notifyThreadId),
    });
  }

  get size(): number {
    return this.#registrations.size;
  }

  register(
    registration: DelegationControlRegistration,
    options: { harnessCatalog?: boolean } = {},
  ): () => void {
    this.#registrations.add(registration);
    this.#registrationGeneration += 1;
    if (options.harnessCatalog) this.#harnessCatalog = registration;
    const unsubscribeIdle = registration.onThreadIdle?.((threadId) => {
      this.#watchService.nudge(threadId);
      this.#continuationService.nudge(threadId);
    });
    return () => {
      unsubscribeIdle?.();
      if (this.#registrations.delete(registration)) this.#registrationGeneration += 1;
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

  async listHarnesses(input?: HarnessListInput) {
    if (this.#harnessCatalog) return this.#harnessCatalog.listHarnesses(input);
    return only(
      [...this.#registrations],
      "Harness discovery requires exactly one active Host Runtime session",
    ).listHarnesses(input);
  }

  async quota(input?: HarnessQuotaInput) {
    const target =
      this.#harnessCatalog ??
      only(
        [...this.#registrations],
        "Harness quota inspection requires exactly one active Host Runtime session",
      );
    if (!target.quota)
      throw new DelegationControlError("UNSUPPORTED", "Harness quota inspection is unavailable");
    return target.quota(input);
  }

  async start(input: DelegationStartInput) {
    const { refs: requested, ...start } = input;
    // Validated before anything is created, so a bad reference never leaves a Thread behind.
    const own = normalizeRefs(requested);
    const result = await (await this.#registrationForStart(start)).start(start);
    if (!this.#refs) return result;
    const parent = result.parentThreadId ?? start.parentThreadId;
    const inherited = parent && !originClientName(parent) ? await this.#refs.get(parent) : [];
    const refs = mergeRefs(inherited, own);
    if (refs.length > 0) await this.#refs.set(result.threadId, refs, result.cwd, result.title);
    return withRefs(result, refs);
  }

  async send(input: Parameters<DelegationControlApi["send"]>[0]) {
    if (input.interrupt !== undefined && typeof input.interrupt !== "boolean")
      throw new DelegationControlError("INVALID_ARGUMENT", "interrupt must be a boolean");
    if (input.steer !== undefined && typeof input.steer !== "boolean")
      throw new DelegationControlError("INVALID_ARGUMENT", "steer must be a boolean");
    if (input.steer && input.interrupt)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "steer and interrupt are mutually exclusive",
      );
    const registration = await this.#registrationForThread(input.threadId);
    const result = !input.interrupt
      ? await registration.send(input)
      : await this.#watchService.holdNotifications(input.threadId, () =>
          interruptAndSend(registration, { threadId: input.threadId, message: input.message }),
        );
    if (!this.#continuationService.isDispatching(input.threadId)) {
      await this.#continuationService.cancelContinuation(
        { threadId: input.threadId },
        "Cancelled because a new message was sent",
      );
    }
    return result;
  }

  async cancel(input: Parameters<DelegationControlApi["cancel"]>[0]) {
    const result = await this.#watchService.cancel(input.threadId, async () =>
      (await this.#registrationForThread(input.threadId)).cancel(input),
    );
    await this.#continuationService.cancelContinuation(
      { threadId: input.threadId },
      "Cancelled by thread cancel",
    );
    return result;
  }

  async read(input: ThreadReadInput) {
    const snapshot = await this.#read(input);
    return withRefs(snapshot, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async #read(input: ThreadReadInput) {
    const { callerThreadId, ...read } = input;
    if (read.hostId !== undefined && read.hostId !== "local") {
      if (typeof callerThreadId === "string" && callerThreadId) {
        const callers = await this.#matching(
          (registration) =>
            registration.executionHostId?.(callerThreadId) === read.hostId &&
            registration.ownsThread(callerThreadId),
        );
        if (callers.length > 0) {
          this.#selectExplicitThreadRegistration(
            callers,
            "Calling Thread has ambiguous execution Host context",
          );
          // The caller identifies the Host, but the target can belong to another session.
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

  async exportThread(input: ThreadExportInput) {
    validateThreadExportInput(input);
    const registration = await this.#registrationForThread(input.threadId);
    if (!registration.exportThread)
      throw new DelegationControlError("UNSUPPORTED", "Thread export is unavailable");
    return registration.exportThread(input);
  }

  async wait(input: ThreadWaitInput) {
    if (input.hostId !== undefined && input.hostId !== "local")
      throw new DelegationControlError("INVALID_ARGUMENT", "Remote Hosts support thread read only");
    const snapshot = await (await this.#registrationForThread(input.threadId)).wait(input);
    return withRefs(snapshot, (await this.#refs?.get(snapshot.threadId)) ?? []);
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

  async continueOnReset(input: ThreadContinueOnResetInput) {
    return this.#continuationService.continueOnReset(input);
  }

  async continuations() {
    return this.#continuationService.continuations();
  }

  async cancelContinuation(input: ThreadContinueCancelInput) {
    return this.#continuationService.cancelContinuation(input);
  }

  /** Stops watching and continuation loops in this process; stored records resume in the next Runtime. */
  close(): void {
    this.#watchService.close();
    this.#continuationService.close();
  }

  async list(input: ThreadListInput) {
    const { client, ref, ...rest } = input;
    if (client !== undefined && rest.parentThreadId)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--client and --parent cannot be combined",
      );
    if (ref !== undefined) return this.#listByRef(ref, rest);
    const page = await this.#list(
      client !== undefined ? { ...rest, parentThreadId: clientOrigin(client) } : rest,
    );
    if (!this.#refs) return page;
    const refs = this.#refs;
    return {
      ...page,
      threads: await Promise.all(
        page.threads.map(async (thread) => withRefs(thread, await refs.get(thread.threadId))),
      ),
    };
  }

  /** Threads carrying a reference, newest first; each row is read from its owning session. */
  async #listByRef(ref: string, input: Omit<ThreadListInput, "client" | "ref">) {
    const [normalized] = normalizeRefs([ref]);
    const matches = normalized && this.#refs ? await this.#refs.find(normalized) : [];
    let offset = 0;
    if (input.cursor) {
      const value = input.cursor.startsWith(REF_CURSOR_PREFIX)
        ? Number(input.cursor.slice(REF_CURSOR_PREFIX.length))
        : Number.NaN;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new DelegationControlError("INVALID_ARGUMENT", "List cursor is invalid");
      offset = value;
    }
    const window = matches.slice(offset, offset + input.limit);
    const rows = await Promise.all(
      window.map(({ threadId, cwd, title }) =>
        this.read({ threadId, view: "result" })
          .then((snapshot) => {
            const resolvedTitle = snapshot.title ?? title;
            return withRefs(
              {
                threadId,
                harnessId: snapshot.harnessId,
                deepLink: `codex://threads/${threadId}`,
                status: snapshot.status,
                ...(cwd ? { cwd } : {}),
                ...(resolvedTitle ? { title: resolvedTitle } : {}),
              },
              snapshot.refs ?? [],
            );
          })
          // A Thread deleted since its references were stored is left out.
          .catch(() => undefined),
      ),
    );
    const next = offset + window.length;
    return {
      threads: rows.filter((row) => row !== undefined),
      nextCursor: next < matches.length ? `${REF_CURSOR_PREFIX}${next}` : null,
    };
  }

  async #list(input: ThreadListInput) {
    // Parent list owners validate their own source-bound continuation, including
    // merged cursors when SSH combines legacy and shared children.
    if (input.parentThreadId) {
      return (await this.#registrationForThread(input.parentThreadId)).list(input);
    }
    if (this.#harnessCatalog && input.cursor && isMergedListCursor(input.cursor)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "List cursor does not match the current Thread list source",
      );
    }
    // Shared-backend catalogs see all native and external Threads. Attached
    // clients are not independent list sources.
    if (this.#harnessCatalog) return this.#harnessCatalog.list(input);
    const registrations = [...this.#registrations];
    if (registrations.length === 0) {
      throw new DelegationControlError(
        "PARENT_THREAD_AMBIGUOUS",
        "Thread list requires an active Host Runtime session",
        { matchingRuntimeCount: 0 },
      );
    }
    if (registrations.length === 1) {
      // A merged cursor was issued for several sessions; its positions mean nothing to one.
      if (input.cursor && isMergedListCursor(input.cursor)) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "List cursor does not match the active Host Runtime sessions",
        );
      }
      return only(registrations, "unreachable").list(input);
    }
    // Registration order is insertion order, which the merged cursor's session positions follow.
    return mergeThreadListPages(
      registrations.map((registration) => (page: ThreadListInput) => registration.list(page)),
      input,
      (left, right) => this.#compareThreads(left, right, input.sort),
      `${this.#instanceId}:${this.#registrationGeneration}`,
    );
  }

  async #registrationForStart(input: DelegationStartInput): Promise<DelegationControlRegistration> {
    if (originClientName(input.parentThreadId)) {
      // A client is no session's Thread, so the shared catalog or the only session takes it.
      if (this.#harnessCatalog) return this.#harnessCatalog;
      return only(
        [...this.#registrations],
        "External client work needs exactly one active Host Runtime session",
      );
    }
    const matches = await this.#matching((registration) => registration.canHandleStart(input));
    if (input.parentThreadId) {
      return this.#selectExplicitThreadRegistration(
        matches,
        "Parent Thread is not owned by exactly one active Host Runtime session",
      );
    }
    return only(
      matches,
      "Parent Thread cannot be inferred uniquely; pass --parent-thread explicitly",
    );
  }

  #selectExplicitThreadRegistration(
    matches: readonly DelegationControlRegistration[],
    message: string,
  ): DelegationControlRegistration {
    // Several attached clients can observe the catalog's same shared Thread.
    if (matches.length > 1 && this.#harnessCatalog && matches.includes(this.#harnessCatalog))
      return this.#harnessCatalog;
    return only(matches, message);
  }

  async #registrationForThread(threadId: string): Promise<DelegationControlRegistration> {
    const registrations = [...this.#registrations];
    const matches = await this.#matching((registration) => registration.ownsThread(threadId));
    if (matches.length > 0) {
      return this.#selectExplicitThreadRegistration(
        matches,
        "Thread is not owned by exactly one active Host Runtime session",
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
    const seconds = (thread: typeof left): number | undefined =>
      sort.startsWith("created")
        ? listSortSeconds(thread, "createdAt")
        : sort.startsWith("recency")
          ? (listSortSeconds(thread, "recencyAt") ?? listSortSeconds(thread, "updatedAt"))
          : listSortSeconds(thread, "updatedAt");
    const direction = sort.endsWith("asc") ? 1 : -1;
    const leftValue = seconds(left) ?? 0;
    const rightValue = seconds(right) ?? 0;
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
