import { lstat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import { classifyCreateRequestRoute } from "./app-server-host.js";
import {
  threadOwnershipListResultSchema,
  THREAD_TREE_SNAPSHOT_METHOD,
  THREAD_TREE_UNWATCH_METHOD,
  THREAD_TREE_WATCH_METHOD,
  threadTreeWatchResultSchema,
  type ThreadTreeSnapshot,
  LOADED_SESSIONS_METHOD,
  IDLE_RELEASE_SETTINGS_METHOD,
  USAGE_STATISTICS_METHOD,
  SKILLS_LIST_METHOD,
  THREAD_HANDOFF_METHOD,
} from "@codexhost/shared-contracts";
import {
  storedSectionPlacementV1Schema,
  type StoredSectionPlacementV1,
} from "@codexhost/mapping-store";
import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";
import {
  object,
  SHARED_THREAD_LIST_METHOD,
  SHARED_THREAD_OWNERSHIP_METHOD,
  StreamThreadPeer,
  type SharedThreadPeer,
} from "./shared-thread-peer.js";
import {
  SHARED_SECTIONS_CHANGED_METHOD,
  SHARED_SECTIONS_WATCH_METHOD,
} from "./external-thread-sections.js";

export function sharedThreadSocketPath(environment: NodeJS.ProcessEnv): string {
  return path.join(
    environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), ".codex"),
    "app-server-control",
    "codexhost-threads.sock",
  );
}

export async function connectSharedThreads(
  environment: NodeJS.ProcessEnv,
): Promise<SharedThreadPeer | null> {
  if (process.platform === "win32") return null;
  const socketPath = sharedThreadSocketPath(environment);
  const metadata = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (
    !metadata.isSocket() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Shared Thread socket must be private and owned by the current user");
  }
  // An unreachable socket cannot prove that its owner has no section members.
  const connection = await createRemoteOfficialAppServerConnection(socketPath);
  connection.stderr.resume();
  return new StreamThreadPeer(connection.stdout, connection.stdin, () => connection.close());
}

const SHARED_LIST_REUSE_MS = 5_000;
// The shared Host announces most of these with a `thread/*` notification, but a
// section move has none, and a GUI rereads its lists as soon as the reply lands.
const LIST_CHANGING_METHODS = new Set([
  "codexhost/thread/pins/set",
  "codexhost/thread/sections/move",
  "thread/archive",
  "thread/delete",
  "thread/fork",
  "thread/metadata/update",
  "thread/name/set",
  "thread/revert",
  "thread/rollback",
  "thread/section/move",
  "thread/start",
  "thread/unarchive",
  THREAD_HANDOFF_METHOD,
]);

/** A GUI keeps its native Codex connection and forwards only shared external Threads. */
export class SharedThreadBridge {
  readonly #known = new Set<string>();
  #localProbe: ((threadId: string) => Promise<boolean>) | undefined;

  setLocalOwnershipProbe(probe: (threadId: string) => Promise<boolean>): void {
    this.#localProbe = probe;
  }

  #treeListener: ((snapshot: ThreadTreeSnapshot | null) => void) | undefined;
  #treeAttempt: { peer: SharedThreadPeer; id?: string; revision?: number } | undefined;
  #treeDiagnosed = false;

  #peer: SharedThreadPeer | null = null;
  #peerMayExist = false;
  #connecting: Promise<SharedThreadPeer | null> | null = null;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;
  #sectionWatchPeer: SharedThreadPeer | undefined;
  #sectionWatchNeedsRefresh = false;
  #publish: (message: JsonObject) => void = () => undefined;
  // A client pages its own catalog while each of its pages needs every shared row. One shared
  // walk per query serves those pages; a Thread notification or a new peer starts a fresh walk.
  readonly #lists = new Map<
    string,
    {
      generation: number;
      startedAtMs: number;
      pending: boolean;
      rows: Promise<JsonObject[] | null>;
    }
  >();
  #listGeneration = 0;

