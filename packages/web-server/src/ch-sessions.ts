import { draftPermissionMode, type DraftConfiguration } from "./draft-configuration.ts";
/** CH-backed Web facade: canonical Threads are owned/persisted by CH, Web holds only rendering buffers. */
import { randomUUID } from "node:crypto";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  threadInspectionSchema,
  threadUsageInspectionSchema,
  type HarnessDisplayEntries,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { ChHarnessCatalog, type ModelSelection } from "./ch-harness-catalog.ts";
/** Out-of-band Web Push notification for one Session. */
export interface SessionNotification {
  kind: "turn" | "approval" | "question" | "error";
  sessionId: string;
  title: string;
  body: string;
}
import type { ChThread } from "./ch-thread-view.ts";
import type { Inspection } from "./harnesses.ts";
import { nativePermissionView } from "./session-presentation.ts";
import { projectGroupRoot } from "./ch-project-groups.ts";
import { threadListTitle } from "./ch-thread-title.ts";
import { ChThreadHistory } from "./ch-thread-history.ts";
import { WebThreadStates, type UsageLoad } from "./web-thread-state.ts";
import { ChHarnessCommands } from "./ch-harness-commands.ts";
import { ChThreadEditing } from "./ch-thread-edit.ts";
import { editedNativeInput } from "./native-user-input.ts";
import { forkChThread, forkUnavailable } from "./ch-thread-fork.ts";
import { ChPinnedThreads } from "./ch-pinned-threads.ts";
import { type WebImages, WEB_IMAGE_INPUT, WEB_IMAGE_LIMITS } from "./web-images.ts";
import { ChAttachments } from "./ch-attachments.ts";
import { ChFileInputs } from "./ch-file-inputs.ts";
import { type WebFiles, WEB_FILE_INPUT } from "./web-files.ts";
import { ChRealtime } from "./ch-realtime.ts";
import { ChInteractions } from "./ch-interactions.ts";
import type { WebHarnessPreferences } from "./harness-preferences.ts";
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
import { applyUsageProjections } from "./usage-projection.ts";

interface Draft {
  id: string;
  cwd?: string;
  selection: ModelSelection;
  permissionModeId?: string;
  createdAt: number;
  canonicalId?: string;
  creating?: Promise<string>;
}

