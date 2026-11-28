import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import {
  THREAD_TREE_MAX_NODES,
  THREAD_TREE_SNAPSHOT_METHOD,
  THREAD_TREE_UNWATCH_METHOD,
  THREAD_TREE_WATCH_METHOD,
  threadTreeSnapshotSchema,
  threadTreeUnwatchParamsSchema,
  threadTreeWatchParamsSchema,
  type ThreadTreeSnapshot,
  type HostThreadId,
  type ThreadTreeStatus,
} from "@codexhost/shared-contracts";
import type { ClientChannelEvents } from "./client-channel-events.js";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import { object, rpcId } from "./shared-thread-peer.js";
import type { SharedThreadBridge } from "./shared-thread-bridge.js";
import type { ThreadTree } from "./thread-tree.js";

const COALESCE_MS = 250;
const INITIAL_READ_LIMIT = 32;
const INITIAL_READ_CONCURRENCY = 4;
const INITIAL_REPLY_BUDGET_MS = 200;

export interface ThreadTreeHandoffEdgeInput {
  readonly targetThreadId: string;
  readonly handoff: {
    readonly sourceThreadId: string;
    readonly createdAtMs: number;
  };
}

export function limitTreeEdges(
  parents: Readonly<Record<string, string>>,
  handoffs: readonly ThreadTreeHandoffEdgeInput[] = [],
) {
  const ids = new Set<string>();
  const edges: Array<[string, string]> = [];
  const boundedHandoffs: Array<[string, { sourceThreadId: string; createdAtMs: number }]> = [];
  let truncated = false;
  for (const [child, parent] of Object.entries(parents)) {
    const added = Number(!ids.has(child)) + Number(child !== parent && !ids.has(parent));
    if (ids.size + added > THREAD_TREE_MAX_NODES) {
      truncated = true;
      continue;
    }
    ids.add(child);
    ids.add(parent);
    edges.push([child, parent]);
  }
  const sortedHandoffs = [...handoffs].sort(
    (left, right) =>
      right.handoff.createdAtMs - left.handoff.createdAtMs ||
      String(left.targetThreadId).localeCompare(String(right.targetThreadId)),
  );
  const seenTargets = new Set<string>();
  for (const entry of sortedHandoffs) {
    const target = String(entry.targetThreadId);
    const source = String(entry.handoff.sourceThreadId);
    if (!target || !source || target === source || seenTargets.has(target)) continue;
    const added = Number(!ids.has(target)) + Number(!ids.has(source));
    if (ids.size + added > THREAD_TREE_MAX_NODES) {
      truncated = true;
      continue;
    }
    seenTargets.add(target);
    ids.add(target);
    ids.add(source);
    boundedHandoffs.push([
      target,
      {
        sourceThreadId: source,
        createdAtMs: Math.max(0, Math.trunc(entry.handoff.createdAtMs)),
      },
    ]);
  }
  return {
    ids,
    parents: Object.fromEntries(edges),
    handoffs: Object.fromEntries(boundedHandoffs),
    truncated,
  };
}

export function limitTreeParents(parents: Readonly<Record<string, string>>) {
  const { ids, parents: boundedParents, truncated } = limitTreeEdges(parents);
  return { ids, parents: boundedParents, truncated };
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value < 1e12 ? value * 1_000 : value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return undefined;
}

function officialStatus(status: unknown): ThreadTreeStatus {
  if (!object(status)) return "unknown";
  if (status.type === "idle") return "idle";
  if (status.type !== "active") return "unknown";
  return Array.isArray(status.activeFlags) &&
    status.activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
    ? "waiting"
    : "running";
}

type OfficialNode = {
  status?: ThreadTreeStatus;
  title?: string;
  archived?: boolean;
  updatedAtMs?: number;
  turnId?: string;
};

export class ThreadTreeWatch {
  readonly #subscriptions = new Set<string>();
  readonly #ready = new Set<string>();
  readonly #official = new Map<string, OfficialNode>();
  readonly #read = new Set<string>();
  readonly #interactions = new Map<string | number, string>();
  readonly #stopEvents: () => void;
  #archiveDirectory: string | undefined;
  #stopOwner: (() => void) | undefined;
  #owner: ThreadTreeSnapshot | null = null;
  #closed = false;
  #revision = 0;
  #timer: NodeJS.Timeout | undefined;
  #readsInFlight = 0;
  #officialGeneration = 0;
  #last: string | undefined;
  #pushInFlight = false;
  #dirty = false;

