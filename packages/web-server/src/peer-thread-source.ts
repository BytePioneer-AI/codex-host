import { z } from "zod";
import {
  harnessCommandCatalogSchema,
  REMOTE_PEER_ID_PATTERN,
  remotePeerHostId,
  skillsListResultSchema,
  threadOwnershipSchema,
  type HarnessCommandCatalog,
  type SkillsListParams,
  type SkillsListResult,
} from "@codexhost/shared-contracts";
import { ChHarnessCatalog } from "./ch-harness-catalog.ts";
import { ChRealtime } from "./ch-realtime.ts";
import { nextCatalogCursor, readSessionPage } from "./ch-session-page.ts";
import { ChThreadHistory } from "./ch-thread-history.ts";
import type { ChThread } from "./ch-thread-view.ts";
import { ChThreadTree } from "./ch-thread-tree.ts";
import { harnessIconStyles } from "./harness-icon-styles.ts";
import type { PeerChHostClient } from "./peer-ch-host-client.ts";
import { remoteThreadRowSchema } from "./remote-session-history.ts";
import type { ProjectionListener } from "./session-log.ts";
import { SessionListTiming } from "./session-list-timing.ts";
import { EventHub, RpcError } from "./transport.ts";

const MAX_CATALOG_PAGES = 100;
const REMOTE_THREAD_DEBOUNCE_MS = 450;
const legacyListPageSchema = z.object({
  data: z.array(remoteThreadRowSchema),
  nextCursor: z.string().nullable(),
});

export function isMethodUnavailableError(error: unknown): boolean {
  if (error instanceof RpcError) {
    if (error.code === "host/method-unavailable") return true;
    const hostCode = (error.details as { hostCode?: unknown }).hostCode;
    if (hostCode === -32601) return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === -32601 || error.code === "host/method-unavailable")
  );
}

export interface PeerThreadProjector {
  projectInput(content: unknown[]): unknown[];
  projectImage(path: string, projectionKey: string): unknown;
}

export interface PeerThreadSourceOptions {
  hostId: string;
  host: PeerChHostClient;
  onCatalogChanged(): unknown;
  onThreadChanged(threadId: string): unknown;
  onUsageChanged?: (threadId: string) => void;
  onCatalogInspectionChanged?: () => void;
  onSkillsChanged?: () => void;
  onConnection(online: boolean): void;
  onReset?: (epoch: string, full: boolean) => void;
  onProjection?: ProjectionListener;
  /** Optional attachment/image projector; when omitted, remote images are never read locally. */
  projector?: (threadId: string) => PeerThreadProjector;
}

export interface PeerThreadListResult {
  rows: ChThread[];
  harnessIds: ReadonlyMap<string, string>;
  archivedIds: ReadonlySet<string>;
  parents: Readonly<Record<string, string>>;
  ownershipAvailable: boolean;
}

export interface PeerHistoryMeta {
  row?: ChThread;
  harnessId?: string;
  onProjection?: ProjectionListener;
}

/** Per-Peer composition root reusing local ChRealtime, ChThreadHistory, ChHarnessCatalog, and ChThreadTree. */
export class PeerThreadSource {
  readonly hostId: string;
  readonly host: PeerChHostClient;
  readonly catalog: ChHarnessCatalog;
  readonly tree: ChThreadTree;
  readonly realtime: ChRealtime;

  private readonly histories = new Map<string, ChThreadHistory>();
  private readonly knownRows = new Map<string, ChThread>();
  private readonly knownHarnesses = new Map<string, string>();
  private readonly stopCatalogInvalidation: () => void;
  private epoch: string | undefined;
  private listedForEpoch: string | undefined;
  private inFlightListEpoch: string | undefined;
  private skillsListUnavailable = false;
  private threadCommandsUnavailable = false;
  private harnessCommandsUnavailable = false;

