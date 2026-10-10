/** CH-backed Web facade: canonical Threads are owned/persisted by CH, Web holds only rendering buffers. */
import { randomUUID } from "node:crypto";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  threadInspectionSchema,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { ChHarnessCatalog, type ModelSelection } from "./ch-harness-catalog.ts";
import type { SessionNotification } from "./sessions.ts";
import type { ChThread } from "./ch-thread-view.ts";
import type { Inspection } from "./harnesses.ts";
import { nativePermissionView } from "./session-presentation.ts";
import { projectGroupRoot } from "./ch-project-groups.ts";
import { ChThreadHistory } from "./ch-thread-history.ts";
import { ChPinnedThreads } from "./ch-pinned-threads.ts";
import { type WebImages, WEB_IMAGE_INPUT, WEB_IMAGE_LIMITS } from "./web-images.ts";
import { ChRealtime } from "./ch-realtime.ts";
import { ChInteractions } from "./ch-interactions.ts";
import { requestOf } from "./store.ts";
import {
  type EventHub,
  RpcError,
  type RpcRegistry,
  type StreamRegistry,
  type StreamSink,
} from "./transport.ts";
import type { Workspaces } from "./workspaces.ts";
import { defaultProjections } from "./session-log.ts";

interface Draft {
  id: string;
  cwd: string;
  selection: ModelSelection;
  permissionModeId?: string;
  createdAt: number;
  canonicalId?: string;
  creating?: Promise<string>;
}

export class ChSessions {
  readonly catalog: ChHarnessCatalog;
  private readonly pins: ChPinnedThreads;
  private rows = new Map<string, ChThread>();
  private publishedCatalog: Map<string, string> | undefined;
  private views = new Map<string, ChThreadHistory>();
  private readingViews = new Map<string, Promise<ChThreadHistory>>();
  private loadingControls = new Map<string, Promise<void>>();
  private historyReadAt = new Map<string, number>();
  private ownership = new Map<string, string>();
  private drafts = new Map<string, Draft>();
  private controls = new Set<StreamSink>();
  private refreshing: Promise<void> | undefined;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly realtime: ChRealtime | undefined;
  private readonly interactions: ChInteractions | undefined;
  private hostOnline = true;
  private hostEpoch: string | undefined;
  private readonly viewOrigins = new Map<string, number>();
  notifier: ((notification: SessionNotification) => void) | undefined;
  constructor(
    private readonly host: ChHostClient,
    private readonly workspaces: Workspaces,
    private readonly events: EventHub,
    private readonly images?: WebImages,
  ) {
    this.catalog = new ChHarnessCatalog(host);
    this.pins = new ChPinnedThreads(host, workspaces, (id) => this.ownership.has(id));
    this.interactions = host.realtime
      ? new ChInteractions(host.realtime, events, (id, message) => {
          this.views.get(id)?.log.setProjection("nativeInteractionError", message);
        })
      : undefined;
    this.realtime = host.realtime
      ? new ChRealtime(host.realtime, {
          thread: (id) => this.view(id),
          catalog: () => this.refresh(),
          connection: (online) => {
            this.hostOnline = online;
            if (!online) this.interactions?.clear();
            for (const view of this.views.values())
              view.log.setProjection("nativeConnection", {
                state: online ? "connected" : "reconnecting",
              });
          },
          reset: (epoch) => {
            if (this.hostEpoch && this.hostEpoch !== epoch) {
              const old = [...this.views.values()];
              this.views.clear();
              this.readingViews.clear();
              this.loadingControls.clear();
              this.historyReadAt.clear();
              this.interactions?.clear();
              for (const view of old) {
                view.retire();
                this.viewOrigins.set(view.thread.id, view.log.lastSeq + 2);
                view.log.reconnectFollowers();
              }
            }
            this.hostEpoch = epoch;
          },
          error: (id, error) => {
            if (error instanceof RpcError && error.code === "host/resync") return;
            this.views.get(id)?.log.setProjection("nativeConnection", {
              state: "reconnecting",
              message: error instanceof Error ? error.message : "CH state is unavailable",
            });
          },
        })
      : undefined;
  }

