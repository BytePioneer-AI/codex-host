import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import {
  PEER_DELEGATION_MAX_HOPS,
  jsonValueSchema,
  type PeerDelegationHostsResult,
  type PeerDelegationOperation,
} from "@codexhost/shared-contracts";

import {
  getCallerAuthContext,
  DelegationControlError,
  type DelegationCallerAuthContext,
  type DelegationControlApi,
  type DelegationControlRegistration,
  type DelegationStartInput,
  type DelegationStartResult,
  type DelegationThreadListResult,
  type DelegationThreadSnapshot,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessInspectResult,
  type HarnessListInput,
  type HarnessListResult,
  type PersistedDelegationLookup,
  type ThreadAnswerInput,
  type ThreadAnswerResult,
  type ThreadCancelInput,
  type ThreadCancelResult,
  type ThreadListInput,
  type ThreadReadInput,
  type ThreadSendInput,
  type ThreadSendResult,
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
import { clientOrigin, isPeerOrigin, isSyntheticOrigin } from "./external-client-origin.js";
import { interruptAndSend } from "./delegation-interrupt-send.js";
import { validateThreadExportInput, type ThreadExportInput } from "./delegation-thread-export.js";
import type { PeerStartIdempotencyStore } from "./peer-start-idempotency-store.js";
import { mergeRefs, normalizeRefs, type ThreadRefsStore } from "./thread-refs.js";
import {
  dispatchPeerDelegationRequest,
  isRemoteHostId,
  isRemotePeerHostId,
  raceWithAbort,
  remoteNextHints,
  remoteThreadLink,
  waitRemotePeerThread,
  type RemotePeerCallOptions,
  type RemotePeerDelegationClient,
} from "./remote-peer-delegation.js";

const REF_CURSOR_PREFIX = "ref:";
const MAX_LINEAGE_DEPTH = 64;
const MAX_PEER_START_CACHE = 500;

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

  readonly #diagnose: ((error: unknown) => void) | undefined;
  readonly #remoteRead:
    ((input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>) | undefined;
  readonly #remotePeer: RemotePeerDelegationClient | undefined;
  readonly #peerStartStore: PeerStartIdempotencyStore | undefined;
  readonly #remoteWaitPollIntervalsMs: readonly number[] | undefined;
  readonly #remoteOriginHops = new Map<string, number>();
  readonly #peerStartLocks = new Map<string, Promise<unknown>>();
  readonly #peerStartCache = new Map<string, { configHash: string; result: unknown }>();
  readonly #refs: ThreadRefsStore | undefined;

  constructor(
    options: {
      diagnose?: (error: unknown) => void;
      remoteRead?: (input: ThreadReadInput) => ReturnType<DelegationControlApi["read"]>;
      remotePeer?: RemotePeerDelegationClient;
      peerStartStore?: PeerStartIdempotencyStore;
      remoteWaitPollIntervalsMs?: readonly number[];
      watchStore?: DelegationWatchStore;
      refs?: ThreadRefsStore;
      clientEvents?: ClientEventSink;
    } = {},
  ) {
    this.#diagnose = options.diagnose;
    this.#remoteRead = options.remoteRead;
    this.#remotePeer = options.remotePeer;
    this.#peerStartStore = options.peerStartStore;
    this.#remoteWaitPollIntervalsMs = options.remoteWaitPollIntervalsMs;
    this.#refs = options.refs;
    this.#watchService = new DelegationWatchService(this, {
      ...(options.diagnose ? { diagnose: options.diagnose } : {}),
      ...(options.watchStore ? { store: options.watchStore } : {}),
      ...(options.clientEvents ? { clientEvents: options.clientEvents } : {}),
    });
  }

  /** Record the inbound remote-delegation hop depth for a locally executing Thread. */
  markRemoteOriginThread(threadId: string, hopCount = 1): void {
    this.#remoteOriginHops.set(threadId, hopCount);
  }

  remoteOriginHopCount(threadId: string | undefined): number {
    if (!threadId) return 0;
    if (isPeerOrigin(threadId)) return PEER_DELEGATION_MAX_HOPS;
    return this.#remoteOriginHops.get(threadId) ?? 0;
  }

  async #inspectLineage(
    threadId: string | undefined,
  ): Promise<
    | { readonly kind: "local" }
    | { readonly kind: "remote"; readonly hops: number }
    | { readonly kind: "unverified"; readonly reason: string }
  > {
    if (!threadId) return { kind: "local" };
    const direct = this.remoteOriginHopCount(threadId);
    if (direct > 0) return { kind: "remote", hops: direct };
    let current: string | undefined = threadId;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH && current; depth += 1) {
      if (visited.has(current)) {
        return { kind: "unverified", reason: "Caller Thread delegation lineage contains a cycle" };
      }
      visited.add(current);
      if (isPeerOrigin(current)) {
        this.markRemoteOriginThread(threadId, PEER_DELEGATION_MAX_HOPS);
        return { kind: "remote", hops: PEER_DELEGATION_MAX_HOPS };
      }
      const cached = this.#remoteOriginHops.get(current);
      if (cached && cached > 0) {
        this.markRemoteOriginThread(threadId, cached);
        return { kind: "remote", hops: cached };
      }
      let parent: string | undefined;
      try {
        parent = await this.#lookupDelegationParent(current);
      } catch (error) {
        this.#diagnose?.(error);
        return {
          kind: "unverified",
          reason: "Caller Thread delegation lineage could not be verified",
        };
      }
      if (!parent) return { kind: "local" };
      current = parent;
    }
    if (current) {
      if (isPeerOrigin(current)) {
        this.markRemoteOriginThread(threadId, PEER_DELEGATION_MAX_HOPS);
        return { kind: "remote", hops: PEER_DELEGATION_MAX_HOPS };
      }
      return {
        kind: "unverified",
        reason: "Caller Thread delegation lineage exceeded maximum verification depth",
      };
    }
    return { kind: "local" };
  }

  /**
   * Resolve the remote-delegation hop depth of `threadId` for cross-host outbound checks.
   * Fails closed (throws `FORBIDDEN`) if ancestry lookup errors, forms a cycle, or exceeds
   * `MAX_LINEAGE_DEPTH`.
   */
  async resolveRemoteOriginHopCount(threadId: string | undefined): Promise<number> {
    const lineage = await this.#inspectLineage(threadId);
    if (lineage.kind === "remote") return lineage.hops;
    if (lineage.kind === "unverified") {
      throw new DelegationControlError("FORBIDDEN", lineage.reason);
    }
    return 0;
  }

  async #lookupDelegationParent(threadId: string): Promise<string | undefined> {
    const ordered = this.#harnessCatalog
      ? [
          this.#harnessCatalog,
          ...[...this.#registrations].filter((reg) => reg !== this.#harnessCatalog),
        ]
      : [...this.#registrations];
    for (const registration of ordered) {
      if (!registration.delegationParent) continue;
      const parent = await registration.delegationParent(threadId);
      if (parent) return parent;
    }
    return undefined;
  }

  async #findPersistedDelegationByRequest(
    requestId: string,
  ): Promise<PersistedDelegationLookup | null> {
    const ordered = this.#harnessCatalog
      ? [
          this.#harnessCatalog,
          ...[...this.#registrations].filter((reg) => reg !== this.#harnessCatalog),
        ]
      : [...this.#registrations];
    for (const registration of ordered) {
      if (!registration.findDelegationByRequest) continue;
      const match = await registration.findDelegationByRequest(requestId).catch(() => null);
      if (match) return match;
    }
    return null;
  }

  async #runSerializedPeerStart<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#peerStartLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#peerStartLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.#peerStartLocks.get(key) === tail) {
        this.#peerStartLocks.delete(key);
      }
    }
  }

  async #collectActiveNativeThreadIds(): Promise<{ tracked: boolean; ids: Set<string> }> {
    let tracked = false;
    const ids = new Set<string>();
    for (const registration of this.#registrations) {
      if (!registration.activeNativeThreadIds) continue;
      tracked = true;
      const active = await registration.activeNativeThreadIds();
      for (const id of active) ids.add(id);
    }
    return { tracked, ids };
  }

  /**
   * Verify the caller's identity and 1-hop eligibility before issuing any outbound remote request.
   * External Harnesses authenticate with per-Thread HMAC tokens; the shared Runtime token is
   * restricted strictly to active native Codex Threads when tracked.
   */
  async #verifyRemoteCaller(
    authContext: DelegationCallerAuthContext | undefined,
    bodyCallerThreadId: string | undefined,
    hostId: string,
  ): Promise<string | undefined> {
    if (authContext?.kind === "external-client") {
      return undefined;
    }
    if (authContext?.kind === "agent") {
      if (authContext.boundThreadId) {
        if (
          (await this.resolveRemoteOriginHopCount(authContext.boundThreadId)) >=
          PEER_DELEGATION_MAX_HOPS
        ) {
          throw new DelegationControlError(
            "FORBIDDEN",
            "Remote delegation from a remotely initiated Thread is not allowed (hop limit 1)",
          );
        }
        return authContext.boundThreadId;
      }
      const { tracked, ids } = await this.#collectActiveNativeThreadIds();
      let effective = bodyCallerThreadId;
      if (isRemotePeerHostId(hostId)) {
        if (!effective) {
          if (tracked && ids.size === 1) {
            effective = [...ids][0];
          } else {
            throw new DelegationControlError(
              "FORBIDDEN",
              "Caller Thread identity is required for remote peer delegation",
            );
          }
        }
        if (tracked && (!effective || !ids.has(effective))) {
          throw new DelegationControlError(
            "FORBIDDEN",
            "Shared Runtime token may only represent an active native Codex Thread",
          );
        }
      }
      if (
        effective &&
        (await this.resolveRemoteOriginHopCount(effective)) >= PEER_DELEGATION_MAX_HOPS
      ) {
        throw new DelegationControlError(
          "FORBIDDEN",
          "Remote delegation from a remotely initiated Thread is not allowed (hop limit 1)",
        );
      }
      return effective;
    }
    if (
      bodyCallerThreadId &&
      (await this.resolveRemoteOriginHopCount(bodyCallerThreadId)) >= PEER_DELEGATION_MAX_HOPS
    ) {
      throw new DelegationControlError(
        "FORBIDDEN",
        "Remote delegation from a remotely initiated Thread is not allowed (hop limit 1)",
      );
    }
    return bodyCallerThreadId;
  }

  /** Handle an authenticated inbound Peer delegation request arriving over the local Client Channel. */
  async handlePeerDelegationChannelRequest(params: unknown): Promise<{ result: JsonValue }> {
    const result = await dispatchPeerDelegationRequest(this, params, {
      onRemoteThreadStarted: (threadId, hopCount) => {
        this.markRemoteOriginThread(threadId, hopCount);
      },
      ...(this.#diagnose ? { diagnose: this.#diagnose } : {}),
      idempotency: {
        findDelegationByRequest: (requestId) => this.#findPersistedDelegationByRequest(requestId),
        runSerialized: (key, fn) => this.#runSerializedPeerStart(key, fn),
        getCachedStart: (key) => this.#peerStartCache.get(key),
        setCachedStart: (key, entry) => {
          if (this.#peerStartCache.size >= MAX_PEER_START_CACHE) {
            const oldest = this.#peerStartCache.keys().next().value;
            if (oldest !== undefined) this.#peerStartCache.delete(oldest);
          }
          this.#peerStartCache.set(key, entry);
        },
        ...(this.#peerStartStore
          ? {
              getPersistedStart: (requestId) => this.#peerStartStore!.get(requestId),
              savePersistedStart: (record) => this.#peerStartStore!.set(record),
              ...(this.#peerStartStore.delete
                ? {
                    deletePersistedStart: (requestId: string) =>
                      this.#peerStartStore!.delete!(requestId),
                  }
                : {}),
              ...(this.#peerStartStore.claimWorktreeOwner
                ? {
                    claimWorktreeOwner: (
                      target: { path: string; branch: string },
                      requestId: string,
                    ) => this.#peerStartStore!.claimWorktreeOwner!(target, requestId),
                  }
                : {}),
              ...(this.#peerStartStore.getWorktreeOwner
                ? {
                    getWorktreeOwner: (target: { path: string; branch: string }) =>
                      this.#peerStartStore!.getWorktreeOwner!(target),
                  }
                : {}),
              ...(this.#peerStartStore.releaseWorktreeOwner
                ? {
                    releaseWorktreeOwner: (
                      target: { path: string; branch: string },
                      requestId: string,
                    ) => this.#peerStartStore!.releaseWorktreeOwner!(target, requestId),
                  }
                : {}),
            }
          : {}),
      },
    });
    return { result: jsonValueSchema.parse(result) };
  }

  async listHosts(): Promise<PeerDelegationHostsResult> {
    if (!this.#remotePeer) return { hosts: [] };
    return this.#remotePeer.listHosts();
  }

  async #callRemotePeerVerified<T>(
    hostId: string,
    operation: PeerDelegationOperation,
    input: Record<string, unknown>,
    callOptions?: RemotePeerCallOptions,
  ): Promise<T> {
    if (!isRemotePeerHostId(hostId)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Remote Codex Desktop Hosts support thread read only",
      );
    }
    if (!this.#remotePeer) {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "Remote peer delegation is unavailable",
      );
    }
    const payload = jsonValueSchema.parse(input) as JsonObject;
    const request = {
      hostId,
      operation,
      hopCount: 1,
      input: payload,
    };
    return (await (callOptions
      ? this.#remotePeer.call(request, callOptions)
      : this.#remotePeer.call(request))) as T;
  }

  async #callRemotePeer<T>(
    hostId: string,
    operation: PeerDelegationOperation,
    input: Record<string, unknown>,
    authContext: DelegationCallerAuthContext | undefined,
    callerThreadId?: string,
    callOptions?: RemotePeerCallOptions,
  ): Promise<T> {
    await this.#verifyRemoteCaller(authContext, callerThreadId, hostId);
    return this.#callRemotePeerVerified<T>(hostId, operation, input, callOptions);
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
    const unsubscribeIdle = registration.onThreadIdle?.((threadId) =>
      this.#watchService.nudge(threadId),
    );
    return () => {
      unsubscribeIdle?.();
      if (this.#registrations.delete(registration)) this.#registrationGeneration += 1;
      if (this.#harnessCatalog === registration) this.#harnessCatalog = undefined;
    };
  }

  async inspect(input: HarnessInspectInput): Promise<HarnessInspectResult> {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, ...rest } = input;
    if (isRemoteHostId(hostId)) {
      const { parentThreadId: _parent, ...remoteInput } = rest;
      const result = await this.#callRemotePeer<HarnessInspectResult>(
        hostId,
        "inspect",
        remoteInput,
        authContext,
        callerThreadId ?? rest.parentThreadId,
      );
      return { ...result, hostId };
    }
    if (this.#harnessCatalog) return this.#harnessCatalog.inspect(rest);
    const registrations = [...this.#registrations];
    return only(
      registrations,
      "Harness inspection requires exactly one active Host Runtime session",
    ).inspect(rest);
  }

  async listHarnesses(input?: HarnessListInput): Promise<HarnessListResult> {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, ...rest } = input ?? {};
    if (isRemoteHostId(hostId)) {
      const result = await this.#callRemotePeer<HarnessListResult>(
        hostId,
        "listHarnesses",
        {},
        authContext,
        callerThreadId ?? rest.parentThreadId,
      );
      return { ...result, hostId };
    }
    const localInput = Object.keys(rest).length > 0 ? rest : undefined;
    if (this.#harnessCatalog) return this.#harnessCatalog.listHarnesses(localInput);
    return only(
      [...this.#registrations],
      "Harness discovery requires exactly one active Host Runtime session",
    ).listHarnesses(localInput);
  }

  async start(input: DelegationStartInput): Promise<DelegationStartResult> {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, refs: requested, ...start } = input;
    // Validated before anything is created, so a bad reference never leaves a Thread behind.
    const own = normalizeRefs(requested);
    if (isRemoteHostId(hostId)) {
      const { parentThreadId, ...remoteStart } = start;
      const result = await this.#callRemotePeer<DelegationStartResult>(
        hostId,
        "start",
        {
          ...remoteStart,
          ...(own.length > 0 ? { refs: own } : {}),
        },
        authContext,
        callerThreadId ?? parentThreadId,
      );
      return {
        ...result,
        hostId,
        deepLink: remoteThreadLink(result.threadId, hostId),
        next: remoteNextHints(result.threadId, hostId),
      };
    }

    // Resolve trusted caller identity so a remotely-initiated caller cannot launder a local child
    // under a plain parentThreadId, without blocking arbitrarily deep pure-local delegation chains.
    let trustedCaller: string | undefined;
    if (authContext?.kind === "agent") {
      if (authContext.boundThreadId) {
        trustedCaller = authContext.boundThreadId;
      } else if (callerThreadId) {
        trustedCaller = callerThreadId;
      } else {
        const { tracked, ids } = await this.#collectActiveNativeThreadIds();
        if (tracked && ids.size === 1) trustedCaller = [...ids][0];
      }
    } else if (authContext === undefined) {
      trustedCaller = callerThreadId;
    }

    const callerLineage = trustedCaller
      ? await this.#inspectLineage(trustedCaller)
      : ({ kind: "local" } as const);
    let localStart = start;
    if (
      trustedCaller &&
      !isSyntheticOrigin(trustedCaller) &&
      (callerLineage.kind === "remote" ||
        (callerLineage.kind === "unverified" &&
          start.parentThreadId !== undefined &&
          start.parentThreadId !== trustedCaller))
    ) {
      localStart = { ...start, parentThreadId: trustedCaller };
    } else if (
      authContext?.kind === "agent" &&
      authContext.boundThreadId &&
      !start.parentThreadId
    ) {
      localStart = { ...start, parentThreadId: authContext.boundThreadId };
    }

    const parentForPrecheck = localStart.parentThreadId;
    const precheckedParentLineage =
      parentForPrecheck && parentForPrecheck !== trustedCaller
        ? await this.#inspectLineage(parentForPrecheck)
        : callerLineage;

    const result = await (await this.#registrationForStart(localStart)).start(localStart);
    const parent = result.parentThreadId ?? localStart.parentThreadId;
    if (callerLineage.kind === "remote") {
      this.markRemoteOriginThread(result.threadId, callerLineage.hops);
    } else if (precheckedParentLineage.kind === "remote") {
      this.markRemoteOriginThread(result.threadId, precheckedParentLineage.hops);
    }
    if (!this.#refs) return result;
    const inherited = parent && !isSyntheticOrigin(parent) ? await this.#refs.get(parent) : [];
    const refs = mergeRefs(inherited, own);
    if (refs.length > 0) await this.#refs.set(result.threadId, refs, result.cwd, result.title);
    return withRefs(result, refs);
  }

  async send(input: ThreadSendInput): Promise<ThreadSendResult> {
    const authContext = getCallerAuthContext(input);
    if (input.interrupt !== undefined && typeof input.interrupt !== "boolean")
      throw new DelegationControlError("INVALID_ARGUMENT", "interrupt must be a boolean");
    if (input.steer !== undefined && typeof input.steer !== "boolean")
      throw new DelegationControlError("INVALID_ARGUMENT", "steer must be a boolean");
    if (input.steer && input.interrupt)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "steer and interrupt are mutually exclusive",
      );
    const { hostId, callerThreadId, ...local } = input;
    if (isRemoteHostId(hostId)) {
      const result = await this.#callRemotePeer<ThreadSendResult>(
        hostId,
        "send",
        local,
        authContext,
        callerThreadId,
      );
      return {
        ...result,
        hostId,
        next: remoteNextHints(result.threadId, hostId),
      };
    }
    const registration = await this.#registrationForThread(local.threadId);
    if (!local.interrupt) return registration.send(local);
    const send = { threadId: local.threadId, message: local.message };
    return this.#watchService.holdNotifications(local.threadId, () =>
      interruptAndSend(registration, send),
    );
  }

  async cancel(input: ThreadCancelInput): Promise<ThreadCancelResult> {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, ...local } = input;
    if (isRemoteHostId(hostId)) {
      const result = await this.#callRemotePeer<ThreadCancelResult>(
        hostId,
        "cancel",
        local,
        authContext,
        callerThreadId,
      );
      return { ...result, hostId };
    }
    return this.#watchService.cancel(local.threadId, async () =>
      (await this.#registrationForThread(local.threadId)).cancel(local),
    );
  }

  async read(input: ThreadReadInput) {
    const snapshot = await this.#read(input);
    if (isRemoteHostId(snapshot.hostId) && isRemotePeerHostId(snapshot.hostId)) {
      return snapshot;
    }
    return withRefs(snapshot, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async #read(input: ThreadReadInput): Promise<DelegationThreadSnapshot> {
    const authContext = getCallerAuthContext(input);
    const { callerThreadId, ...read } = input;
    if (isRemoteHostId(read.hostId)) {
      const effectiveCallerForSameHost =
        authContext?.kind === "agent" && authContext.boundThreadId
          ? authContext.boundThreadId
          : callerThreadId;
      if (typeof effectiveCallerForSameHost === "string" && effectiveCallerForSameHost) {
        const callers = await this.#matching(
          (registration) =>
            registration.executionHostId?.(effectiveCallerForSameHost) === read.hostId &&
            registration.ownsThread(effectiveCallerForSameHost),
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
      if (isRemotePeerHostId(read.hostId)) {
        const { hostId, ...remoteRead } = read;
        const snapshot = await this.#callRemotePeer<DelegationThreadSnapshot>(
          hostId,
          "read",
          remoteRead,
          authContext,
          callerThreadId,
        );
        if (!snapshot || typeof snapshot !== "object" || snapshot.threadId !== read.threadId) {
          throw new DelegationControlError(
            "INTERNAL_ERROR",
            "Remote Peer returned an invalid Thread snapshot",
          );
        }
        return { ...snapshot, hostId };
      }
      await this.#verifyRemoteCaller(authContext, callerThreadId, read.hostId);
      if (!read.hostId || !this.#remoteRead)
        throw new DelegationControlError(
          "RUNTIME_UNREACHABLE",
          "Remote Thread reading is unavailable",
        );
      return this.#remoteRead(read);
    }
    const { hostId: _localHost, ...localRead } = read;
    return (await this.#registrationForThread(localRead.threadId)).read(localRead);
  }

  async exportThread(input: ThreadExportInput) {
    validateThreadExportInput(input);
    const registration = await this.#registrationForThread(input.threadId);
    if (!registration.exportThread)
      throw new DelegationControlError("UNSUPPORTED", "Thread export is unavailable");
    return registration.exportThread(input);
  }

  async wait(input: ThreadWaitInput) {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, ...rest } = input;
    if (isRemoteHostId(hostId)) {
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "timeoutMs must be a positive integer",
        );
      }
      if (!isRemotePeerHostId(hostId)) {
        await this.#verifyRemoteCaller(authContext, callerThreadId, hostId);
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Remote Codex Desktop Hosts support thread read only",
        );
      }
      const deadline = performance.now() + input.timeoutMs;
      const controller = new AbortController();
      const deadlineTimer = setTimeout(
        () => controller.abort(new Error("timeout")),
        input.timeoutMs,
      );
      try {
        // Bound the single initial caller/lineage check by the same total wait deadline.
        await raceWithAbort(
          this.#verifyRemoteCaller(authContext, callerThreadId, hostId),
          controller.signal,
        );
        if (controller.signal.aborted || performance.now() >= deadline) {
          throw new DelegationControlError(
            "RUNTIME_UNREACHABLE",
            "Timed out waiting for remote Peer Thread snapshot",
            { timedOut: true },
          );
        }
        const snapshot = await waitRemotePeerThread(
          async (readInput, readOptions) => {
            const result = await this.#callRemotePeerVerified<DelegationThreadSnapshot>(
              hostId,
              "read",
              readInput,
              readOptions,
            );
            if (!result || typeof result !== "object" || result.threadId !== readInput.threadId) {
              throw new DelegationControlError(
                "INTERNAL_ERROR",
                "Remote Peer returned an invalid Thread snapshot",
              );
            }
            return { ...result, hostId };
          },
          input,
          {
            deadline,
            signal: controller.signal,
            ...(this.#remoteWaitPollIntervalsMs
              ? { pollIntervalsMs: this.#remoteWaitPollIntervalsMs }
              : {}),
          },
        );
        return { ...snapshot, hostId };
      } finally {
        clearTimeout(deadlineTimer);
      }
    }
    const snapshot = await (await this.#registrationForThread(rest.threadId)).wait(rest);
    return withRefs(snapshot, (await this.#refs?.get(snapshot.threadId)) ?? []);
  }

  async answer(input: ThreadAnswerInput): Promise<ThreadAnswerResult> {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, ...local } = input;
    if (isRemoteHostId(hostId)) {
      const result = await this.#callRemotePeer<ThreadAnswerResult>(
        hostId,
        "answer",
        local,
        authContext,
        callerThreadId,
      );
      return {
        ...result,
        hostId,
        next: remoteNextHints(result.threadId, hostId),
      };
    }
    return (await this.#registrationForThread(local.threadId)).answer(local);
  }

  async watch(input: ThreadWatchInput) {
    if (isRemoteHostId(input.hostId)) {
      throw new DelegationControlError(
        "UNSUPPORTED",
        "Cross-host thread watch is not supported yet",
      );
    }
    const { hostId: _localHost, ...local } = input;
    return this.#watchService.watch(local);
  }

  async watches() {
    return this.#watchService.watches();
  }

  /** Stops watching in this process; stored watches resume in the next Runtime. */
  close(): void {
    this.#watchService.close();
  }

  async list(input: ThreadListInput): Promise<DelegationThreadListResult> {
    const authContext = getCallerAuthContext(input);
    const { hostId, callerThreadId, client, ref, ...rest } = input;
    if (client !== undefined && rest.parentThreadId)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--client and --parent cannot be combined",
      );
    if (isRemoteHostId(hostId)) {
      const result = await this.#callRemotePeer<DelegationThreadListResult>(
        hostId,
        "list",
        {
          ...rest,
          ...(client !== undefined ? { client } : {}),
          ...(ref !== undefined ? { ref } : {}),
        },
        authContext,
        callerThreadId,
      );
      return {
        ...result,
        hostId,
        threads: result.threads.map((thread) => ({
          ...thread,
          hostId,
          deepLink: remoteThreadLink(thread.threadId, hostId),
        })),
      };
    }
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
    if (isSyntheticOrigin(input.parentThreadId)) {
      // A synthetic origin (external client or remote peer) is no local session's Thread.
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