  constructor(private readonly options: PeerThreadSourceOptions) {
    this.hostId = options.hostId;
    this.host = options.host;
    // Isolated EventHub with no subscribers: never broadcasts local global harness-inspection-changed.
    this.catalog = new ChHarnessCatalog(
      options.host,
      new EventHub(""),
      undefined,
      undefined,
      undefined,
      () => options.host.manifestEpoch(),
    );
    this.stopCatalogInvalidation = options.host.realtime.subscribe((event) => {
      if (event.type === "harness-inspection-changed" || event.type === "hello") {
        options.onCatalogInspectionChanged?.();
      }
      if (event.type === "hello") {
        this.skillsListUnavailable = false;
        this.threadCommandsUnavailable = false;
        this.harnessCommandsUnavailable = false;
        options.onSkillsChanged?.();
      } else if (event.type === "skills-changed") {
        options.onSkillsChanged?.();
      }
    });
    this.tree = new ChThreadTree(options.host);
    this.realtime = new ChRealtime(
      options.host.realtime,
      {
        thread: async (threadId) => {
          await options.onThreadChanged(threadId);
        },
        usage: (threadId) => {
          options.onUsageChanged?.(threadId);
        },
        catalog: async (reason) => {
          if (
            reason === "hello" &&
            this.epoch !== undefined &&
            (this.listedForEpoch === this.epoch || this.inFlightListEpoch === this.epoch)
          ) {
            return;
          }
          await options.onCatalogChanged();
        },
        connection: (online) => {
          if (!online) {
            this.listedForEpoch = undefined;
            this.inFlightListEpoch = undefined;
          }
          options.onConnection(online);
        },
        reset: (epoch, full) => {
          if (full && this.epoch === epoch) {
            this.listedForEpoch = undefined;
            this.inFlightListEpoch = undefined;
            for (const view of this.histories.values()) view.forgetKnownTurns();
          }
          if (this.epoch && this.epoch !== epoch) {
            this.listedForEpoch = undefined;
            this.inFlightListEpoch = undefined;
            for (const view of this.histories.values()) {
              view.retire();
              view.log.reconnectFollowers();
            }
            this.histories.clear();
          }
          this.epoch = epoch;
          options.onReset?.(epoch, full);
        },
        error: () => {},
      },
      { threadDebounceMs: REMOTE_THREAD_DEBOUNCE_MS },
    );
  }

  async listThreads(options?: {
    onPage?: (partial: PeerThreadListResult) => void;
  }): Promise<PeerThreadListResult> {
    const startEpoch = this.epoch ?? this.host.manifestEpoch();
    this.inFlightListEpoch = startEpoch;
    try {
      return await this.runListThreads(startEpoch, options?.onPage);
    } finally {
      if (this.inFlightListEpoch === startEpoch) {
        this.inFlightListEpoch = undefined;
      }
    }
  }

  private async runListThreads(
    startEpoch: string | undefined,
    onPage?: (partial: PeerThreadListResult) => void,
  ): Promise<PeerThreadListResult> {
    const rows = new Map<string, ChThread>();
    const harnessIds = new Map<string, string>();
    const archivedIds = new Set<string>();
    const timing = new SessionListTiming();
    const treePromise = this.tree.refresh().then(
      () => true,
      () => false,
    );

    let ownershipAvailable = true;
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    try {
      for (;;) {
        if (pages >= MAX_CATALOG_PAGES) {
          throw new RpcError("remote/read-failed", "Remote catalog exceeds bounded traversal");
        }
        pages++;
        const { page } = await readSessionPage(this.host, timing, false, cursor, async () => []);
        const pageById = new Map<string, ChThread>();
        const pageRows: ChThread[] = [];
        for (const rawRow of page.threads) {
          const row: ChThread = { ...rawRow, turns: [] };
          const existingHarness = harnessIds.get(row.id);
          if (cursor === undefined || !existingHarness || existingHarness === "codex") {
            rows.set(row.id, row);
            pageRows.push(row);
          }
          pageById.set(row.id, row);
        }
        for (const id of page.archivedThreadIds) archivedIds.add(id);
        for (const item of page.ownership) {
          const row = pageById.get(item.threadId) ?? rows.get(item.threadId);
          if (item.owner === "external" && item.harnessId && row?.modelProvider === "codexhost") {
            harnessIds.set(item.threadId, item.harnessId);
          } else if (item.owner === "codex" && !harnessIds.has(item.threadId)) {
            harnessIds.set(item.threadId, "codex");
          }
        }
        const next = nextCatalogCursor(page, false);
        if (onPage && pageRows.length > 0) {
          const pageHarnessIds = new Map<string, string>();
          for (const row of pageRows) {
            const hid = harnessIds.get(row.id);
            if (hid) pageHarnessIds.set(row.id, hid);
          }
          onPage({
            rows: pageRows,
            harnessIds: pageHarnessIds,
            archivedIds: new Set(archivedIds),
            parents: {},
            ownershipAvailable,
          });
        }
        if (next === null) break;
        if (seenCursors.has(next) || next === cursor) {
          throw new RpcError("remote/read-failed", "Remote catalog cursor did not advance");
        }
        seenCursors.add(next);
        cursor = next;
      }
    } catch (error) {
      if (pages !== 1 || !isMethodUnavailableError(error)) {
        await treePromise;
        throw error;
      }
      ownershipAvailable = false;
      await this.listThreadsFallback(rows);
    }

    const treeOk = await treePromise;
    const parents: Record<string, string> = {};
    if (ownershipAvailable && treeOk) {
      await this.tree.supplement(rows, async (id) => {
        const [result, owner] = await Promise.all([
          this.host.request<{ thread: ChThread }>("thread/read", {
            threadId: id,
            includeTurns: false,
          }),
          this.host
            .request<{ threads: unknown[] }>("codexhost/thread/ownership/list", {
              threadIds: [id],
            })
            .then((value) => threadOwnershipSchema.parse(value.threads[0]))
            .catch(() => undefined),
        ]);
        if (result.thread.id !== id) throw new Error("Ancestor Thread identity mismatch");
        if (owner) {
          if (
            owner.owner === "external" &&
            owner.harnessId &&
            result.thread.modelProvider === "codexhost"
          ) {
            harnessIds.set(id, owner.harnessId);
          } else if (owner.owner === "codex" && !harnessIds.has(id)) {
            harnessIds.set(id, "codex");
          }
        } else if (result.thread.modelProvider !== "codexhost" && !harnessIds.has(id)) {
          harnessIds.set(id, "codex");
        }
        if ((result.thread as { archived?: unknown }).archived === true) {
          archivedIds.add(id);
        }
        return { ...result.thread, turns: [] };
      });
      for (const id of rows.keys()) {
        const parent = this.tree.parent(id);
        if (parent !== null) parents[id] = parent;
      }
    }

    this.knownRows.clear();
    for (const [id, row] of rows) this.knownRows.set(id, row);
    this.knownHarnesses.clear();
    for (const [id, harnessId] of harnessIds) this.knownHarnesses.set(id, harnessId);
    const finishedEpoch = this.epoch ?? this.host.manifestEpoch();
    if (startEpoch !== undefined && startEpoch === finishedEpoch) {
      this.listedForEpoch = finishedEpoch;
    }

    return {
      rows: [...rows.values()],
      harnessIds,
      archivedIds,
      parents,
      ownershipAvailable,
    };
  }