  constructor(
    private readonly options: {
      codexHome: string;
      tree: Pick<ThreadTree, "read">;
      repository: Pick<ExternalThreadRepository, "listSummaries"> &
        Partial<Pick<ExternalThreadRepository, "listThreadHandoffs">>;
      events: ClientChannelEvents;
      shared?: SharedThreadBridge | undefined;
      externalOnly?: boolean | undefined;
      localStatus(id: string): ThreadTreeStatus | undefined;
      waiting(id: string): boolean;
      readOfficial(id: string): Promise<JsonObject>;
      send(message: JsonObject): Promise<void>;
      diagnose(error: unknown): void;
    },
  ) {
    this.#stopEvents = options.events.subscribe((event) => {
      if (
        event.type === "changed" &&
        /tree\/changed|pins\/changed|name\/updated|title|archiv|turn\/(started|completed)|status\/changed|questions\/updated|serverRequest\/resolved/u.test(
          event.method,
        )
      )
        this.changed();
    });
  }

  observe(value: JsonValue, official = false): void {
    if (!object(value) || !object(value.params) || typeof value.method !== "string") return;
    const { method, params } = value;
    if (typeof params.threadId !== "string") return;
    const id = params.threadId;
    if (method === "thread/deleted") {
      this.forget(id);
      return;
    }
    const turn = object(params.turn) ? params.turn : {};
    if (official) {
      const before = this.#official.get(id) ?? {};
      if (method === "thread/status/changed") {
        this.#official.set(id, {
          ...before,
          status: officialStatus(params.status),
          updatedAtMs: Date.now(),
        });
      } else if (method === "turn/started") {
        this.#official.set(id, {
          ...before,
          status: "running",
          updatedAtMs: Date.now(),
          ...(typeof turn.id === "string" ? { turnId: turn.id } : {}),
        });
      } else if (method === "turn/completed" && (!before.turnId || before.turnId === turn.id)) {
        const next: OfficialNode = { ...before, status: "idle", updatedAtMs: Date.now() };
        delete next.turnId;
        this.#official.set(id, next);
        for (const [requestId, threadId] of this.#interactions)
          if (threadId === id) this.#interactions.delete(requestId);
      } else if (method === "thread/closed") {
        this.#official.set(id, { ...before, status: "unknown" });
        for (const [requestId, threadId] of this.#interactions)
          if (threadId === id) this.#interactions.delete(requestId);
      } else if (method === "thread/name/updated" && typeof params.threadName === "string") {
        this.#official.set(id, { ...before, title: params.threadName });
      } else if (method === "thread/archived" || method === "thread/unarchived") {
        this.#official.set(id, { ...before, archived: method === "thread/archived" });
      } else if (
        rpcId(value.id) &&
        /requestApproval|requestUserInput|elicitation\/request|review\/request/u.test(method)
      ) {
        this.#interactions.set(value.id, id);
        this.#official.set(id, { ...before, status: "running" });
      } else if (method === "serverRequest/resolved" && rpcId(params.requestId)) {
        this.resolveOfficial(params.requestId);
      }
    }
    if (
      /^turn\/(started|completed)$|^thread\/(closed|status\/changed|name\/updated|archived|unarchived)$|requestApproval|requestUserInput|review\/request|serverRequest\/resolved/u.test(
        method,
      )
    )
      this.changed();
  }

  resolveOfficial(id: string | number): void {
    if (this.#interactions.delete(id)) this.changed();
  }

  /** A deleted Thread: drop what was read about it, so snapshots stop carrying it. */
  forget(id: string): void {
    this.#official.delete(id);
    this.#read.delete(id);
    for (const [requestId, threadId] of this.#interactions)
      if (threadId === id) this.#interactions.delete(requestId);
    this.changed();
  }

  resetOfficial(): void {
    this.#officialGeneration++;
    this.#official.clear();
    this.#read.clear();
    this.#interactions.clear();
    this.changed();
  }

  async handle(request: JsonRpcRequest): Promise<boolean> {
    if (
      request.method !== THREAD_TREE_WATCH_METHOD &&
      request.method !== THREAD_TREE_UNWATCH_METHOD
    )
      return false;
    if (request.method === THREAD_TREE_UNWATCH_METHOD) {
      const result = threadTreeUnwatchParamsSchema.safeParse(request.params);
      if (result.success) this.release(result.data.subscriptionId);
      await this.options.send(
        result.success
          ? rpcEnvelope(request, { result: {} })
          : rpcError(request, -32602, "Invalid Thread tree subscription"),
      );
      return true;
    }
    if (!threadTreeWatchParamsSchema.safeParse(request.params ?? {}).success) {
      await this.options.send(rpcError(request, -32602, "Invalid Thread tree watch parameters"));
      return true;
    }
    if (this.#closed) return true;
    const subscriptionId = randomUUID();
    this.#subscriptions.add(subscriptionId);
    this.#stopOwner ??= this.options.shared?.watchTree((snapshot) => {
      this.#owner = snapshot;
      this.changed();
    });
    try {
      const snapshot = await this.#snapshot(true);
      if (this.#subscriptions.has(subscriptionId)) {
        await this.options.send(rpcEnvelope(request, { result: { subscriptionId, snapshot } }));
        if (this.#subscriptions.has(subscriptionId)) {
          this.#ready.add(subscriptionId);
          this.changed();
        }
      }
    } catch (error) {
      this.release(subscriptionId);
      await this.options.send(rpcError(request, -32603, "Could not read Thread tree"));
      this.options.diagnose(error);
    }
    return true;
  }

  release(id: string): void {
    this.#subscriptions.delete(id);
    this.#ready.delete(id);
    if (this.#subscriptions.size) return;
    this.#stopOwner?.();
    this.#stopOwner = undefined;
    this.#owner = null;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#last = undefined;
  }

  close(): void {
    this.#closed = true;
    for (const id of this.#subscriptions) this.release(id);
    this.#stopEvents();
  }

  /** On-demand read for Web extension clients without creating a long-lived desktop subscription. */
  async readSnapshot(): Promise<ThreadTreeSnapshot> {
    if (this.#closed) {
      return {
        revision: this.#revision,
        parents: {},
        handoffs: {},
        nodes: {},
        truncated: false,
      };
    }
    return threadTreeSnapshotSchema.parse(await this.#snapshot(true, true));
  }

  changed(): void {
    if (!this.#subscriptions.size || this.#timer) return;
    if (this.#pushInFlight) {
      this.#dirty = true;
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pushInFlight = true;
      void this.#push()
        .catch(this.options.diagnose)
        .finally(() => {
          this.#pushInFlight = false;
          if (this.#dirty) {
            this.#dirty = false;
            this.changed();
          }
        });
    }, COALESCE_MS);
    this.#timer.unref();
  }

  async #push(): Promise<void> {
    const subscribers = [...this.#ready];
    if (!subscribers.length) return;
    const snapshot = await this.#snapshot(false);
    const fingerprint = JSON.stringify({ ...snapshot, revision: 0 });
    if (fingerprint === this.#last) return;
    this.#last = fingerprint;
    await Promise.all(
      subscribers
        .filter((id) => this.#subscriptions.has(id))
        .map((subscriptionId) =>
          this.options.send({
            method: THREAD_TREE_SNAPSHOT_METHOD,
            params: { subscriptionId, snapshot },
          }),
        ),
    );
  }

  async #snapshot(initial: boolean, onDemand = false) {
    const [{ parents }, records, storedHandoffs] = await Promise.all([
      this.options.tree.read(),
      this.options.repository.listSummaries(),
      this.options.repository.listThreadHandoffs?.() ?? Promise.resolve([]),
    ]);
    const handoffRecords: ThreadTreeHandoffEdgeInput[] = [...storedHandoffs];
    if (this.#owner?.handoffs) {
      const seen = new Set(handoffRecords.map((entry) => String(entry.targetThreadId)));
      for (const [target, info] of Object.entries(this.#owner.handoffs)) {
        if (seen.has(target)) continue;
        handoffRecords.push({
          targetThreadId: target,
          handoff: {
            sourceThreadId: String(info.sourceThreadId),
            createdAtMs: info.createdAtMs,
          },
        });
      }
    }
    const bounded = limitTreeEdges(parents, handoffRecords);
    const external = new Map(records.map((record) => [String(record.hostThreadId), record]));
    if (!this.options.externalOnly) {
      const candidates = [...bounded.ids].filter(
        (id) =>
          !external.has(id) && !this.options.shared?.knowsTreeOwner(id) && !this.#read.has(id),
      );
      const reads = this.#readInitial(candidates, onDemand);
      if (initial) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            reads,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, INITIAL_REPLY_BUDGET_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    }
    const waiting = new Set(this.#interactions.values());
    const nodes = Object.fromEntries(
      [...bounded.ids].map((id) => {
        const record = external.get(id);
        const local = this.options.localStatus(id);
        const owner =
          this.#owner && Object.hasOwn(this.#owner.nodes, id)
            ? this.#owner.nodes[id as HostThreadId]
            : undefined;
        const shared =
          this.options.shared?.knowsTreeOwner(id) ||
          (record && this.options.shared?.options.delegateCreates && local === undefined);
        const observed = this.#official.get(id);
        const title = record?.title || owner?.title || observed?.title;
        const harnessId = record?.harnessId ?? owner?.harnessId ?? "codex";
        const status = shared
          ? (owner?.status ?? "unknown")
          : waiting.has(id) || this.options.waiting(id)
            ? "waiting"
            : (local ?? (record ? "idle" : (observed?.status ?? "unknown")));
        const updatedAtMs =
          normalizeTimestampMs(record?.updatedAt) ?? owner?.updatedAtMs ?? observed?.updatedAtMs;
        return [
          id,
          {
            harnessId,
            ...(title ? { title } : {}),
            status,
            archived: record?.archived ?? (shared ? owner?.archived : observed?.archived) ?? false,
            ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
          },
        ];
      }),
    );
    return {
      revision: ++this.#revision,
      parents: bounded.parents,
      handoffs: bounded.handoffs,
      nodes,
      truncated: bounded.truncated,
    };
  }

  async #officialArchived(thread: JsonObject): Promise<boolean | undefined> {
    if (typeof thread.archived === "boolean") return thread.archived;
    if (typeof thread.path !== "string" || !path.isAbsolute(thread.path)) return;
    const compare = (value: string): string => {
      const stripped = process.platform === "win32" ? value.replace(/^\\\\\?\\/u, "") : value;
      return process.platform === "win32" ? stripped.toLowerCase() : stripped;
    };
    const directory = path.dirname(path.normalize(thread.path));
    if (compare(path.basename(directory)) !== "archived_sessions") return;
    const archiveDirectory = path.resolve(this.options.codexHome, "archived_sessions");
    if (compare(directory) === compare(archiveDirectory)) return true;
    const resolvedArchive =
      this.#archiveDirectory ?? (await realpath(archiveDirectory).catch(() => null)) ?? null;
    if (resolvedArchive === null) return;
    this.#archiveDirectory = resolvedArchive;
    const target = compare(resolvedArchive);
    if (compare(directory) === target) return true;
    const resolvedDirectory = await realpath(directory).catch(() => null);
    if (resolvedDirectory !== null && compare(resolvedDirectory) === target) return true;
  }

  async #readInitial(ids: string[], allowEmptySubscriptions = false): Promise<void> {
    const generation = this.#officialGeneration;
    const batch = ids.slice(0, INITIAL_READ_LIMIT);
    const count = Math.max(0, INITIAL_READ_CONCURRENCY - this.#readsInFlight);
    await Promise.all(
      Array.from({ length: Math.min(count, batch.length) }, async () => {
        this.#readsInFlight++;
        try {
          while (
            !this.#closed &&
            (this.#subscriptions.size > 0 || allowEmptySubscriptions) &&
            generation === this.#officialGeneration
          ) {
            const id = batch.shift();
            if (!id) break;
            if (this.#read.has(id)) continue;
            this.#read.add(id);
            const thread = await this.options.readOfficial(id).then(
              (reply) =>
                object(reply.result) && object(reply.result.thread) ? reply.result.thread : null,
              () => null,
            );
            if (thread?.id !== id) continue;
            const archived = await this.#officialArchived(thread);
            if (!this.#read.has(id) || this.#closed || generation !== this.#officialGeneration)
              continue;
            const before = this.#official.get(id);
            const updatedAtMs =
              normalizeTimestampMs(thread.updatedAt) ?? normalizeTimestampMs(thread.createdAt);
            this.#official.set(id, {
              ...(typeof thread.name === "string" ? { title: thread.name } : {}),
              ...(archived === undefined ? {} : { archived }),
              ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
              ...before,
              status: before?.status ?? officialStatus(thread.status),
            });
            if (this.#subscriptions.size > 0) this.changed();
          }
        } finally {
          this.#readsInFlight--;
          // A scan after reconnect may have found all read slots still occupied.
          if (generation !== this.#officialGeneration && this.#subscriptions.size > 0)
            this.changed();
        }
      }),
    );
  }
}