  constructor(
    readonly options: {
      connect(): Promise<SharedThreadPeer | null>;
      delegateCreates: boolean;
      /** This peer shares the viewer's official Runtime and Mapping Store. */
      ownsNativeSections?: boolean;
      diagnose(error: unknown): void;
      now?: () => number;
    },
  ) {}

  #invalidateLists(): void {
    this.#listGeneration += 1;
    this.#lists.clear();
  }

  start(publish: (message: JsonObject) => void): void {
    this.#publish = publish;
    const discover = (): void => {
      if (this.#peer) this.#watchSections(this.#peer);
      else void this.#connect().catch(this.options.diagnose);
    };
    discover();
    this.#timer = setInterval(discover, 3_000);
    this.#timer.unref();
  }

  async #connect(): Promise<SharedThreadPeer | null> {
    if (this.#closed) return null;
    if (this.#peer) return this.#peer;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.options
      .connect()
      .then(async (peer) => {
        if (!peer) return null;
        if (this.#closed) {
          peer.close();
          return null;
        }
        this.#peer = peer;
        this.#peerMayExist = true;
        peer.subscribe((message) => {
          if (message.method === SHARED_SECTIONS_CHANGED_METHOD) {
            this.#invalidateLists();
            this.#publish(message);
            return;
          }
          if (typeof message.method === "string" && message.method.startsWith("thread/")) {
            this.#invalidateLists();
          }
          if (message.method === THREAD_TREE_SNAPSHOT_METHOD) {
            const result = threadTreeWatchResultSchema.safeParse(message.params);
            const attempt = this.#treeAttempt;
            if (
              result.success &&
              attempt?.peer === peer &&
              attempt.id === result.data.subscriptionId
            )
              this.#acceptTree(attempt, result.data.snapshot);
            return;
          }
          const params = object(message.params) ? message.params : {};
          if (
            object(params.thread) &&
            params.thread.modelProvider === "codexhost" &&
            typeof params.thread.id === "string"
          ) {
            this.#known.add(params.thread.id);
          }
          this.#publish(message);
        });
        void peer.closed.then(() => {
          if (this.#peer === peer) {
            this.#peer = null;
            this.#sectionWatchPeer = undefined;
            this.#sectionWatchNeedsRefresh = true;
          }
          if (this.#treeAttempt?.peer === peer) {
            this.#treeAttempt = undefined;
            this.#treeListener?.(null);
            this.#diagnoseTree(new Error("Shared Thread tree owner disconnected"));
          }
          this.#invalidateLists();
        });
        this.#watchSections(peer);
        this.#startTree(peer);
        // History is read through thread/list. Replaying it as thread/started makes each
        // downstream viewer rebuild its catalog once per historical Thread.
        return peer;
      })
      .catch((error: unknown) => {
        // Only clean absence before any evidence of a peer can mean standalone.
        this.#peerMayExist = true;
        this.#peer?.close();
        this.#peer = null;
        throw error;
      })
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  #watchSections(peer: SharedThreadPeer): void {
    if (this.#sectionWatchPeer === peer) return;
    this.#sectionWatchPeer = peer;
    void peer
      .request(SHARED_SECTIONS_WATCH_METHOD, {})
      .then((reply) => {
        if (this.#peer !== peer) return;
        if (object(reply.error) && reply.error.code === -32601) return;
        if (reply.error !== undefined || !object(reply.result)) {
          throw new Error(
            object(reply.error)
              ? String(reply.error.message ?? "Shared section watch failed")
              : "Invalid shared section watch reply",
          );
        }
        if (!this.#sectionWatchNeedsRefresh) return;
        this.#sectionWatchNeedsRefresh = false;
        this.#invalidateLists();
        this.#publish({ method: SHARED_SECTIONS_CHANGED_METHOD, params: {} });
      })
      .catch((error: unknown) => {
        if (this.#peer !== peer) return;
        // Only the discovery timer retries; catalog reads never create a retry storm.
        this.#sectionWatchPeer = undefined;
        if (this.#sectionWatchNeedsRefresh) return;
        this.#sectionWatchNeedsRefresh = true;
        this.options.diagnose(error);
      });
  }

  knowsTreeOwner(id: string): boolean {
    return this.#known.has(id);
  }

  watchTree(listener: (snapshot: ThreadTreeSnapshot | null) => void): () => void {
    this.#treeListener = listener;
    void this.#connect().then(
      (peer) => {
        if (peer) this.#startTree(peer);
        else if (this.#treeListener === listener)
          this.#diagnoseTree(new Error("Shared Thread tree owner unavailable"));
      },
      (error) => this.#diagnoseTree(error),
    );
    return () => {
      if (this.#treeListener !== listener) return;
      this.#treeListener = undefined;
      const attempt = this.#treeAttempt;
      this.#treeAttempt = undefined;
      if (attempt?.id)
        void attempt.peer
          .request(THREAD_TREE_UNWATCH_METHOD, { subscriptionId: attempt.id })
          .catch(() => undefined);
    };
  }

  #diagnoseTree(error: unknown): void {
    if (this.#treeDiagnosed) return;
    this.#treeDiagnosed = true;
    this.options.diagnose(error);
  }

  #startTree(peer: SharedThreadPeer): void {
    if (!this.#treeListener || this.#treeAttempt?.peer === peer) return;
    const attempt: { peer: SharedThreadPeer; id?: string; revision?: number } = { peer };
    this.#treeAttempt = attempt;
    void peer
      .request(THREAD_TREE_WATCH_METHOD, {})
      .then((response) => {
        const result = threadTreeWatchResultSchema.parse(response.result);
        if (this.#treeAttempt !== attempt) {
          return peer.request(THREAD_TREE_UNWATCH_METHOD, {
            subscriptionId: result.subscriptionId,
          });
        }
        attempt.id = result.subscriptionId;
        this.#acceptTree(attempt, result.snapshot);
      })
      .catch((error: unknown) => {
        if (this.#treeAttempt === attempt) this.#diagnoseTree(error);
      });
  }

  #acceptTree(attempt: { revision?: number }, snapshot: ThreadTreeSnapshot): void {
    if (attempt.revision !== undefined && snapshot.revision <= attempt.revision) return;
    attempt.revision = snapshot.revision;
    for (const [id, node] of Object.entries(snapshot.nodes)) {
      if (node.harnessId !== "codex") this.#known.add(id);
    }
    this.#treeListener?.(snapshot);
  }

  async ownership(threadIds: string[], requireComplete = false): Promise<Map<string, string>> {
    if (threadIds.length === 0) return new Map();
    try {
      const peer = await this.#connect();
      if (!peer) {
        if (requireComplete && !this.#peerMayExist && !this.options.delegateCreates)
          return new Map();
        throw new Error("Shared Thread Host is disconnected");
      }
      return await this.#readOwnership(peer, threadIds, requireComplete);
    } catch (error) {
      if (requireComplete) throw error;
      if (threadIds.some((id) => this.#known.has(id))) throw error;
      // A local read permits fallback for this lookup only; it may be a copy of a shared Thread.
      const probe = this.#localProbe;
      if (probe && (await Promise.all(threadIds.map((id) => probe(id)))).every(Boolean)) {
        return new Map();
      }
      if (this.options.delegateCreates) throw error;
      this.options.diagnose(error);
      return new Map();
    }
  }

  async #readOwnership(
    peer: SharedThreadPeer,
    threadIds: string[],
    requireComplete = false,
  ): Promise<Map<string, string>> {
    const response = await peer.request(
      requireComplete ? SHARED_THREAD_OWNERSHIP_METHOD : "codexhost/thread/ownership/list",
      { threadIds },
    );
    const result = threadOwnershipListResultSchema.parse(response.result);
    if (requireComplete) {
      const requested = new Set(threadIds);
      if (
        result.threads.length !== requested.size ||
        result.threads.some(({ threadId }) => !requested.has(threadId))
      )
        throw new Error("Incomplete shared Thread ownership");
    }
    const owners = new Map<string, string>();
    for (const thread of result.threads) {
      if (thread.owner === "external") {
        owners.set(thread.threadId, thread.harnessId);
        this.#known.add(thread.threadId);
      }
    }
    return owners;
  }

  handlesControl(method: string): boolean {
    return (
      this.options.delegateCreates &&
      [
        LOADED_SESSIONS_METHOD,
        IDLE_RELEASE_SETTINGS_METHOD,
        USAGE_STATISTICS_METHOD,
        SKILLS_LIST_METHOD,
        THREAD_HANDOFF_METHOD,
      ].some((value) => value === method)
    );
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const peer = await this.#connect();
    if (!peer) throw new Error("Shared Thread Host is disconnected");
    const reply = await peer.request(method, params);
    if (LIST_CHANGING_METHODS.has(method)) this.#invalidateLists();
    return reply;
  }

  async routeSectionWrite(
    request: JsonRpcRequest,
    isLocalNativeThread: (threadId: string) => Promise<boolean>,
  ): Promise<JsonObject | null> {
    const params = object(request.params) ? request.params : {};
    const { threadId, beforeThreadId } = params;
    if (typeof threadId !== "string") return null;
    let peer: SharedThreadPeer | null = null;
    let owned = this.#known.has(threadId);
    try {
      peer = await this.#connect();
      if (peer) {
        owned ||= this.options.ownsNativeSections === true;
        if (!owned) {
          const ids =
            typeof beforeThreadId === "string" && beforeThreadId !== threadId
              ? [threadId, beforeThreadId]
              : [threadId];
          owned = (await this.#readOwnership(peer, ids)).has(threadId);
        }
      }
    } catch (error) {
      this.options.diagnose(error);
    }
    if (peer && owned) {
      // Once submitted to an Owner, even a lost reply must not cause a local write.
      const reply = await peer.request(request.method, params);
      this.#invalidateLists();
      return { ...reply, id: request.id };
    }
    if (
      !owned &&
      (await isLocalNativeThread(threadId)) &&
      (typeof beforeThreadId !== "string" ||
        beforeThreadId === threadId ||
        (!this.#known.has(beforeThreadId) && (await isLocalNativeThread(beforeThreadId))))
    )
      return null;
    throw new Error("Thread section owner is unavailable");
  }

  async route(request: JsonRpcRequest): Promise<JsonObject | null> {
    const params = object(request.params) ? request.params : {};
    const create = this.options.delegateCreates ? classifyCreateRequestRoute(request) : null;
    let shared =
      (create !== null && create.selectedHarness !== "codex") ||
      (this.options.delegateCreates && request.method.startsWith("codexhost/harness/")) ||
      this.handlesControl(request.method);
    const routedThreadId =
      typeof params.threadId === "string"
        ? params.threadId
        : request.method === THREAD_HANDOFF_METHOD && typeof params.sourceThreadId === "string"
          ? params.sourceThreadId
          : null;
    if (!shared && routedThreadId !== null) {
      shared =
        this.#known.has(routedThreadId) ||
        (await this.ownership([routedThreadId])).has(routedThreadId);
    }
    if (!shared) return null;
    const peer = await this.#connect();
    if (!peer) throw new Error("Shared Thread Host is disconnected");
    const reply = await peer.request(request.method, params);
    if (LIST_CHANGING_METHODS.has(request.method)) this.#invalidateLists();
    return { ...reply, id: request.id };
  }

  async #rows(
    peer: SharedThreadPeer,
    params: JsonObject,
    requireComplete: boolean,
  ): Promise<JsonObject[]> {
    const method = requireComplete ? SHARED_THREAD_LIST_METHOD : "thread/list";
    const rows: JsonObject[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const reply = await peer.request(method, { ...params, cursor, limit: 200 });
      if (reply.error !== undefined || !object(reply.result) || !Array.isArray(reply.result.data))
        throw new Error("Shared Thread list failed");
      if (requireComplete && reply.result.complete !== true)
        throw new Error("Shared Thread Host did not confirm complete Thread list");
      for (const row of reply.result.data) {
        if (!object(row) || typeof row.id !== "string")
          throw new Error("Invalid shared Thread row");
        rows.push(row);
        this.#known.add(row.id);
      }
      const next = reply.result.nextCursor;
      if (next !== null && typeof next !== "string")
        throw new Error("Invalid shared Thread cursor");
      if (typeof next === "string" && seen.has(next))
        throw new Error("Shared Thread pagination did not advance");
      cursor = next;
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return rows;
  }

  /** Every shared row of one query; the caller's own cursor and page size do not apply. */
  async list(
    params: JsonObject,
    { requireComplete = false }: { requireComplete?: boolean } = {},
  ): Promise<readonly JsonObject[]> {
    const query: JsonObject = { ...params };
    delete query.cursor;
    delete query.limit;
    if (query.sortKey === "section_position") query.sortKey = "updated_at";
    const key = JSON.stringify([requireComplete, query]);
    const now = this.options.now ?? Date.now;
    try {
      const cached = this.#lists.get(key);
      let rows: JsonObject[] | null;
      if (
        cached &&
        cached.generation === this.#listGeneration &&
        now() - cached.startedAtMs < SHARED_LIST_REUSE_MS &&
        // A new strict walk checks the nested peer again; continuations can reuse it.
        (!requireComplete || cached.pending || typeof params.cursor === "string")
      ) {
        rows = await cached.rows;
      } else {
        // Registered before any await so concurrent pages join this walk.
        const entry = {
          generation: this.#listGeneration,
          startedAtMs: now(),
          pending: true,
          rows: this.#connect().then((peer) =>
            peer ? this.#rows(peer, query, requireComplete) : null,
          ),
        };
        this.#lists.set(key, entry);
        const forget = (): void => {
          if (this.#lists.get(key) === entry) this.#lists.delete(key);
        };
        entry.rows.then((rows) => {
          entry.pending = false;
          if (rows === null) forget();
        }, forget);
        rows = await entry.rows;
      }
      if (rows === null && requireComplete && (this.#peerMayExist || this.options.delegateCreates))
        throw new Error("Shared Thread Host is disconnected");
      return rows ?? [];
    } catch (error) {
      if (requireComplete) throw error;
      this.options.diagnose(error);
      return [];
    }
  }

  async placements(requireComplete = false): Promise<StoredSectionPlacementV1[]> {
    try {
      const peer = await this.#connect();
      if (!peer) {
        if (requireComplete && (this.#peerMayExist || this.options.delegateCreates))
          throw new Error("Shared Thread Host is disconnected");
        return [];
      }
      const reply = await peer.request(
        "codexhost/shared-threads/placements",
        requireComplete ? { requireComplete } : {},
      );
      const result = reply.result;
      if (requireComplete && !object(result))
        throw new Error("Shared Thread Host did not confirm complete section placements");
      return storedSectionPlacementV1Schema
        .array()
        .parse(requireComplete && object(result) ? result.placements : result);
    } catch (error) {
      if (requireComplete) throw error;
      this.options.diagnose(error);
      return [];
    }
  }

  async respond(message: unknown): Promise<boolean> {
    if (
      !object(message) ||
      typeof message.method === "string" ||
      typeof message.id !== "string" ||
      !message.id.startsWith("shared-interaction:")
    )
      return false;
    if (!this.#peer) throw new Error("Shared Thread Host is disconnected");
    await this.#peer.respond(message);
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#invalidateLists();
    clearInterval(this.#timer);
    this.#peer?.close();
    this.#peer = null;
  }
}