  private async listThreadsFallback(rows: Map<string, ChThread>): Promise<void> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      if (pages >= MAX_CATALOG_PAGES) {
        throw new RpcError("remote/read-failed", "Remote catalog exceeds bounded traversal");
      }
      pages++;
      const page = legacyListPageSchema.parse(
        await this.host.request("thread/list", { cursor, archived: false, limit: 100 }),
      );
      for (const row of page.data) {
        rows.set(row.id, { ...row, turns: [] } as ChThread);
      }
      if (page.nextCursor === null) break;
      if (seen.has(page.nextCursor) || page.nextCursor === cursor) {
        throw new RpcError("remote/read-failed", "Remote catalog cursor did not advance");
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  history(
    threadId: string,
    sessionId: string,
    origin?: number,
    meta?: PeerHistoryMeta,
  ): ChThreadHistory {
    const existing = this.histories.get(threadId);
    if (existing) return existing;
    const baseRow: ChThread = meta?.row ??
      this.knownRows.get(threadId) ?? {
        id: threadId,
        cwd: "",
        modelProvider: "codexhost",
        createdAt: 0,
        updatedAt: 0,
        status: { type: "idle" },
        turns: [],
      };
    const harnessId =
      meta?.harnessId ??
      this.knownHarnesses.get(threadId) ??
      (baseRow.modelProvider !== "codexhost" ? "codex" : "remote");
    const projector = this.options.projector?.(threadId);
    const history = new ChThreadHistory(
      this.host,
      { ...baseRow, id: sessionId, cwd: "" },
      harnessId,
      (projectedSessionId, key, value, seq) => {
        history.log.pushProjection(key, value, seq);
        meta?.onProjection?.(projectedSessionId, key, value, seq);
        this.options.onProjection?.(projectedSessionId, key, value, seq);
      },
      origin,
      projector ? (content) => projector.projectInput(content) : undefined,
      projector ? (path, projectionKey) => projector.projectImage(path, projectionKey) : undefined,
      { hostThreadId: threadId },
    );
    this.histories.set(threadId, history);
    return history;
  }

  follow(threadId: string): () => void {
    return this.realtime.follow(threadId);
  }

  async listSkills(params: SkillsListParams): Promise<SkillsListResult> {
    if (this.skillsListUnavailable) {
      return { revision: 0, complete: true, skills: [] };
    }
    try {
      return skillsListResultSchema.parse(await this.host.request("codexhost/skills/list", params));
    } catch (error) {
      if (isMethodUnavailableError(error)) {
        this.skillsListUnavailable = true;
        return { revision: 0, complete: true, skills: [] };
      }
      throw error;
    }
  }

  async inspectThreadCommands(threadId: string): Promise<HarnessCommandCatalog> {
    if (this.threadCommandsUnavailable) {
      return { commands: [] };
    }
    try {
      return harnessCommandCatalogSchema.parse(
        await this.host.request("codexhost/thread/commands/inspect", { threadId }),
      );
    } catch (error) {
      if (isMethodUnavailableError(error)) {
        this.threadCommandsUnavailable = true;
        return { commands: [] };
      }
      throw error;
    }
  }

  async inspectHarnessCommands(harnessId: string, cwd?: string): Promise<HarnessCommandCatalog> {
    if (this.harnessCommandsUnavailable) {
      return { commands: [] };
    }
    try {
      return harnessCommandCatalogSchema.parse(
        await this.host.request("codexhost/harness/commands/inspect", {
          harnessId,
          ...(cwd ? { cwd } : {}),
        }),
      );
    } catch (error) {
      if (isMethodUnavailableError(error)) {
        this.harnessCommandsUnavailable = true;
        return { commands: [] };
      }
      throw error;
    }
  }

  discard(threadId: string): void {
    const existing = this.histories.get(threadId);
    if (!existing) return;
    this.histories.delete(threadId);
    existing.retire();
  }

  close(): void {
    this.stopCatalogInvalidation();
    this.realtime.close();
    this.catalog.close();
    for (const view of this.histories.values()) {
      view.retire();
      view.log.reconnectFollowers();
    }
    this.histories.clear();
    this.knownRows.clear();
    this.knownHarnesses.clear();
    this.host.close();
  }
}

export interface PeerHarnessIconProvider {
  client(hostId: string): { state: string } | undefined;
  source(hostId: string): Pick<PeerThreadSource, "catalog"> | undefined;
}

const PEER_HARNESS_ICON_PREFIX = "/harness-icons/peer/";

/** Resolve /harness-icons/peer/<peerId>/<id> and /harness-icons/peer/<peerId>/presentation.json
 * strictly from that Peer's cached ChHarnessCatalog; returns undefined (404) when unknown/offline. */
export async function resolvePeerHarnessIcon(
  peers: PeerHarnessIconProvider,
  pathname: string,
): Promise<{ contentType: string; body: Buffer; stale?: boolean } | undefined> {
  if (!pathname.startsWith(PEER_HARNESS_ICON_PREFIX)) return undefined;
  const rest = pathname.slice(PEER_HARNESS_ICON_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  let peerId: string;
  let target: string;
  try {
    peerId = decodeURIComponent(parts[0]);
    target = decodeURIComponent(parts[1]);
  } catch {
    return undefined;
  }
  if (!REMOTE_PEER_ID_PATTERN.test(peerId) || !target) return undefined;
  const hostId = remotePeerHostId(peerId);
  const source = peers.source(hostId);
  if (!source) return undefined;
  const state = peers.client(hostId)?.state;
  if (state === "connecting") {
    // Serve previously cached plugin icons during transient reconnects instead of 404.
    const cached = source.catalog.cachedList();
    if (!cached) return undefined;
    if (target === "presentation.json") {
      return {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(harnessIconStyles(cached))),
        stale: true,
      };
    }
    const cachedAsset = source.catalog.cachedIcon(target);
    return cachedAsset ? { ...cachedAsset, stale: true } : undefined;
  }
  if (state !== "connected") return undefined;
  const cached = source.catalog.cachedList();
  const resolvedCurrent = source.catalog.hasResolvedCurrentList();
  if (cached) {
    if (!source.catalog.hasFreshList()) {
      void source.catalog.list().catch(() => undefined);
    }
    if (target === "presentation.json") {
      return {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(harnessIconStyles(cached))),
        ...(resolvedCurrent ? {} : { stale: true }),
      };
    }
    const cachedAsset = source.catalog.cachedIcon(target);
    if (cachedAsset) {
      return resolvedCurrent ? cachedAsset : { ...cachedAsset, stale: true };
    }
    // Only treat a missing icon as authoritative when the current generation's list has resolved;
    // otherwise wait for the in-flight refresh so newly installed plugins do not 404 prematurely.
    if (resolvedCurrent) return undefined;
  }
  const generationBefore = source.catalog.currentGeneration();
  try {
    if (target === "presentation.json") {
      const plugins = await source.catalog.list();
      const stale =
        source.catalog.currentGeneration() !== generationBefore ||
        !source.catalog.hasResolvedCurrentList();
      return {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(harnessIconStyles(plugins))),
        ...(stale ? { stale: true } : {}),
      };
    }
    const asset = await source.catalog.icon(target);
    if (!asset) return undefined;
    const stale =
      source.catalog.currentGeneration() !== generationBefore ||
      !source.catalog.hasResolvedCurrentList();
    return stale ? { ...asset, stale: true } : asset;
  } catch {
    const fallback = source.catalog.cachedList();
    if (!fallback) return undefined;
    if (target === "presentation.json") {
      return {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(harnessIconStyles(fallback))),
        stale: true,
      };
    }
    const cachedAsset = source.catalog.cachedIcon(target);
    return cachedAsset ? { ...cachedAsset, stale: true } : undefined;
  }
}