export class ChSessions {
  readonly catalog: ChHarnessCatalog;
  private readonly editing = new ChThreadEditing();
  private readonly pins: ChPinnedThreads;
  private readonly attachments: ChAttachments | undefined;
  private readonly fileInputs: ChFileInputs | undefined;
  private rows = new Map<string, ChThread>();
  private publishedCatalog: Map<string, string> | undefined;
  /** Everything derived per Thread. Rows (replaced as a whole by each catalog read)
   * and drafts (not yet Host Threads) keep their own lifecycles. */
  private readonly threads = new WebThreadStates();
  private drafts = new Map<string, Draft>();
  private controls = new Set<StreamSink>();
  private refreshing: Promise<void> | undefined;
  private refreshingCatalog = false;
  private catalogReadAt = -Infinity;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly realtime: ChRealtime | undefined;
  private readonly interactions: ChInteractions | undefined;
  private hostOnline = true;
  private hostEpoch: string | undefined;
  notifier: ((notification: SessionNotification) => void) | undefined;
  constructor(
    private readonly host: ChHostClient,
    private readonly workspaces: Workspaces,
    private readonly events: EventHub,
    private readonly images?: WebImages,
    private readonly files?: WebFiles,
    displayEntries?: () => Promise<HarnessDisplayEntries>,
    private readonly preferences?: WebHarnessPreferences,
    harnesses?: ReadonlySet<string>,
  ) {
    this.catalog = new ChHarnessCatalog(host, displayEntries, preferences, harnesses);
    this.attachments = images ? new ChAttachments(images, files) : undefined;
    this.fileInputs =
      files && images
        ? new ChFileInputs(files, images, async (id) => {
            id = this.id(id);
            if (this.closed) throw new RpcError("host/offline", "The Web connection is closed.");
            if (this.drafts.has(id)) return id;
            await this.owner(id);
            if (!this.rows.has(id)) await this.refresh();
            if (!this.threads.hasHarness(id))
              throw new RpcError("session/not-found", "CH Thread not found.");
            if (this.rows.get(id)?.parentThreadId)
              throw new RpcError(
                "subagent/attachment-invalid",
                "Subagent file uploads are unavailable.",
              );
            return id;
          })
        : undefined;
    this.pins = new ChPinnedThreads(host, workspaces, (id) => this.threads.hasHarness(id));
    workspaces.setReferenceArchives([]);
    this.interactions = host.realtime
      ? new ChInteractions(host.realtime, events, (id, message) => {
          this.threads.view(id)?.log.setProjection("nativeInteractionError", message);
        })
      : undefined;
    this.realtime = host.realtime
      ? new ChRealtime(host.realtime, {
          thread: (id) => this.view(id),
          catalog: () => this.refresh(),
          connection: (online) => {
            this.hostOnline = online;
            if (!online) this.interactions?.clear();
            for (const [, view] of this.threads.views())
              view.log.setProjection("nativeConnection", {
                state: online ? "connected" : "reconnecting",
              });
          },
          reset: (epoch, full) => {
            if (full && this.hostEpoch === epoch) this.threads.forgetKnownTurns();
            if (this.hostEpoch && this.hostEpoch !== epoch) {
              this.interactions?.clear();
              for (const view of this.threads.newHostGeneration()) view.log.reconnectFollowers();
            }
            this.hostEpoch = epoch;
          },
          error: (id, error) => {
            if (error instanceof RpcError && error.code === "host/resync") return;
            this.threads.view(id)?.log.setProjection("nativeConnection", {
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
    if (this.closed) return;
    if (this.refreshing && !this.refreshingCatalog) {
      await this.refreshing.catch(() => undefined);
      return this.refresh();
    }
    if (!this.refreshing) {
      this.refreshingCatalog = true;
      this.refreshing = this.listAll().finally(() => {
        this.refreshing = undefined;
        this.refreshingCatalog = false;
      });
    }
    return this.refreshing;
  }
  private async listAll(): Promise<void> {
    // A Thread a draft binds while this read is in flight is missing from its
    // snapshot; it must not be dropped, or the first history read fails.
    const known = new Set(this.rows.keys());
    const found = new Map<string, ChThread>();
    const archivedIds = new Set<string>();
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
            if (archived) archivedIds.add(row.id);
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
    const rows = new Map([...found].filter(([id]) => ownership.has(id)));
    for (const [id, row] of this.rows) {
      const harnessId = this.threads.harnessId(id);
      if (known.has(id) || found.has(id) || !harnessId) continue;
      rows.set(id, row);
      ownership.set(id, harnessId);
    }
    this.threads.replaceHarnesses(ownership);
    this.rows = rows;
    await this.syncWorkspace();
    if (this.closed) return;
    this.workspaces.setReferenceArchives([...archivedIds].filter((id) => ownership.has(id)));
    await this.publishCatalogChanges();
    // Native pins are optional and cannot delay publishing the confirmed catalog.
    void this.pins.refresh().catch(() => undefined);
    this.catalogReadAt = Date.now();
  }
  private async syncWorkspace(): Promise<void> {
    const projects = await this.host.projects([...this.rows.keys()]);
    if (this.closed) return;
    const groups = new Map<string, string | undefined>();
    const projectless = new Set(projects.projectless.filter((id) => !projects.assignments[id]));
    for (const row of this.rows.values()) {
      if (row.workspaceKind === "projectless" && !row.projectId && !projects.assignments[row.id])
        projectless.add(row.id);
      const root =
        row.cwd && !projectless.has(row.id)
          ? projectGroupRoot(projects, row.id, row.cwd)
          : undefined;
      groups.set(row.id, root);
      if (root)
        this.workspaces.attachReferencedSession(
          row.id,
          root,
          projects.projects.find((project) => project.rootPaths.includes(root))?.name,
        );
    }
    for (const draft of this.drafts.values()) {
      if (draft.canonicalId) continue;
      groups.set(draft.id, draft.cwd);
      if (!draft.cwd) projectless.add(draft.id);
    }
    this.workspaces.setReferenceGroups(groups, projectless);
  }
  /** Only fields used by the list summary; history projections have their own
   * control stream. Re-emitting every row makes each browser rebuild its entire
   * catalog thousands of times and starves interactive history frames.
   */
  private catalogKey(row: ChThread): string {
    return JSON.stringify([
      threadListTitle(row),
      row.cwd,
      row.updatedAt,
      row.status.type,
      row.parentThreadId ?? null,
      row.canAcceptDirectInput !== false,
      this.threads.harnessId(row.id),
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
    // Previously opened Threads retain sequenced browser projections even after
    // unfollow. Cached catalog hints cannot replace them. Push the authoritative
    // title through the existing control stream without rereading any history.
    for (const [id, row] of this.rows)
      this.threads.view(id)?.log.setProjection("title", threadListTitle(row));
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
    const state = this.threads.get(id);
    const existing = state?.reading;
    if (existing) return reuseIdle ? existing : existing.then(() => this.view(id));
    const cached = state?.view;
    const row = this.rows.get(id);
    if (
      reuseIdle &&
      !this.realtime &&
      cached &&
      row &&
      row.status.type !== "active" &&
      cached.thread.status.type !== "active" &&
      row.updatedAt === cached.thread.updatedAt &&
      Date.now() - (state?.historyReadAt ?? 0) < 30_000
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
          this.finishReading(id, reading);
          return this.view(id, reuseIdle);
        }
        throw error;
      })
      .finally(() => this.finishReading(id, reading));
    this.threads.ensure(id).reading = reading;
    return reading;
  }
  private finishReading(id: string, reading: Promise<ChThreadHistory>): void {
    const state = this.threads.get(id);
    if (state?.reading !== reading) return;
    delete state.reading;
    this.threads.prune(id);
  }
  private async readView(id: string, force: boolean): Promise<ChThreadHistory> {
    if (!this.rows.has(id)) await this.refresh();
    const row = this.rows.get(id);
    if (!row) throw new RpcError("session/not-found", "CH Thread not found.", { sessionId: id });
    const harnessId = this.threads.harnessId(id);
    if (!harnessId)
      throw new RpcError("session/not-external", "CH did not confirm external Thread ownership.");
    let view = this.threads.view(id);
    if (!view) {
      view = new ChThreadHistory(
        this.host,
        row,
        harnessId,
        (sessionId, key, value, seq) => {
          for (const sink of this.controls)
            sink.push({ type: "projection", sessionId, key, value, seq });
        },
        this.threads.get(id)?.viewOrigin,
        this.attachments
          ? (content) => this.attachments?.project(id, content) ?? content
          : undefined,
      );
      view.log.setProjection("threadReference", { hostId: "local" });
      if (this.images) {
        view.log.setProjection("attachmentInput", this.files ? WEB_FILE_INPUT : WEB_IMAGE_INPUT);
        view.log.setProjection("imageLimits", WEB_IMAGE_LIMITS);
      }
      this.threads.ensure(id).view = view;
    }
    try {
      await view.refresh(force);
    } catch (error) {
      if (
        error instanceof RpcError &&
        (error.code === "host/history-changed" || error.code === "host/items-replaced")
      ) {
        // Browsers retain per-key projection watermarks across Thread reopening.
        // Rebuilt history must not make fresh queue/control values look stale.
        this.threads.discardView(id, view);
        view.log.reconnectFollowers();
        return this.readView(id, true);
      }
      throw error;
    }
    if (this.threads.view(id) !== view)
      throw new RpcError("host/resync", "Host snapshot was superseded by a new generation");
    view.log.setProjection(
      "nativeDiscovery",
      !view.thread.parentThreadId && view.thread.canAcceptDirectInput !== false,
    );
    if (view.ownerSnapshot && this.hostOnline && !this.closed)
      this.interactions?.update(view.ownerSnapshot);
    if (this.realtime)
      view.log.setProjection("nativeConnection", {
        state: this.hostOnline ? "connected" : "reconnecting",
      });
    this.threads.ensure(id).historyReadAt = Date.now();
    const name = await this.catalog.name(harnessId);
    if (this.threads.view(id) !== view)
      throw new RpcError("host/resync", "Host snapshot was superseded by a new generation");
    view.log.setProjection("harnessIdentity", { id: harnessId, name });
    this.loadControls(view, harnessId, force);
    this.loadUsage(view, force);
    // History and running state must converge even when a live status notification
    // was missed. Use the Host status, not the last Turn's completion state.
    if (!this.closed)
      this.events.emit("api-session/status", id, view.thread.status.type === "active");
    return view;
  }
  private loadUsage(view: ChThreadHistory, force: boolean): void {
    const id = view.thread.id;
    const active = this.threads.get(id)?.usage;
    if (active?.view === view) {
      if (force) active.dirty = true;
      return;
    }
    if (!force && Date.now() - (this.threads.get(id)?.usageReadAt ?? 0) < 30_000) return;
    const state: UsageLoad = {
      view,
      dirty: false,
      operation: Promise.resolve(),
    };
    state.operation = (async () => {
      do {
        state.dirty = false;
        const result = threadUsageInspectionSchema.parse(
          await this.host.request("codexhost/thread/usage/inspect", { threadId: id }),
        );
        if (this.closed || this.threads.view(id) !== view || this.threads.get(id)?.usage !== state)
          return;
        applyUsageProjections(view.log, result);
        this.threads.ensure(id).usageReadAt = Date.now();
      } while (state.dirty);
    })()
      .catch(() => {
        // Usage is optional metadata. Preserve the latest confirmed projection;
        // history and input remain usable, and the next invalidation retries.
      })
      .finally(() => {
        const current = this.threads.get(id);
        if (current?.usage === state) delete current.usage;
      });
    this.threads.ensure(id).usage = state;
  }
  private loadControls(view: ChThreadHistory, harnessId: string, force: boolean): void {
    const id = view.thread.id;
    if (!force && this.threads.get(id)?.controls) return;
    // Runtime inspection/config discovery must not gate the history snapshot.
    const loading = Promise.all([
      view.ownerSnapshot ? Promise.resolve(view.ownerSnapshot.configuration) : this.owner(id),
      this.catalog.inspect(harnessId, view.thread.cwd),
    ])
      .then(([owner, inspection]) => {
        if (
          this.closed ||
          this.threads.view(id) !== view ||
          this.threads.get(id)?.controls !== loading
        )
          return;
        const target = view.editableMessage();
        view.log.setProjection("sentMessageEdit", {
          seq:
            target &&
            inspection.status === "ready" &&
            inspection.capabilities.history.rollbackLastTurn &&
            !view.thread.parentThreadId &&
            view.thread.canAcceptDirectInput !== false &&
            editedNativeInput(target.input, "")
              ? target.seq
              : null,
        });
        view.log.setProjection("permissions", {
          currentValue: owner.effectivePermissionModeId ?? "",
        });
        view.log.setProjection(
          "nativePermissions",
          nativePermissionView(harnessId, inspection as Inspection, true),
        );
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
        const current = this.threads.get(id);
        if (current?.controls === loading) delete current.controls;
      });
    this.threads.ensure(id).controls = loading;
  }
  private async summary(row: ChThread) {
    const harnessId = this.threads.harnessId(row.id);
    if (!harnessId)
      throw new RpcError("session/not-external", "CH did not confirm external Thread ownership.");
    const values = {
      ...defaultProjections(),
      ...this.threads.view(row.id)?.log.projections,
      ...(this.images
        ? {
            attachmentInput: this.files ? WEB_FILE_INPUT : WEB_IMAGE_INPUT,
            imageLimits: WEB_IMAGE_LIMITS,
          }
        : {}),
      nativeDiscovery: !row.parentThreadId && row.canAcceptDirectInput !== false,
      threadReference: { hostId: "local" },
      title: threadListTitle(row),
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
  private async draftSummary(draft: Draft, includeControls = true) {
    // Catalog rows need only saved draft metadata; controls load when the draft is opened.
    const inspection = includeControls
      ? await this.catalog.inspect(draft.selection.provider, draft.cwd)
      : undefined;
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
          ...(includeControls ? defaultProjections() : {}),
          ...(this.images
            ? {
                attachmentInput: this.files ? WEB_FILE_INPUT : WEB_IMAGE_INPUT,
                imageLimits: WEB_IMAGE_LIMITS,
              }
            : {}),
          modelSelection: { lastUsed: null, next: draft.selection },
          harnessIdentity: {
            id: draft.selection.provider,
            name: await this.catalog.name(draft.selection.provider),
          },
          ...(inspection
            ? {
                nativePermissions: nativePermissionView(
                  draft.selection.provider,
                  inspection as Inspection,
                  false,
                ),
                permissions: {
                  currentValue: draft.permissionModeId ?? "",
                },
              }
            : {}),
        },
      },
    };
  }
  private async create(
    args: Record<string, unknown>,
    configuration?: DraftConfiguration,
  ): Promise<{ sessionId: string; agentPreset: string }> {
    const request = requestOf<{ cwd?: string; workspaceId?: string; sessionId?: string }>(args);
    const cwd =
      request.cwd ??
      (request.workspaceId ? this.workspaces.get(request.workspaceId)?.path : undefined);
    if ((request.workspaceId !== undefined || request.cwd !== undefined) && !cwd)
      throw new RpcError("workspace/invalid-path", "Choose a valid computer working directory.");
    const id = request.sessionId ?? `draft-${randomUUID()}`;
    const existing = this.drafts.get(id);
    if (existing && !existing.canonicalId && !existing.creating && existing.cwd === cwd)
      return { sessionId: id, agentPreset: "standard" };
    if (existing || this.rows.has(id))
      throw new RpcError("session/busy", "This Session already exists; start a new draft.");
    const selection = configuration?.selection ?? (await this.catalog.models()).default;
    const draft: Draft = { id, ...(cwd ? { cwd } : {}), selection, createdAt: Date.now() };
    if (configuration) {
      if (configuration.permissionModeId) draft.permissionModeId = configuration.permissionModeId;
    } else {
      const config = await this.preferences
        ?.configuration(selection.provider)
        .catch(() => undefined);
      const inspection = await this.catalog.inspect(selection.provider, cwd);
      const permissionModeId = draftPermissionMode(inspection, config?.permissionModeId);
      if (permissionModeId) draft.permissionModeId = permissionModeId;
    }
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    if (this.drafts.has(id)) return this.create(args, configuration);
    this.drafts.set(id, draft);
    if (cwd) this.workspaces.attachReferencedSession(id, cwd);
    this.workspaces.addDraftReference(id, cwd);
    this.events.emit("api-session/added", await this.draftSummary(draft));
    return { sessionId: id, agentPreset: "standard" };
  }
  /** Materialize a source-neutral draft without reading or writing global defaults. */
  async prepareDraft(
    request: { sessionId: string; cwd?: string },
    configuration: DraftConfiguration,
  ): Promise<void> {
    await this.create({ request }, configuration);
    const draft = this.drafts.get(request.sessionId);
    if (!draft || draft.creating || draft.canonicalId || draft.cwd !== request.cwd || this.closed)
      throw new RpcError("session/busy", "Draft is already in use.");
    draft.selection = { ...configuration.selection };
    delete draft.permissionModeId;
    if (configuration.permissionModeId) draft.permissionModeId = configuration.permissionModeId;
  }

  private async commit(draft: Draft, prompt: string): Promise<string> {
    if (draft.canonicalId) return draft.canonicalId;
    draft.creating ??= (async () => {
      const result = await this.host.request<{ thread: ChThread }>("thread/start", {
        historyMode: "paginated",
        ...(draft.cwd
          ? { cwd: draft.cwd }
          : { projectlessWorkspace: { prompt: prompt.slice(0, 16_384) } }),
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
      // Older Desktop CDP bridges may rewrite the explicit route. Confirm the
      // owner before binding the draft or sending any input; a rejected creating
      // promise fences retries without deleting a possibly allocated Session.
      const owner = await this.owner(result.thread.id);
      if (owner.harnessId !== draft.selection.provider)
        throw new RpcError(
          "session/harness-mismatch",
          `CH created a ${owner.harnessId} Thread instead of ${draft.selection.provider}. No message was sent. Update the Desktop bridge or use the Host client channel, then start a new conversation.`,
          {
            threadId: result.thread.id,
            expectedHarnessId: draft.selection.provider,
            actualHarnessId: owner.harnessId,
          },
        );
      draft.canonicalId = result.thread.id;
      this.files?.bind(draft.id, result.thread.id);
      this.rows.set(result.thread.id, result.thread);
      this.threads.setHarness(result.thread.id, owner.harnessId);
      this.workspaces.detachSession(draft.id);
      if (draft.cwd) {
        this.workspaces.selectReferenceWorkspace(draft.cwd);
        this.workspaces.attachReferencedSession(result.thread.id, result.thread.cwd);
        this.workspaces.addDraftReference(result.thread.id, draft.cwd);
      } else {
        this.workspaces.addDraftReference(result.thread.id, undefined);
      }
      this.events.emit("api-session/added", await this.summary(result.thread));
      this.publishedCatalog?.set(result.thread.id, this.catalogKey(result.thread));
      this.events.emit("codexhost/session-bound", draft.id, result.thread.id);
      return result.thread.id;
    })();
    // No automatic retry after creation failure: the Host may already have allocated an identity.
    return draft.creating;
  }

  /**
   * Working directory of one Host-confirmed local Thread.
   *
   * Drafts, official Codex Threads, and remote Threads have no local directory
   * here: the right Sidebar reports them unavailable rather than inventing one.
   * @param sessionId - Session identity the browser addressed.
   * @returns the Host-recorded directory, or undefined when this Thread has none.
   */
  localWorkspaceRoot(sessionId: string): string | undefined {
    const id = this.id(sessionId);
    if (this.drafts.has(id)) return undefined;
    return this.rows.get(id)?.cwd;
  }

  uploadFile(id: string, chunks: AsyncIterable<Uint8Array>, name?: string) {
    if (!this.fileInputs)
      throw new RpcError("session/attachment-invalid", "File uploads are unavailable.");
    return this.fileInputs.upload(id, chunks, name);
  }

  /** Draft input support for the Web composition; it does not create a Thread. */
  draftInputCapabilities(): Record<string, unknown> {
    return this.images
      ? {
          attachmentInput: this.files ? WEB_FILE_INPUT : WEB_IMAGE_INPUT,
          imageLimits: WEB_IMAGE_LIMITS,
        }
      : {};
  }

  /** Release a Web upload placeholder only; a native or in-flight Thread is never discarded. */
  discardUnsubmittedDraft(id: string): void {
    const draft = this.drafts.get(id);
    if (!draft) return;
    if (draft.canonicalId || draft.creating)
      throw new RpcError("session/busy", "A submitted Thread cannot change Session source.");
    this.drafts.delete(id);
  }

  private async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const id = this.id(sessionId);
    if (this.drafts.has(id))
      throw new RpcError(
        "session/not-started",
        "Send the first message before archiving this Thread.",
      );
    if (!this.threads.hasHarness(id)) await this.refresh();
    if (!this.threads.hasHarness(id))
      throw new RpcError("session/not-found", "This Thread is not in the shared catalog.");
    await this.owner(id);
    await this.host.request(archived ? "thread/archive" : "thread/unarchive", { threadId: id });
    // Finish any pre-write catalog read before confirming from a fresh Host snapshot.
    // A read failure cannot turn an acknowledged mutation into a rejected write.
    await this.refreshing?.catch(() => undefined);
    await this.refresh().catch(() => undefined);
  }

  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    this.fileInputs?.register(rpc);
    rpc.register("codexhost/editMessage", async (args) => {
      const request = requestOf<{ sessionId: string; atSeq: number; text: string }>(args);
      if (
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        !Number.isSafeInteger(request.atSeq) ||
        request.atSeq < 0 ||
        typeof request.text !== "string" ||
        !request.text.trim()
      )
        throw new RpcError("session/edit-invalid", "Invalid sent message edit.");
      const id = this.id(request.sessionId);
      if (this.drafts.has(id))
        throw new RpcError("session/not-started", "This message has not been sent.");
      return this.editing.edit({
        host: this.host,
        threadId: id,
        seq: request.atSeq,
        text: request.text,
        displayed: this.threads.view(id),
        read: () => this.view(id),
        reconcile: async () => {
          // Reopen from Host even after a rejected/unknown write; never synthesize a truncated log.
          const old = this.threads.view(id);
          if (old) {
            this.threads.discardView(id, old);
            old.log.reconnectFollowers();
          }
          await this.view(id);
        },
      });
    });
    for (const [method, archived] of [
      ["workspace/archiveSession", true],
      ["workspace/unarchiveSession", false],
    ] as const)
      rpc.register(method, async (args) => {
        const { sessionId } = requestOf<{ sessionId: string }>(args);
        await this.setArchived(sessionId, archived);
        return { archivedSessionIds: this.workspaces.archivedSessionIds() };
      });
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
        if (!this.threads.hasHarness(id)) await this.refresh();
        await this.owner(id);
        if (!this.threads.hasHarness(id))
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
              .map((d) => this.draftSummary(d, false)),
          )),
        ],
      };
    });
    rpc.register("session/create", (args) => this.create(args));
    rpc.register("session/fork", async (args) => {
      const request = requestOf<{ sessionId: string; atSeq?: number }>(args);
      if (
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        (request.atSeq !== undefined && (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0))
      )
        throw new RpcError("session/fork-invalid", "Invalid fork request.");
      const id = this.id(request.sessionId);
      if (this.drafts.has(id))
        return forkUnavailable(id, "Send a message before forking this session.");
      const displayed = this.threads.view(id);
      if (request.atSeq !== undefined && !displayed)
        return forkUnavailable(id, "Fork history expired. Reopen the conversation.");
      const view = await this.view(id);
      if (request.atSeq !== undefined && view !== displayed)
        return forkUnavailable(id, "Fork history changed. Reopen the conversation.");
      const result = await forkChThread(this.host, view, request.atSeq);
      // A failed catalog read must not turn a confirmed fork into a rejected write.
      // The next list/notification refresh will reconcile the canonical child.
      await this.refresh().catch(() => undefined);
      return result;
    });
    rpc.register("session/modelCatalog", () => this.catalog.models());
    rpc.register("session/selectModel", async (args) => {
      const request = requestOf<ModelSelection & { sessionId: string }>(args);
      const draft = this.drafts.get(request.sessionId);
      if (draft && !draft.canonicalId) {
        if (draft.creating) throw new RpcError("session/busy", "Draft creation is in progress.");
        const before = draft.selection;
        if (before.provider !== request.provider) {
          const config = await this.preferences
            ?.configuration(request.provider)
            .catch(() => undefined);
          const inspection = await this.catalog.inspect(request.provider, draft.cwd);
          if (draft.creating || draft.selection !== before)
            throw new RpcError("session/busy", "Draft selection changed.");
          const permissionModeId = draftPermissionMode(inspection, config?.permissionModeId);
          delete draft.permissionModeId;
          if (permissionModeId) draft.permissionModeId = permissionModeId;
        }
        draft.selection = request;
        await this.preferences
          ?.remember(request.provider, {
            model: { id: request.model },
            thinkingOptionId: request.reasoningEffort,
            permissionModeId: draft.permissionModeId,
          })
          .catch(() =>
            this.events.emit(
              "codexhost/preferences-error",
              "New session defaults could not be saved.",
            ),
          );
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
      const draft = this.drafts.get(request.sessionId);
      if (!draft || draft.canonicalId) await this.owner(request.sessionId);
      // Validate/save before creating a native Thread. Only native path context crosses the Host channel.
      const preparedInput = this.fileInputs
        ? await this.fileInputs.prepare(this.id(request.sessionId), request.content)
        : (this.images?.prepare(request.content) ?? request.content);
      // Use native text inputs so Desktop can also render queue entries when
      // connected to an older Host that forwards their shape unchanged.
      const input = preparedInput.map((part) =>
        part.type === "text" ? { text_elements: [], ...part } : part,
      );
      const threadId = draft
        ? await this.commit(
            draft,
            request.content
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n"),
          )
        : this.id(request.sessionId);
      await this.owner(threadId);
      if (request.mode === "steer") {
        const view = await this.view(threadId, true);
        const expectedTurnId =
          view.ownerSnapshot?.activeTurnId ??
          view.thread.turns.find((turn) => turn.status === "inProgress")?.id;
        if (expectedTurnId) {
          await this.host.request("turn/steer", {
            threadId,
            expectedTurnId,
            input,
            ...(request.requestId ? { clientUserMessageId: request.requestId } : {}),
          });
        } else {
          // DSH steering is best-effort: when the busy window closed before
          // admission, retain the message as the next canonical follow-up.
          await this.host.request("turn/start", {
            threadId,
            input,
            delivery: "queue",
            presentationInput: request.content,
            ...(request.requestId ? { clientUserMessageId: request.requestId } : {}),
          });
        }
      } else {
        await this.host.request("turn/start", {
          threadId,
          input,
          ...(request.mode === "queue"
            ? { delivery: "queue", presentationInput: request.content }
            : {}),
          ...(request.requestId ? { clientUserMessageId: request.requestId } : {}),
        });
      }
      this.fileInputs?.accepted(threadId, request.content);
      try {
        await this.view(threadId);
      } catch {
        // A failed read cannot turn an acknowledged write into a rejected send.
        if (this.realtime) {
          this.threads.view(threadId)?.log.setProjection("nativeConnection", {
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
      if (!this.attachments)
        throw new RpcError("session/attachment-not-found", "Image previews are unavailable.");
      return this.attachments.read(view, attachmentId);
    });
    rpc.register("session/updateQueue", async (args) => {
      const request = requestOf<{
        sessionId: string;
        itemId: string;
        action:
          | { kind: "edit"; content: Array<{ type: string; text?: string }> }
          | { kind: "remove" }
          | { kind: "steer" };
      }>(args);
      const threadId = this.id(request.sessionId);
      await this.owner(threadId);
      if (request.action.kind === "edit") {
        await this.host.request("thread/queue/update", {
          threadId,
          queuedSubmissionId: request.itemId,
          input: request.action.content.map((part) =>
            part.type === "text" ? { text_elements: [], ...part } : part,
          ),
          presentationInput: request.action.content,
        });
      } else if (request.action.kind === "remove") {
        const result = await this.host.request<{ deleted: boolean }>("thread/queue/delete", {
          threadId,
          queuedSubmissionId: request.itemId,
        });
        if (!result.deleted)
          throw new RpcError(
            "session/queue-item-not-found",
            "Queued message is no longer pending.",
          );
      } else {
        await this.host.request("codexhost/thread/queue/send-now", {
          threadId,
          itemId: request.itemId,
        });
      }
      try {
        await this.view(threadId, true);
      } catch {
        // The mutation was acknowledged. A failed projection read must not
        // prevent a removed message from being restored to the local composer.
        this.realtime?.invalidate(threadId);
      }
      return { accepted: true };
    });
    rpc.register("session/cancel", async (args) => {
      const { sessionId } = requestOf<{ sessionId: string }>(args);
      const view = await this.view(sessionId);
      const turnId =
        view.ownerSnapshot?.activeTurnId ??
        view.thread.turns.find((value) => value.status === "inProgress")?.id;
      if (!turnId) {
        if (view.thread.status.type === "active")
          throw new RpcError(
            "session/stop-unavailable",
            "CH reports active work, but no interruptible parent Turn is available.",
          );
        return { accepted: true };
      }
      await this.host.request("turn/interrupt", {
        threadId: this.id(sessionId),
        turnId,
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
          .map((row) => ({ sessionId: row.id, snippet: threadListTitle(row) }))
          .filter((item) => item.snippet.toLowerCase().includes(needle))
          .slice(0, 20),
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
        this.threads.view(this.id(req.address.sessionId)) ??
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
    for (const [method, archived] of [
      ["session/archive", true],
      ["session/unarchive", false],
    ] as const)
      rpc.register(method, async (args) => {
        const { sessionId } = requestOf<{ sessionId: string }>(args);
        await this.setArchived(sessionId, archived);
        return {};
      });
    streams.register("session/control", async (_args, sink) => {
      const projections: Record<string, unknown> = {};
      for (const draft of this.drafts.values())
        if (!draft.canonicalId) {
          const summary = await this.draftSummary(draft);
          if (!draft.canonicalId) projections[draft.id] = summary.projections;
        }
      if (sink.closed || this.closed) return;
      // Draft metadata can yield. Capture live state and subscribe only after
      // it settles, in one synchronous step: the client requires the baseline
      // before any delta, and changes during preparation belong in that baseline.
      for (const [id, view] of this.threads.views())
        projections[id] = view.log.projectionBaseline();
      this.controls.add(sink);
      sink.onClose(() => this.controls.delete(sink));
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
      // A read started before follow can miss changes made before subscription.
      // Reconcile after that read instead of adopting its potentially stale queue.
      const view = await this.view(request.address.sessionId, !this.realtime);
      // Reopening a Thread must not retain a snapshot that went stale while it
      // had no realtime follower. The initial open already has a read in flight.
      const tracked = this.threads.get(view.thread.id);
      if (tracked?.usageReadAt !== undefined && !tracked.usage) this.loadUsage(view, true);
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
      if (this.closed || this.refreshing || (this.realtime && !this.hostOnline)) return;
      if (!this.realtime || Date.now() - this.catalogReadAt >= 60_000) {
        void this.refresh().catch(() => undefined);
      } else {
        this.refreshing = this.syncWorkspace()
          .then(() => {
            if (!this.closed) void this.pins.refresh().catch(() => undefined);
          })
          .finally(() => {
            this.refreshing = undefined;
          });
        void this.refreshing.catch(() => undefined);
      }
    }, 10000);
    this.timer.unref();
  }

  registerCommands(rpc: RpcRegistry): void {
    const native = new ChHarnessCommands(this.host, async (sessionId) => {
      const id = this.id(sessionId);
      if (
        typeof sessionId !== "string" ||
        !sessionId ||
        (this.drafts.has(sessionId) && !this.drafts.get(sessionId)?.canonicalId)
      )
        throw new RpcError("command/unavailable", "Commands require an existing external Thread.");
      if (this.closed || !this.hostOnline)
        throw new RpcError("host/offline", "The Host is disconnected.");
      await this.owner(id);
      const { thread } = await this.host.request<{ thread: ChThread }>("thread/read", {
        threadId: id,
        includeTurns: false,
      });
      if (thread.id !== id || thread.parentThreadId || thread.canAcceptDirectInput === false)
        throw new RpcError(
          "command/unavailable",
          "Commands require an editable local external Thread.",
        );
      return thread;
    });
    rpc.register("codexhost/threadCommands", (args) =>
      native.inspect(requestOf<{ sessionId: string }>(args).sessionId),
    );
    rpc.register("codexhost/executeThreadCommand", (args) => {
      const { sessionId, commandId } = requestOf<{ sessionId: string; commandId: string }>(args);
      return native.execute(sessionId, commandId);
    });
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
        if (draft.creating || draft.selection.provider !== harnessId)
          throw new RpcError("session/busy", "Draft selection changed.");
        draft.permissionModeId = modeId;
        await this.preferences
          ?.remember(harnessId, {
            model: { id: draft.selection.model },
            thinkingOptionId: draft.selection.reasoningEffort,
            permissionModeId: modeId,
          })
          .catch(() =>
            this.events.emit(
              "codexhost/preferences-error",
              "New session defaults could not be saved.",
            ),
          );
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
    rpc.register("codexhost/importSources", () =>
      this.host.request("codexhost/harness/session-import/sources", {}),
    );
    rpc.register("codexhost/importCandidates", (args) =>
      this.host.request("codexhost/harness/session-import/list", requestOf(args)),
    );
    rpc.register("codexhost/import", async (args) => {
      const result = await this.host.request<{ threadId: string }>(
        "codexhost/harness/session-import/import",
        requestOf(args),
      );
      // The Host mapping is committed; a failed catalog read cannot reject that write.
      await this.refresh().catch(() => undefined);
      return result;
    });
  }
  async importRecent(limit: number): Promise<number> {
    void limit;
    throw new RpcError("host/import-explicit", "CH imports must be explicitly selected.");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pins.close();
    this.realtime?.close();
    this.interactions?.clear();
    clearInterval(this.timer);
    this.host.close();
    for (const sink of this.controls) sink.end();
  }
}
