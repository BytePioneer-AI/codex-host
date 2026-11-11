import { randomUUID } from "node:crypto";

import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
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

export class DelegationControlRegistry implements DelegationControlApi, DelegationWatchApi {
  readonly #registrations = new Set<DelegationControlRegistration>();
  // Changes whenever the session set changes, so a merged list cursor cannot outlive it. The
  // instance id keeps a cursor from matching a rebuilt Registry at the same count.
  readonly #instanceId = randomUUID();
  #registrationGeneration = 0;
  #harnessCatalog: DelegationControlRegistration | undefined;
  // Watches sit above the sessions so either end may belong to any registered session.
  readonly #watchService: DelegationWatchService;

  readonly #remoteRead:
    ((input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>) | undefined;
  readonly #refs: ThreadRefsStore | undefined;

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
      watchStore?: DelegationWatchStore;
      refs?: ThreadRefsStore;
      clientEvents?: ClientEventSink;
    } = {},
  ) {
    this.#remoteRead = options.remoteRead;
    this.#refs = options.refs;
    this.#watchService = new DelegationWatchService(this, {
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
      ...(options.watchStore ? { store: options.watchStore } : {}),
      ...(options.clientEvents ? { clientEvents: options.clientEvents } : {}),
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
    return () => {
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
    return (await this.#registrationForThread(input.threadId)).send(input);
  }

  async cancel(input: Parameters<DelegationControlApi["cancel"]>[0]) {
    return (await this.#registrationForThread(input.threadId)).cancel(input);
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
    if (input.hostId !== undefined && input.hostId !== "local")
      throw new DelegationControlError("INVALID_ARGUMENT", "Remote Hosts support thread read only");
    const snapshot = await (await this.#registrationForThread(input.threadId)).wait(input);
    return withRefs(snapshot, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async watch(input: ThreadWatchInput) {
    return this.#watchService.watch(input);
  }

  async watches() {
    return this.#watchService.watches();
  }

  /** Stops watching in this process; stored watches resume in the next Runtime. */
  close(): void {
    this.#watchService.close();
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