  private id(id: string): string {
    return this.drafts.get(id)?.canonicalId ?? id;
  }
  private async refresh(): Promise<void> {
    this.refreshing ??= this.listAll().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async listAll(): Promise<void> {
    const found = new Map<string, ChThread>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: { data: ChThread[]; nextCursor: string | null } = await this.host.request<{
          data: ChThread[];
          nextCursor: string | null;
        }>("thread/list", { limit: 200, cursor, archived, modelProviders: ["codexhost"] });
        for (const row of page.data)
          if (row.modelProvider === "codexhost") {
            found.set(row.id, row);
          }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new RpcError("host/pagination-invalid", "CH cursor did not advance.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    const ownership = new Map<string, string>();
    const ids = [...found.keys()];
    for (let start = 0; start < ids.length; start += 100) {
      const result = await this.host.request<{
        threads: Array<{ threadId: string; owner: string; harnessId?: string }>;
      }>("codexhost/thread/ownership/list", { threadIds: ids.slice(start, start + 100) });
      for (const item of result.threads)
        if (item.owner === "external" && item.harnessId)
          ownership.set(item.threadId, item.harnessId);
    }
    this.ownership = ownership;
    this.rows = new Map([...found].filter(([id]) => ownership.has(id)));
    const projects = await this.host.projects([...this.rows.keys()]);
    const groups = new Map<string, string | undefined>();
    for (const row of this.rows.values()) {
      const root = row.cwd ? projectGroupRoot(projects, row.id, row.cwd) : undefined;
      groups.set(row.id, root);
      if (root)
        this.workspaces.attachReferencedSession(
          row.id,
          root,
          projects.projects.find((project) => project.rootPaths.includes(root))?.name,
        );
    }
    for (const draft of this.drafts.values()) groups.set(draft.id, draft.cwd);
    this.workspaces.setReferenceGroups(groups);
    await this.publishCatalogChanges();
    // A missing Desktop pin service must not hide readable Threads. Retain the
    // last confirmed pins; a user command still reports its failure explicitly.
    await this.pins.sync().catch(() => undefined);
  }
  /** Only fields used by the list summary; history projections have their own
   * control stream. Re-emitting every row makes each browser rebuild its entire
   * catalog thousands of times and starves interactive history frames.
   */
  private catalogKey(row: ChThread): string {
    return JSON.stringify([
      row.name ?? row.preview ?? null,
      row.cwd,
      row.updatedAt,
      row.status.type,
      row.parentThreadId ?? null,
      this.ownership.get(row.id),
    ]);
  }
  private async publishCatalogChanges(): Promise<void> {
    const before = this.publishedCatalog;
    const next = new Map([...this.rows].map(([id, row]) => [id, this.catalogKey(row)]));
    // First load is already delivered by session/list. Subsequent refreshes,
    // including ones requested by a second browser, publish actual deltas only.
    const changed =
      before === undefined
        ? []
        : await Promise.all(
            [...this.rows.values()]
              .filter((row) => before.get(row.id) !== next.get(row.id))
              .map((row) => this.summary(row)),
          );
    this.publishedCatalog = next;
    for (const row of changed) this.events.emit("api-session/added", row);
    if (before)
      for (const id of before.keys())
        if (!next.has(id)) this.events.emit("api-session/removed", id);
  }
  private async owner(id: string) {
    const inspection = threadInspectionSchema.parse(
      await this.host.request("codexhost/thread/inspect", { threadId: this.id(id) }),
    );
    if (inspection.owner !== "external")
      throw new RpcError(
        "session/not-external",
        "This Web connection only handles external Harness Threads.",
      );
    return inspection;
  }
  private view(id: string, reuseIdle = false): Promise<ChThreadHistory> {
    id = this.id(id);
    const existing = this.readingViews.get(id);
    if (existing) return reuseIdle ? existing : existing.then(() => this.view(id));
    const cached = this.views.get(id);
    const row = this.rows.get(id);
    if (
      reuseIdle &&
      !this.realtime &&
      cached &&
      row &&
      row.status.type !== "active" &&
      cached.thread.status.type !== "active" &&
      row.updatedAt === cached.thread.updatedAt &&
      Date.now() - (this.historyReadAt.get(id) ?? 0) < 30_000
    )
      return Promise.resolve(cached);
    const reading = this.readView(id, !reuseIdle)
      .catch((error: unknown) => {
        if (
          !this.closed &&
          error instanceof Error &&
          "code" in error &&
          (error.code === "host/resync" || error.code === -32094)
        ) {
          if (this.readingViews.get(id) === reading) this.readingViews.delete(id);
          return this.view(id, reuseIdle);
        }
        throw error;
      })
      .finally(() => {
        if (this.readingViews.get(id) === reading) this.readingViews.delete(id);
      });
    this.readingViews.set(id, reading);
    return reading;
  }
  private async readView(id: string, force: boolean): Promise<ChThreadHistory> {
    if (!this.rows.has(id)) await this.refresh();
    const row = this.rows.get(id);
    if (!row) throw new RpcError("session/not-found", "CH Thread not found.", { sessionId: id });
    const harnessId = this.ownership.get(id);
    if (!harnessId)
      throw new RpcError("session/not-external", "CH did not confirm external Thread ownership.");
    let view = this.views.get(id);
    if (!view) {
      view = new ChThreadHistory(
        this.host,
        row,
        harnessId,
        (sessionId, key, value, seq) => {
          for (const sink of this.controls)
            sink.push({ type: "projection", sessionId, key, value, seq });
        },
        this.viewOrigins.get(id),
        this.images ? (content) => this.images?.project(content) ?? content : undefined,
      );
      if (this.images) {
        view.log.setProjection("attachmentInput", WEB_IMAGE_INPUT);
        view.log.setProjection("imageLimits", WEB_IMAGE_LIMITS);
      }
      this.views.set(id, view);
    }
    try {
      await view.refresh(force);
    } catch (error) {
      if (error instanceof RpcError && error.code === "host/history-changed") {
        view.retire();
        this.views.delete(id);
        this.historyReadAt.delete(id);
        this.loadingControls.delete(id);
        view.log.invalidate(error.code, error.message);
      }
      throw error;
    }
    if (this.views.get(id) !== view)
      throw new RpcError("host/resync", "Host snapshot was superseded by a new generation");
    if (view.ownerSnapshot && this.hostOnline && !this.closed)
      this.interactions?.update(view.ownerSnapshot);
    if (this.realtime)
      view.log.setProjection("nativeConnection", {
        state: this.hostOnline ? "connected" : "reconnecting",
      });
    this.historyReadAt.set(id, Date.now());
    const name = await this.catalog.name(harnessId);
    if (this.views.get(id) !== view)
      throw new RpcError("host/resync", "Host snapshot was superseded by a new generation");
    view.log.setProjection("harnessIdentity", { id: harnessId, name });
    this.loadControls(view, harnessId, force);
    return view;
  }
  private loadControls(view: ChThreadHistory, harnessId: string, force: boolean): void {
    const id = view.thread.id;
    if (!force && this.loadingControls.has(id)) return;
    // Runtime inspection/config discovery must not gate the history snapshot.
    const loading = Promise.all([
      view.ownerSnapshot ? Promise.resolve(view.ownerSnapshot.configuration) : this.owner(id),
      this.catalog.inspect(harnessId, view.thread.cwd),
    ])
      .then(([owner, inspection]) => {
        if (this.closed || this.views.get(id) !== view || this.loadingControls.get(id) !== loading)
          return;
        view.log.setProjection(
          "nativePermissions",
          nativePermissionView(harnessId, inspection as Inspection, true),
        );
        if (owner.effectivePermissionModeId)
          view.log.setProjection("permissions", { currentValue: owner.effectivePermissionModeId });
        const selection = {
          provider: harnessId,
          model: owner.effectiveModel?.id ?? "harness",
          ...(owner.effectiveThinkingOptionId
            ? { reasoningEffort: owner.effectiveThinkingOptionId }
            : {}),
        };
        view.log.setProjection("modelSelection", { lastUsed: selection, next: selection });
      })
      .catch(() => {
        // Controls remain absent on failure; history stays usable and later reads retry.
      })
      .finally(() => {
        if (this.loadingControls.get(id) === loading) this.loadingControls.delete(id);
      });
    this.loadingControls.set(id, loading);
  }
  private async summary(row: ChThread) {
    const harnessId = this.ownership.get(row.id);
    if (!harnessId)
      throw new RpcError("session/not-external", "CH did not confirm external Thread ownership.");
    const values = {
      ...defaultProjections(),
      ...this.views.get(row.id)?.log.projections,
      ...(this.images ? { attachmentInput: WEB_IMAGE_INPUT, imageLimits: WEB_IMAGE_LIMITS } : {}),
      title: row.name ?? row.preview ?? null,
      harnessIdentity: { id: harnessId, name: await this.catalog.name(harnessId) },
      sessionListMetadata: { blank: false, lastPromptAt: row.updatedAt * 1000 },
    };
    return {
      sessionId: row.id,
      cwd: row.cwd,
      updatedAt: row.updatedAt * 1000,
      running: row.status.type === "active",
      blank: false,
      agentAvailable: true,
      ...(row.parentThreadId ? { parentSessionId: row.parentThreadId, origin: "subagent" } : {}),
      projections: { kind: "cached", asOfSeq: 0, values },
    };
  }
  private async draftSummary(draft: Draft) {
    const inspection = await this.catalog.inspect(draft.selection.provider, draft.cwd);
    return {
      sessionId: draft.id,
      cwd: draft.cwd,
      updatedAt: draft.createdAt,
      running: false,
      blank: true,
      agentAvailable: true,
      projections: {
        kind: "cached",
        asOfSeq: 0,
        values: {
          ...defaultProjections(),
          ...(this.images
            ? { attachmentInput: WEB_IMAGE_INPUT, imageLimits: WEB_IMAGE_LIMITS }
            : {}),
          modelSelection: { lastUsed: null, next: draft.selection },
          harnessIdentity: {
            id: draft.selection.provider,
            name: await this.catalog.name(draft.selection.provider),
          },
          nativePermissions: nativePermissionView(
            draft.selection.provider,
            inspection as Inspection,
            false,
          ),
          permissions: {
            currentValue:
              draft.permissionModeId ??
              (inspection.status === "ready"
                ? (inspection.permissionModes?.defaultModeId ?? "")
                : ""),
          },
        },
      },
    };
  }
  private async create(args: Record<string, unknown>) {
    const request = requestOf<{ cwd?: string; workspaceId?: string; sessionId?: string }>(args);
    const cwd =
      request.cwd ??
      (request.workspaceId ? this.workspaces.get(request.workspaceId)?.path : undefined);
    if (!cwd) throw new RpcError("workspace/invalid-path", "Choose a computer working directory.");
    const id = request.sessionId ?? `draft-${randomUUID()}`;
    const selection = (await this.catalog.models()).default;
    const draft = { id, cwd, selection, createdAt: Date.now() };
    this.drafts.set(id, draft);
    this.workspaces.attachReferencedSession(id, cwd);
    this.workspaces.addDraftReference(id, cwd);
    this.events.emit("api-session/added", await this.draftSummary(draft));
    return { sessionId: id, agentPreset: "standard" };
  }
  private async commit(draft: Draft): Promise<string> {
    if (draft.canonicalId) return draft.canonicalId;
    draft.creating ??= (async () => {
      const result = await this.host.request<{ thread: ChThread }>("thread/start", {
        cwd: draft.cwd,
        model: encodeHarnessPluginRoute(
          harnessPluginRouteSchema.parse({
            harnessId: draft.selection.provider,
            model: { id: draft.selection.model },
            ...(draft.selection.reasoningEffort
              ? { thinkingOptionId: draft.selection.reasoningEffort }
              : {}),
            ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
          }),
        ),
      });
      draft.canonicalId = result.thread.id;
      this.rows.set(result.thread.id, result.thread);
      this.ownership.set(result.thread.id, (await this.owner(result.thread.id)).harnessId);
      this.workspaces.selectReferenceWorkspace(draft.cwd);
      this.workspaces.detachSession(draft.id);
      this.workspaces.attachReferencedSession(result.thread.id, result.thread.cwd);
      this.events.emit("api-session/added", await this.summary(result.thread));
      this.publishedCatalog?.set(result.thread.id, this.catalogKey(result.thread));
      this.events.emit("codexhost/session-bound", draft.id, result.thread.id);
      return result.thread.id;
    })();
    // No automatic retry after creation failure: the Host may already have allocated an identity.
    return draft.creating;
  }

  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    for (const [method, pinned] of [
      ["workspace/pinSession", true],
      ["workspace/unpinSession", false],
    ] as const) {
      rpc.register(method, async (args) => {
        const { sessionId } = requestOf<{ sessionId: string }>(args);
        const id = this.id(sessionId);
        if (this.drafts.has(id))
          throw new RpcError(
            "host/pin-draft",
            "Send the first message before pinning this Thread.",
          );
        if (!this.ownership.has(id)) await this.refresh();
        await this.owner(id);
        if (!this.ownership.has(id))
          throw new RpcError("session/not-found", "This Thread is not in the shared catalog.");
        return { pinnedSessionIds: await this.pins.sync({ threadId: id, pinned }) };
      });
    }
    rpc.register("session/list", async () => {
      await this.refresh();
      return {
        items: [
          ...(await Promise.all([...this.rows.values()].map((row) => this.summary(row)))),
          ...(await Promise.all(
            [...this.drafts.values()]
              .filter((d) => !d.canonicalId)
              .map((d) => this.draftSummary(d)),
          )),
        ],
      };
    });
    rpc.register("session/create", (args) => this.create(args));
    rpc.register("session/modelCatalog", () => this.catalog.models());
    rpc.register("session/selectModel", async (args) => {
      const request = requestOf<ModelSelection & { sessionId: string }>(args);
      const draft = this.drafts.get(request.sessionId);
      if (draft && !draft.canonicalId) {
        if (draft.creating) throw new RpcError("session/busy", "Draft creation is in progress.");
        if (draft.selection.provider !== request.provider) delete draft.permissionModeId;
        draft.selection = request;
        this.events.emit("api-session/added", await this.draftSummary(draft));
        for (const sink of this.controls) {
          const s = await this.draftSummary(draft);
          for (const [key, value] of Object.entries(s.projections.values))
            sink.push({ type: "projection", sessionId: draft.id, key, value, seq: 0 });
        }
        return {};
      }
      const owner = await this.owner(request.sessionId);
      if (owner.harnessId !== request.provider)
        throw new RpcError(
          "session/model-unavailable",
          "Start a new conversation to change Harness.",
        );
      await this.host.request("codexhost/thread/model/select", {
        threadId: this.id(request.sessionId),
        model: { id: request.model },
      });
      if (request.reasoningEffort)
        await this.host.request("codexhost/thread/thinking/select", {
          threadId: this.id(request.sessionId),
          thinkingOptionId: request.reasoningEffort,
        });
      await this.view(request.sessionId);
      return {};
    });
    rpc.register("session/prompt", async (args) => {
      const request = requestOf<{
        sessionId: string;
        requestId?: string;
        content: Array<{ type: string; text?: string }>;
        mode?: string;
      }>(args);
      if (!this.images && request.content.some((part) => part.type !== "text"))
        throw new RpcError(
          "session/attachment-invalid",
          "Shared CH input currently accepts text only.",
        );
      if (request.mode === "steer")
        throw new RpcError(
          "session/steer-unavailable",
          "Use the existing CH controls to steer; Web will not cancel and resend implicitly.",
        );
      const draft = this.drafts.get(request.sessionId);
      if (!draft || draft.canonicalId) await this.owner(request.sessionId);
      // Validate/save before creating a native Thread. Only native path context crosses the Host channel.
      const input = this.images?.prepare(request.content) ?? request.content;
      const threadId = draft ? await this.commit(draft) : this.id(request.sessionId);
      await this.owner(threadId);
      await this.host.request("turn/start", {
        threadId,
        input,
        ...(request.requestId ? { clientUserMessageId: request.requestId } : {}),
      });
      try {
        const view = await this.view(threadId);
        this.events.emit("api-session/status", threadId, view.thread.status.type === "active");
      } catch {
        // A failed read cannot turn an acknowledged write into a rejected send.
        if (this.realtime) {
          this.views.get(threadId)?.log.setProjection("nativeConnection", {
            state: "reconnecting",
            message: "CH accepted your message; waiting to synchronize its state.",
          });
          this.realtime.invalidate(threadId);
        }
      }
      return { accepted: true };
    });
    rpc.register("session/attachment", async (args) => {
      const { sessionId, attachmentId } = requestOf<{ sessionId: string; attachmentId: string }>(
        args,
      );
      const view = await this.view(sessionId, true);
      if (!this.images?.referenced(view.log.events, attachmentId))
        throw new RpcError(
          "session/attachment-not-found",
          "This image is not referenced by the loaded Thread history.",
        );
      return this.images.read(attachmentId);
    });
    rpc.register("session/cancel", async (args) => {
      const { sessionId } = requestOf<{ sessionId: string }>(args);
      const view = await this.view(sessionId);
      const turn = view.thread.turns.find((value) => value.status === "inProgress");
      if (turn)
        await this.host.request("turn/interrupt", {
          threadId: this.id(sessionId),
          turnId: turn.id,
        });
      return { accepted: true };
    });
    rpc.register("session/rename", async (args) => {
      const request = requestOf<{ sessionId: string; title: string }>(args);
      await this.owner(request.sessionId);
      await this.host.request("thread/name/set", {
        threadId: this.id(request.sessionId),
        name: request.title,
      });
      const view = await this.view(request.sessionId);
      return { title: request.title, seq: view.log.lastSeq };
    });
    rpc.register("session/search", async (args) => {
      await this.refresh();
      const needle = requestOf<{ query: string }>(args).query.toLowerCase();
      return {
        items: [...this.rows.values()]
          .filter((row) => (row.name ?? row.preview ?? "").toLowerCase().includes(needle))
          .slice(0, 20)
          .map((row) => ({ sessionId: row.id, snippet: row.name ?? row.preview ?? "" })),
        hasMore: false,
      };
    });
    rpc.register("session/projections", async (args) => {
      const { sessionId } = requestOf<{ sessionId: string }>(args);
      const draft = this.drafts.get(sessionId);
      return draft && !draft.canonicalId
        ? (await this.draftSummary(draft)).projections
        : (await this.view(sessionId, true)).log.projectionBaseline();
    });
    rpc.register("session/page", async (args) => {
      const req = requestOf<{
        address: { sessionId: string };
        throughSeq: number;
        beforeSeq?: number;
        maxMessages?: number;
      }>(args);
      const view =
        this.views.get(this.id(req.address.sessionId)) ??
        (await this.view(req.address.sessionId, true));
      return view.olderPage(req.throughSeq, req.beforeSeq, req.maxMessages);
    });
    rpc.register("session/workspacePathApplications", () => ({ applications: [] }));
    rpc.register("session/openWorkspacePath", () => {
      throw new RpcError(
        "session/open-unavailable",
        "Opening computer paths is unavailable in Web.",
      );
    });
    for (const [method, hostMethod] of [
      ["session/archive", "thread/archive"],
      ["session/unarchive", "thread/unarchive"],
    ])
      if (method && hostMethod)
        rpc.register(method, async (args) => {
          const req = requestOf<{ sessionId: string }>(args);
          await this.owner(req.sessionId);
          await this.host.request(hostMethod, { threadId: this.id(req.sessionId) });
          await this.refresh();
          return {};
        });
    streams.register("session/control", async (_args, sink) => {
      this.controls.add(sink);
      sink.onClose(() => this.controls.delete(sink));
      const projections: Record<string, unknown> = {};
      for (const [id, view] of this.views) projections[id] = view.log.projectionBaseline();
      for (const draft of this.drafts.values())
        if (!draft.canonicalId)
          projections[draft.id] = (await this.draftSummary(draft)).projections;
      sink.push({ type: "baseline", value: { projections } });
    });
    streams.register("session/follow", async (args, sink) => {
      const request = requestOf<{ address: { sessionId: string }; assistantStream?: boolean }>(
        args,
      );
      const draft = this.drafts.get(request.address.sessionId);
      if (draft && !draft.canonicalId) {
        const summary = await this.draftSummary(draft);
        sink.push({
          type: "snapshot",
          header: {
            version: 4,
            id: draft.id,
            createdAt: draft.createdAt,
            cwd: draft.cwd,
            isSeeded: false,
            agentPreset: "standard",
          },
          cursor: -1,
          records: [],
          hasMore: false,
          projections: summary.projections,
          assistantStream: { revision: 0 },
        });
        return;
      }
      const unfollow = this.realtime?.follow(this.id(request.address.sessionId));
      sink.onClose(() => unfollow?.());
      const view = await this.view(request.address.sessionId, true);
      view.log.follow(sink, request);
      // Publish first; prefetch just one older page, never drain all history.
      const prefetch = setImmediate(() => {
        if (!sink.closed && !this.closed) void view.prefetchOlder().catch(() => {});
      });
      sink.onClose(() => clearImmediate(prefetch));
      if (this.realtime) return;
      let busy = false;
      const poll = setInterval(() => {
        if (busy || sink.closed) return;
        busy = true;
        void this.view(view.thread.id, true)
          .catch(() => sink.fail("host/disconnected", "CH is unavailable; refresh to reconnect."))
          .finally(() => {
            busy = false;
          });
      }, 1500);
      poll.unref();
      sink.onClose(() => clearInterval(poll));
    });
    this.timer = setInterval(() => {
      if (this.closed) return;
      void this.refresh().catch(() => undefined);
    }, 10000);
    this.timer.unref();
  }

  registerCommands(rpc: RpcRegistry): void {
    rpc.register("permissionPresets/catalog", () => ({
      options: [],
      defaultOptions: [],
      defaultPreset: "",
    }));
    // /model is a client-owned contribution backed by the model-selection API,
    // not an executable Host command. Advertising it here breaks the menu roster.
    rpc.register("commands/list", () => [
      {
        definitionId: "@deepseek-ai/dsh-permission-presets",
        name: "permission",
        description: "Select a native permission mode",
        input: { hint: "<mode>" },
      },
    ]);
    rpc.register("commands/execute", async (args) => {
      const id = String(args.agentId ?? "");
      const match = /^\/permission\s+(.+)$/u.exec(String(args.line ?? ""));
      if (!match) return undefined;
      const modeId = match[1] ?? "";
      const draft = this.drafts.get(id);
      const harnessId =
        draft && !draft.canonicalId ? draft.selection.provider : (await this.owner(id)).harnessId;
      const inspection = await this.catalog.inspect(
        harnessId,
        draft?.cwd ?? this.rows.get(this.id(id))?.cwd,
      );
      const mode =
        inspection.status === "ready"
          ? inspection.permissionModes?.modes.find((value) => value.id === modeId)
          : undefined;
      if (!mode)
        throw new RpcError(
          "session/permission-unavailable",
          "Mode not advertised by this Harness.",
        );
      if (draft && !draft.canonicalId) {
        draft.permissionModeId = modeId;
        for (const sink of this.controls)
          sink.push({
            type: "projection",
            sessionId: id,
            key: "permissions",
            value: { currentValue: modeId },
            seq: 0,
          });
      } else {
        await this.host.request("codexhost/thread/permission-mode/select", {
          threadId: this.id(id),
          permissionModeId: modeId,
        });
        await this.view(id);
      }
      return { commandId: randomUUID(), result: { kind: "success", text: mode.label } };
    });
  }
  registerImport(rpc: RpcRegistry): void {
    rpc.register("codexhost/importSources", async () => {
      const result = await this.host.request<{
        harnesses: Array<{ harnessId: string; name: string }>;
      }>("codexhost/harness/session-import/sources", {});
      return result.harnesses;
    });
    rpc.register("codexhost/importCandidates", (args) =>
      this.host.request("codexhost/harness/session-import/list", requestOf(args)),
    );
    rpc.register("codexhost/import", async (args) => {
      const result = await this.host.request<{ threadId: string }>(
        "codexhost/harness/session-import/import",
        requestOf(args),
      );
      await this.refresh();
      return { sessionId: result.threadId };
    });
  }
  async importRecent(limit: number): Promise<number> {
    void limit;
    throw new RpcError("host/import-explicit", "CH imports must be explicitly selected.");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.realtime?.close();
    this.interactions?.clear();
    clearInterval(this.timer);
    this.host.close();
    for (const sink of this.controls) sink.end();
  }
}
