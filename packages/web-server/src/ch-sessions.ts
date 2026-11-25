import { draftPermissionMode, type DraftConfiguration } from "./draft-configuration.ts";
/** CH-backed Web facade: canonical Threads are owned/persisted by CH, Web holds only rendering buffers. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  THREAD_ARCHIVE_CONFIRM_METHOD,
  THREAD_STEER_STRICT_TARGET_FIELD,
  THREAD_STEER_STRICT_TARGET_PARAM,
  WEB_ACTIVE_TURN_PROJECTION,
  WEB_FOLLOW_PROJECTION_KEYS,
  WEB_HANDOFF_PROJECTION,
  clientThreadSectionsSchema,
  clientThreadSectionMoveSchema,
  webTurnDiffsRequestSchema,
  webToolOutputReferenceSchema,
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  harnessModelSelectionStateSchema,
  harnessModelRefFromKey,
  harnessModelRefKey,
  sameHarnessModelRef,
  threadInspectionSchema,
  threadArchiveConfirmResultSchema,
  threadUsageInspectionSchema,
  type HarnessDisplayEntries,
  type ThreadCatalogReadParams,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";
import type { ChHostClient, ChProjectSnapshot } from "./ch-host-client.ts";
import { ChHarnessCatalog, type ModelSelection } from "./ch-harness-catalog.ts";
import type { ChThread } from "./ch-thread-view.ts";
import type { Inspection } from "./harnesses.ts";
import { nativePermissionView } from "./session-presentation.ts";
import { nativeProjectByCwd, projectGroupRoot } from "./ch-project-groups.ts";
import { projectRootTitles } from "./workspaces.ts";
import { threadListTitle } from "./ch-thread-title.ts";
import { ChThreadHistory } from "./ch-thread-history.ts";
import { WebThreadStates, type UsageLoad } from "./web-thread-state.ts";
import { ChHarnessCommands } from "./ch-harness-commands.ts";
import { WebSkills } from "./skills.ts";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { ChThreadEditing } from "./ch-thread-edit.ts";
import { canEditQueuedInput, takeQueuedItemForEdit } from "./ch-queue-edit.ts";
import { editedNativeInput } from "./native-user-input.ts";
import { forkChThread, forkUnavailable } from "./ch-thread-fork.ts";
import { handoffChThread, handoffUnavailable } from "./ch-thread-handoff.ts";
import { ChPinnedThreads } from "./ch-pinned-threads.ts";
import { ChThreadTree } from "./ch-thread-tree.ts";
import { type WebImages, WEB_IMAGE_INPUT, WEB_IMAGE_LIMITS } from "./web-images.ts";
import { ChAttachments } from "./ch-attachments.ts";
import { ChFileInputs, type FileUploadTiming } from "./ch-file-inputs.ts";
import { WebFileReferences, type RemoteFileReferencesSearch } from "./file-references.ts";
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
import { readToolOutput, toolOutputRecords, toolOutputSink } from "./tool-output.ts";
import type { WireEvent } from "./session-log.ts";
import { SessionListTiming } from "./session-list-timing.ts";
import { readSessionPage, nextCatalogCursor, type CatalogPage } from "./ch-session-page.ts";
import { tryGenerateThreadTitle } from "./ch-thread-titles.ts";

type CatalogScope = NonNullable<ThreadCatalogReadParams["scope"]>;

function globalProjectionValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !WEB_FOLLOW_PROJECTION_KEYS.has(key)),
  );
}

interface Draft {
  id: string;
  cwd?: string;
  projectId?: string;
  selection: ModelSelection;
  permissionModeId?: string;
  createdAt: number;
  canonicalId?: string;
  creating?: Promise<string>;
  /** Host-confirmed Thread awaiting project assignment; retries reuse it instead of starting another. */
  started?: { thread: ChThread; harnessId: string };
  titleRequested?: boolean;
}

export class ChSessions {
  private readonly fileReferences = new WebFileReferences((id) => this.fileWorkspaceRoot(id));
  readonly catalog: ChHarnessCatalog;
  private readonly editing = new ChThreadEditing();
  private readonly pins: ChPinnedThreads;
  private readonly tree: ChThreadTree;
  private readonly attachments: ChAttachments | undefined;
  private readonly fileInputs: ChFileInputs | undefined;
  private rows = new Map<string, ChThread>();
  private publishedCatalog: Map<string, string> | undefined;
  private readonly handoffs = new Map<string, ThreadHandoffMetadata | null>();
  /** Loaded rows accumulate across partial official pages; drafts are not Host Threads. */
  private readonly threads = new WebThreadStates();
  private drafts = new Map<string, Draft>();
  private controls = new Set<StreamSink>();
  private refreshing: Promise<CatalogPage | undefined> | undefined;
  private refreshingCatalog = false;
  private refreshingArchives = false;
  private refreshingArchiveChanges: Map<string, boolean> | undefined;
  private refreshingProjectAssignments: Map<string, string> | undefined;
  private readonly archiveOperations = new Map<string, symbol>();
  private readonly queueOperations = new Map<string, Promise<void>>();
  private refreshingTiming: SessionListTiming | undefined;
  private catalogReadAt = -Infinity;
  private timer?: NodeJS.Timeout;
  private idleViewTimer?: NodeJS.Timeout;
  private closed = false;
  private readonly realtime: ChRealtime | undefined;
  private readonly skills: WebSkills;
  private readonly titleRequests = new Set<string>();
  private readonly interactions: ChInteractions | undefined;
  private hostOnline = true;
  private hostEpoch: string | undefined;
  constructor(
    private readonly host: ChHostClient,
    private readonly workspaces: Workspaces,
    private readonly events: EventHub,
    private readonly images?: WebImages,
    private readonly files?: WebFiles,
    displayEntries?: () => Promise<HarnessDisplayEntries>,
    private readonly preferences?: WebHarnessPreferences,
    harnesses?: ReadonlySet<string>,
    private readonly openFile?: (path: unknown, action?: "reveal") => Promise<{ opened: true }>,
  ) {
    this.catalog = new ChHarnessCatalog(host, events, displayEntries, preferences, harnesses);
    this.attachments = images ? new ChAttachments(images, files) : undefined;
    this.fileInputs =
      files && images
        ? new ChFileInputs(files, images, async (id) => {
            id = this.id(id);
            if (this.closed) throw new RpcError("host/offline", "The Web connection is closed.");
            if (this.drafts.has(id)) return id;
            await this.owner(id);
            if (!this.rows.has(id)) await this.refresh();
            const error = this.attachmentThreadError(id);
            if (error) throw error;
            return id;
          })
        : undefined;
    this.skills = new WebSkills(host, events, async (sessionId) => {
      if (this.closed || !this.hostOnline)
        throw new RpcError("host/offline", "The Host is disconnected.");
      const id = this.id(sessionId);
      const draft = this.drafts.get(id);
      if (draft && !draft.canonicalId) {
        if (draft.selection.provider === "codex")
          throw new RpcError("skills/unavailable", "Codex uses its native Skills.");
        return draft.cwd ? { cwd: draft.cwd } : {};
      }
      const owner = await this.owner(id);
      const row = this.rows.get(id);
      if (owner.harnessId === "codex" || row?.parentThreadId || row?.canAcceptDirectInput === false)
        throw new RpcError(
          "skills/unavailable",
          "Skills require an editable local external Thread.",
        );
      return { threadId: hostThreadIdSchema.parse(id) };
    });
    this.pins = new ChPinnedThreads(host, workspaces);
    this.tree = new ChThreadTree(host);
    workspaces.setReferenceArchives([]);
    this.interactions = host.realtime
      ? new ChInteractions(host.realtime, events, (id, message) => {
          this.threads.view(id)?.log.setProjection("nativeInteractionError", message);
        })
      : undefined;
    this.realtime = host.realtime
      ? new ChRealtime(host.realtime, {
          thread: (id) => this.view(id),
          usage: (id) => {
            const view = this.threads.view(id);
            if (view) this.loadUsage(view, true);
          },
          catalog: async () => {
            await this.refresh();
          },
          archived: (id, archived) => {
            this.archiveOperations.delete(id);
            this.updateArchive(id, archived);
          },
          connection: (online) => {
            this.hostOnline = online;
            if (!online) {
              this.archiveOperations.clear();
              this.interactions?.clear();
            }
            for (const [, view] of this.threads.views())
              view.log.setProjection("nativeConnection", {
                state: online ? "connected" : "reconnecting",
              });
          },
          reset: (epoch, full) => {
            this.archiveOperations.clear();
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
  private attachmentThreadError(id: string): RpcError | undefined {
    if (!this.threads.hasHarness(id))
      return new RpcError("session/not-found", "CH Thread not found.");
    if ((this.rows.get(id) ?? this.threads.view(id)?.thread)?.parentThreadId)
      return new RpcError("subagent/attachment-invalid", "Subagent file uploads are unavailable.");
    return undefined;
  }
  private runQueuedOperation<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queueOperations.get(threadId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tracked = current
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.queueOperations.get(threadId) === tracked) this.queueOperations.delete(threadId);
      });
    this.queueOperations.set(threadId, tracked);
    return current;
  }
  async refreshProjects(): Promise<void> {
    await this.refreshing?.catch(() => undefined);
    await this.refresh();
  }
  /** Assign a conversation to a native project, confirmed by Codex before Web shows the move. */
  async assignNativeProject(sessionId: string, projectId: string): Promise<void> {
    const draft = this.drafts.get(sessionId);
    if (draft && !draft.canonicalId) {
      if (draft.creating)
        throw new RpcError(
          "session/busy",
          "This conversation is starting; move it once it starts.",
        );
      draft.projectId = projectId;
      return;
    }
    const threadId = this.id(sessionId);
    const updated = await this.host.request<{ thread: ChThread }>("thread/metadata/update", {
      threadId,
      projectId,
    });
    if (updated.thread.projectId !== projectId)
      throw new RpcError(
        "workspace/assignment-unconfirmed",
        "Codex did not confirm the conversation's project.",
      );
    this.refreshingProjectAssignments?.set(threadId, projectId);
    const row = this.rows.get(threadId);
    if (row) row.projectId = projectId;
  }
  /** A `scope` reads an explicit page on until it reaches a Thread of that folder. */
  private async refresh(
    timing?: SessionListTiming,
    includeArchived = false,
    cursor?: string,
    scope?: CatalogScope,
  ): Promise<CatalogPage | undefined> {
    if (this.closed) return;
    if (
      this.refreshing &&
      (cursor !== undefined ||
        !this.refreshingCatalog ||
        includeArchived !== this.refreshingArchives)
    ) {
      const stage = this.refreshingCatalog ? "catalog_wait" : "workspace_wait";
      const pending = this.refreshing.catch(() => undefined);
      await (timing ? timing.measure(stage, () => pending) : pending);
      return this.refresh(timing, includeArchived, cursor, scope);
    }
    const mode = this.refreshing ? "joined" : "started";
    if (!this.refreshing) {
      this.refreshingCatalog = cursor === undefined;
      this.refreshingArchives = includeArchived;
      this.refreshingTiming = new SessionListTiming();
      const archiveChanges = new Map<string, boolean>();
      this.refreshingArchiveChanges = archiveChanges;
      this.refreshingProjectAssignments = new Map();
      this.refreshing = this.listAll(
        this.refreshingTiming,
        includeArchived,
        archiveChanges,
        cursor,
        scope,
      ).finally(() => {
        this.refreshing = undefined;
        this.refreshingCatalog = false;
        this.refreshingArchives = false;
        this.refreshingArchiveChanges = undefined;
        this.refreshingProjectAssignments = undefined;
        this.refreshingTiming = undefined;
      });
    }
    const pending = this.refreshing;
    const catalogTiming = this.refreshingTiming;
    try {
      return await (timing ? timing.measure("catalog_wait", () => pending) : pending);
    } finally {
      if (timing && catalogTiming) timing.catalog = { mode, ...catalogTiming.snapshot() };
    }
  }
  private refreshPins(): Promise<string[]> {
    return this.pins.refresh().catch((error: unknown) => {
      console.error("[session/list] native pins unavailable", error);
      return this.workspaces.pinnedSessionIds();
    });
  }
  private async listAll(
    timing: SessionListTiming,
    includeArchived: boolean,
    archiveChanges: ReadonlyMap<string, boolean>,
    cursor?: string,
    scope?: CatalogScope,
  ): Promise<CatalogPage | undefined> {
    const known = new Set(this.rows.keys());
    const [{ page: snapshot }, definitions, , sections] = await Promise.all([
      readSessionPage(this.host, timing, includeArchived, cursor, () => this.refreshPins(), scope),
      timing.measure("project_definitions", () => this.host.projects([])),
      timing.measure("thread_tree", () => this.tree.refresh()),
      timing.measure("thread_sections", async () => {
        try {
          return clientThreadSectionsSchema.parse(
            await this.host.request("codexhost/thread/sections/list", {}),
          ).sections;
        } catch {
          // Optional on older Hosts; keep the last confirmed snapshot on a read failure.
          return undefined;
        }
      }),
    ]);
    if (this.closed) return;
    const found = new Map(snapshot.threads.map((row) => [row.id, row]));
    const snapshotArchives = new Set<string>(snapshot.archivedThreadIds);
    const archivedIds = new Set(this.workspaces.localArchivedSessionIds());
    for (const id of snapshotArchives) archivedIds.add(id);
    for (const id of found.keys()) if (!snapshotArchives.has(id)) archivedIds.delete(id);
    const ownership = new Map<string, string>();
    for (const item of snapshot.ownership) {
      if (
        item.owner === "external" &&
        item.harnessId &&
        found.get(item.threadId)?.modelProvider === "codexhost"
      )
        ownership.set(item.threadId, item.harnessId);
      else if (item.owner === "codex") ownership.set(item.threadId, "codex");
    }
    const pageSectionAdditions = cursor === undefined ? undefined : new Set<string>();
    const threadSections = sections?.map(({ id, name, threads }) => {
      const threadIds: string[] = [];
      for (const thread of threads) {
        if (typeof thread.id !== "string" || thread.archived === true) continue;
        if (thread.archived === false && !snapshotArchives.has(thread.id))
          archivedIds.delete(thread.id);
        if (!found.has(thread.id)) {
          const row = thread as unknown as ChThread;
          found.set(thread.id, row);
          ownership.set(thread.id, "codex");
          if (cursor === undefined || !this.publishedCatalog?.has(row.id))
            snapshot.threads.push(row);
        }
        if (ownership.get(thread.id) === "codex") {
          threadIds.push(thread.id);
          if (!this.publishedCatalog?.has(thread.id)) pageSectionAdditions?.add(thread.id);
        }
      }
      return { id, name, threadIds };
    });
    timing.count("ownershipIds", ownership.size);
    timing.count(
      "archivedRows",
      snapshot.threads.filter((row) => snapshotArchives.has(row.id)).length,
    );
    timing.count(
      "unarchivedRows",
      snapshot.threads.filter((row) => !snapshotArchives.has(row.id)).length,
    );
    const rows = new Map([...found].filter(([id]) => ownership.has(id)));
    for (const [id, row] of this.rows) {
      const harnessId = this.threads.harnessId(id);
      if (found.has(id) || !harnessId) continue;
      // Omission from an official page is not deletion or archive evidence.
      // External metadata is complete on the head page, so missing rows may leave only when cursor is undefined.
      if (
        cursor === undefined &&
        harnessId !== "codex" &&
        known.has(id) &&
        !archiveChanges.has(id) &&
        (includeArchived || !archivedIds.has(id))
      )
        continue;
      rows.set(id, row);
      ownership.set(id, harnessId);
    }
    await this.tree.supplement(rows, async (id) => {
      const { thread, harnessId } = await this.readThread(id);
      ownership.set(id, harnessId);
      if (thread.archived === true) archivedIds.add(id);
      return thread;
    });
    const assignments = await timing.measure("projects", () =>
      this.host.projects([...rows.keys()]),
    );
    const projects = { ...assignments, projects: definitions.projects };
    if (this.closed) return;
    // A Host-confirmed move supersedes project metadata from this in-flight read.
    for (const [id, projectId] of this.refreshingProjectAssignments ?? []) {
      const row = rows.get(id);
      if (row) row.projectId = projectId;
    }
    this.threads.replaceHarnesses(ownership);
    this.rows = rows;
    timing.count("visibleRows", rows.size);
    await this.syncWorkspace(timing, projects);
    if (this.closed) return;
    // Project members resolve to Workspaces, which exist once their roots are synced.
    if (threadSections && (!this.workspaces.usesNativeProjects || projects.nativeProjects))
      this.workspaces.setReferenceThreadSections(
        threadSections,
        definitions.projects,
        definitions.sectionProjects,
      );
    // Notifications received during catalog or ancestor reads supersede their membership.
    for (const [id, archived] of archiveChanges) {
      if (archived) archivedIds.add(id);
      else archivedIds.delete(id);
    }
    timing.measureSync("archive_sync", () =>
      this.workspaces.setReferenceArchives([...archivedIds].sort()),
    );
    await timing.measure("catalog_publish", () => this.publishCatalogChanges(pageSectionAdditions));
    this.catalogReadAt = Date.now();
    return snapshot;
  }
  private async syncWorkspace(
    timing = new SessionListTiming(),
    snapshot?: ChProjectSnapshot,
  ): Promise<void> {
    const projects =
      snapshot ??
      (await timing.measure("projects", () => this.host.projects([...this.rows.keys()])));
    timing.count("projects", projects.projects.length);
    if (this.closed) return;
    timing.measureSync("workspace_sync", () => {
      const groups = new Map<string, string | undefined>();
      if (projects.nativeProjects) {
        const known = new Set(projects.projects.map((project) => project.id));
        for (const row of this.rows.values()) {
          // A stale or foreign project ID must not hide the Thread; fall back like Desktop does.
          const explicit = [row.projectId, projects.assignments[row.id]].find(
            (id): id is string => typeof id === "string" && known.has(id),
          );
          // Desktop lists a Thread without a project under the project whose root holds its cwd.
          const byCwd =
            explicit === undefined && row.cwd && row.workspaceKind !== "projectless"
              ? nativeProjectByCwd(projects, row.id, row.cwd)
              : undefined;
          groups.set(row.id, explicit ?? byCwd);
        }
        for (const draft of this.drafts.values())
          if (!draft.canonicalId) groups.set(draft.id, draft.projectId);
        this.workspaces.syncNativeProjects(projects.projects, groups, projects.assignments);
        return;
      }
      if (this.workspaces.usesNativeProjects) return;
      const references: Array<{ sessionId: string; cwd: string; title?: string }> = [];
      const rootTitles = projectRootTitles(projects.projects);
      const projectless = new Set(projects.projectless.filter((id) => !projects.assignments[id]));
      for (const row of this.rows.values()) {
        if (row.workspaceKind === "projectless" && !row.projectId && !projects.assignments[row.id])
          projectless.add(row.id);
        const root =
          row.cwd && !projectless.has(row.id)
            ? projectGroupRoot(projects, row.id, row.cwd)
            : undefined;
        groups.set(row.id, root);
        if (root) {
          // Only the project's first root keeps the native project name; other
          // roots fall back to their folder name so titles never duplicate.
          // Conflicting titles fall back to the full path, matching Workspaces.
          const project = projects.projects.find((project) => project.rootPaths.includes(root));
          const title = project === undefined ? undefined : rootTitles.get(resolve(root));
          references.push({
            sessionId: row.id,
            cwd: root,
            ...(title !== undefined ? { title } : {}),
          });
        }
      }
      for (const draft of this.drafts.values()) {
        if (draft.canonicalId) continue;
        groups.set(draft.id, draft.cwd);
        if (!draft.cwd) projectless.add(draft.id);
      }
      timing.count("workspaceReferences", references.length);
      this.workspaces.syncReferencedSessions(references, groups, projectless, projects.projects);
    });
  }
  private archiveForkParent(row: ChThread): string | null {
    return this.threads.harnessId(row.id) === "codex" &&
      !row.parentThreadId &&
      typeof row.forkedFromId === "string" &&
      !this.workspaces.pinnedSessionIds().includes(row.id)
      ? row.forkedFromId
      : null;
  }
  /** Only fields used by the list summary; projections have their own
   * streams. Re-emitting every row makes each browser rebuild its entire
   * catalog thousands of times and starves interactive history frames.
   */
  private catalogKey(row: ChThread): string {
    return JSON.stringify([
      threadListTitle(row),
      row.cwd,
      row.updatedAt,
      row.status.type,
      row.parentThreadId ?? null,
      this.tree.parent(row.id),
      this.archiveForkParent(row),
      row.canAcceptDirectInput !== false,
      row.codexhostImportSource ?? null,
      this.threads.harnessId(row.id),
    ]);
  }
  private catalogProjections(row: ChThread) {
    return {
      title: threadListTitle(row),
      threadTreeParent: this.tree.parent(row.id),
      archiveForkParent: this.archiveForkParent(row),
      codexhostImportSource: row.codexhostImportSource ?? null,
    };
  }
  private async publishCatalogChanges(pageSectionAdditions?: ReadonlySet<string>): Promise<void> {
    const before = this.publishedCatalog;
    const next = new Map([...this.rows].map(([id, row]) => [id, this.catalogKey(row)]));
    // First load is already delivered by session/list. Subsequent refreshes,
    // including ones requested by a second browser, publish actual deltas only.
    // New continuation rows stay request-local unless a shared section references them.
    const changed =
      before === undefined
        ? []
        : await Promise.all(
            [...this.rows.values()]
              .filter(
                (row) =>
                  before.get(row.id) !== next.get(row.id) &&
                  (!pageSectionAdditions || before.has(row.id) || pageSectionAdditions.has(row.id)),
              )
              .map((row) => this.summary(row)),
          );
    this.publishedCatalog = next;
    // Previously opened Threads retain sequenced browser projections even after
    // unfollow. Cached catalog hints cannot replace them. Push the authoritative
    // metadata through the existing control stream without rereading any history.
    for (const [id, row] of this.rows) {
      const log = this.threads.view(id)?.log;
      if (!log) continue;
      for (const [key, value] of Object.entries(this.catalogProjections(row)))
        log.setProjection(key, value);
    }
    // A Thread whose view was dropped has no journal to publish through, yet browsers
    // keep its sequenced values. Advance the reserved sequence below its next view.
    if (this.controls.size > 0) {
      for (const { sessionId } of changed) {
        const row = this.rows.get(sessionId);
        const seq = row ? this.threads.reserveDroppedProjectionSeq(sessionId) : undefined;
        if (!row || seq === undefined) continue;
        for (const [key, value] of Object.entries(this.catalogProjections(row)))
          for (const sink of this.controls)
            sink.push({ type: "projection", sessionId, key, value, seq });
      }
    }
    for (const row of changed) this.events.emit("api-session/added", row);
    if (before)
      for (const id of before.keys())
        if (!next.has(id)) {
          this.handoffs.delete(id);
          this.events.emit("api-session/removed", id);
        }
  }
  private async owner(id: string) {
    const resolved = this.id(id);
    if (resolved.startsWith("draft-"))
      throw new RpcError("session/not-found", "Draft Session is no longer available.");
    const inspection = threadInspectionSchema.parse(
      await this.host.request("codexhost/thread/inspect", { threadId: resolved }),
    );
    this.handoffs.set(resolved, inspection.handoff ?? null);
    return {
      ...inspection,
      harnessId: inspection.owner === "codex" ? "codex" : inspection.harnessId,
    };
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
    const configurationRevision = this.threads.get(id)?.configurationRevision ?? 0;
    let row = this.rows.get(id) ?? this.threads.view(id)?.thread;
    let harnessId = this.threads.harnessId(id);
    if (!row || !harnessId) {
      const owner = await this.owner(id);
      harnessId = owner.harnessId;
      if (!harnessId)
        throw new RpcError("session/ownership-unconfirmed", "CH did not confirm Thread ownership.");
      row ??= (
        await this.host.request<{ thread: ChThread }>("thread/read", {
          threadId: id,
          includeTurns: false,
        })
      ).thread;
      if (row.id !== id || (owner.owner === "external" && row.modelProvider !== "codexhost"))
        throw new RpcError("session/ownership-unconfirmed", "CH did not confirm Thread identity.");
      this.threads.setHarness(id, harnessId);
    }
    let view = this.threads.view(id);
    if (!view) {
      const history: ChThreadHistory = new ChThreadHistory(
        this.host,
        row,
        harnessId,
        (sessionId, key, value, seq) => {
          if (WEB_FOLLOW_PROJECTION_KEYS.has(key)) {
            history.log.pushProjection(key, value, seq);
          } else {
            for (const sink of this.controls)
              sink.push({ type: "projection", sessionId, key, value, seq });
          }
        },
        this.threads.get(id)?.viewOrigin,
        this.attachments
          ? (content) => this.attachments?.project(id, content) ?? content
          : undefined,
        this.attachments
          ? (path, projectionKey) => this.attachments?.projectImageView(id, path, projectionKey)
          : undefined,
        {
          canEditQueueItem: (input, projected, allowsAttachments) =>
            canEditQueuedInput(input, projected, allowsAttachments, {
              ...(this.images ? { images: this.images } : {}),
              ...(this.files ? { files: this.files } : {}),
            }),
        },
      );
      view = history;
      view.log.setProjection("threadReference", { hostId: "local" });
      view.log.setProjection("threadTreeParent", this.tree.parent(id));
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
        console.warn(
          `[ch] rebuilding history follow: thread=${id} harness=${harnessId} reason=${String(error.code)}`,
        );
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
      "archiveForkParent",
      this.archiveForkParent(this.rows.get(id) ?? view.thread),
    );
    view.log.setProjection(
      "nativeDiscovery",
      !view.thread.parentThreadId && view.thread.canAcceptDirectInput !== false,
    );
    if (view.ownerSnapshot) {
      this.handoffs.set(id, view.ownerSnapshot.handoff ?? null);
      view.log.setProjection(WEB_HANDOFF_PROJECTION, view.ownerSnapshot.handoff ?? null);
    } else if (this.handoffs.has(id)) {
      view.log.setProjection(WEB_HANDOFF_PROJECTION, this.handoffs.get(id) ?? null);
    }
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
    this.loadControls(view, harnessId, force, configurationRevision);
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
    const isCurrent = () =>
      !this.closed && this.threads.view(id) === view && this.threads.get(id)?.usage === state;
    this.threads.ensure(id).usage = state;
    state.operation = (async () => {
      try {
        while (isCurrent()) {
          state.dirty = false;
          try {
            const result = threadUsageInspectionSchema.parse(
              await this.host.request("codexhost/thread/usage/inspect", { threadId: id }),
            );
            if (!isCurrent()) return;
            applyUsageProjections(view.log, result);
            this.threads.ensure(id).usageReadAt = Date.now();
          } catch {
            // Preserve the latest confirmed projection. Only a pending invalidation retries.
          }
          if (!state.dirty) return;
        }
      } finally {
        const current = this.threads.get(id);
        if (current?.usage === state) delete current.usage;
      }
    })();
  }
  private loadControls(
    view: ChThreadHistory,
    harnessId: string,
    force: boolean,
    configurationRevision: number,
  ): void {
    const id = view.thread.id;
    if ((this.threads.get(id)?.configurationRevision ?? 0) !== configurationRevision) return;
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
          this.threads.get(id)?.controls !== loading ||
          (this.threads.get(id)?.configurationRevision ?? 0) !== configurationRevision
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
        if ("handoff" in owner) {
          view.log.setProjection(WEB_HANDOFF_PROJECTION, owner.handoff ?? null);
        } else if (!view.ownerSnapshot) {
          view.log.setProjection(WEB_HANDOFF_PROJECTION, null);
        }
        const selection = {
          provider: harnessId,
          model: owner.effectiveModel ? harnessModelRefKey(owner.effectiveModel) : "harness",
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
      throw new RpcError("session/ownership-unconfirmed", "CH did not confirm Thread ownership.");
    const projections = this.threads.view(row.id)?.log.projections ?? {};
    // List readers use connection hints and child navigation, not full controls.
    const hintKeys = [
      "nativeConnection",
      "nativeInteractionError",
      "subagentCatalog",
      WEB_HANDOFF_PROJECTION,
      ...(row.parentThreadId ? ["subagent", "subagentTiming", "tokenUsage"] : []),
    ];
    const values = {
      ...Object.fromEntries(
        hintKeys
          .filter((key) => Object.hasOwn(projections, key))
          .map((key) => [key, projections[key]]),
      ),
      ...(this.handoffs.has(row.id) && !Object.hasOwn(projections, WEB_HANDOFF_PROJECTION)
        ? { [WEB_HANDOFF_PROJECTION]: this.handoffs.get(row.id) ?? null }
        : {}),
      threadTreeParent: this.tree.parent(row.id),
      archiveForkParent: this.archiveForkParent(row),
      nativeDiscovery: !row.parentThreadId && row.canAcceptDirectInput !== false,
      threadReference: { hostId: "local" },
      title: threadListTitle(row),
      codexhostImportSource: row.codexhostImportSource ?? null,
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
          ...(includeControls
            ? {
                ...defaultProjections(),
                ...(this.images
                  ? {
                      attachmentInput: this.files ? WEB_FILE_INPUT : WEB_IMAGE_INPUT,
                      imageLimits: WEB_IMAGE_LIMITS,
                    }
                  : {}),
                modelSelection: { lastUsed: null, next: draft.selection },
              }
            : {}),
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
    const workspace = request.workspaceId ? this.workspaces.get(request.workspaceId) : undefined;
    const cwd = request.cwd ?? workspace?.path;
    const projectId =
      workspace?.projectId ??
      (cwd && this.workspaces.usesNativeProjects
        ? this.workspaces.byPath(resolve(cwd))?.projectId
        : undefined);
    if ((request.workspaceId !== undefined || request.cwd !== undefined) && !cwd)
      throw new RpcError("workspace/invalid-path", "Choose a valid computer working directory.");
    const id = request.sessionId ?? `draft-${randomUUID()}`;
    const existing = this.drafts.get(id);
    if (
      existing &&
      !existing.canonicalId &&
      !existing.creating &&
      !existing.started &&
      existing.cwd === cwd &&
      existing.projectId === projectId
    )
      return { sessionId: id, agentPreset: "standard" };
    if (existing || this.rows.has(id))
      throw new RpcError("session/busy", "This Session already exists; start a new draft.");
    const preferences = configuration ? undefined : this.preferences?.get().catch(() => undefined);
    const selection =
      configuration?.selection ??
      (await this.catalog.models(false, undefined, preferences)).default;
    if (!selection)
      throw new RpcError(
        "host/no-harness",
        "No models are available. Re-detect the Harness in Connections to authorize access.",
      );
    const draft: Draft = {
      id,
      ...(cwd ? { cwd } : {}),
      ...(projectId ? { projectId } : {}),
      selection,
      createdAt: Date.now(),
    };
    if (configuration) {
      if (configuration.permissionModeId) draft.permissionModeId = configuration.permissionModeId;
    } else {
      const config = (await preferences)?.values.newThread?.byHarness[selection.provider];
      const inspection = await this.catalog.inspect(selection.provider, cwd);
      const permissionModeId = draftPermissionMode(
        selection.provider,
        inspection,
        config?.permissionModeId,
      );
      if (permissionModeId) draft.permissionModeId = permissionModeId;
    }
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    if (this.drafts.has(id)) return this.create(args, configuration);
    this.drafts.set(id, draft);
    if (cwd && selection.provider !== "codex") this.skills.prepare(cwd);
    if (this.workspaces.usesNativeProjects) {
      this.workspaces.updateNativeProjectMember(id, projectId);
    } else {
      if (cwd) this.workspaces.attachReferencedSession(id, cwd);
      this.workspaces.addDraftReference(id, cwd);
    }
    this.events.emit("api-session/added", await this.draftSummary(draft, false));
    return { sessionId: id, agentPreset: "standard" };
  }
  /** Materialize a source-neutral draft without reading or writing global defaults. */
  async prepareDraft(
    request: { sessionId: string; cwd?: string },
    configuration: DraftConfiguration,
  ): Promise<void> {
    await this.create({ request }, configuration);
    const draft = this.drafts.get(request.sessionId);
    if (
      !draft ||
      draft.creating ||
      draft.started ||
      draft.canonicalId ||
      draft.cwd !== request.cwd ||
      this.closed
    )
      throw new RpcError("session/busy", "Draft is already in use.");
    draft.selection = { ...configuration.selection };
    delete draft.permissionModeId;
    if (configuration.permissionModeId) draft.permissionModeId = configuration.permissionModeId;
  }

  private async commit(draft: Draft, prompt: string): Promise<string> {
    if (draft.canonicalId) return draft.canonicalId;
    if (!draft.creating) {
      const creating = this.startThread(draft, prompt);
      draft.creating = creating;
      // Only a failed project assignment reopens the draft: the retry reuses the started Thread.
      creating.catch(() => {
        if (draft.started && draft.creating === creating) delete draft.creating;
      });
    }
    // No automatic retry after creation failure: the Host may already have allocated an identity.
    return draft.creating;
  }

  private async startThread(draft: Draft, prompt: string): Promise<string> {
    if (!draft.started) {
      const plugin = (await this.catalog.list()).some(
        (item) => item.id === draft.selection.provider,
      );
      const result = await this.host.request<{ thread: ChThread }>("thread/start", {
        historyMode: "paginated",
        ...(draft.projectId ? { projectId: draft.projectId } : {}),
        ...(draft.cwd
          ? { cwd: draft.cwd }
          : { projectlessWorkspace: { prompt: prompt.slice(0, 16_384) } }),
        ...(plugin
          ? {
              model: encodeHarnessPluginRoute(
                harnessPluginRouteSchema.parse({
                  harnessId: draft.selection.provider,
                  model: harnessModelRefFromKey(draft.selection.model),
                  ...(draft.selection.reasoningEffort
                    ? { thinkingOptionId: draft.selection.reasoningEffort }
                    : {}),
                  ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
                }),
              ),
            }
          : {
              model: harnessModelRefFromKey(draft.selection.model),
              ...(draft.selection.reasoningEffort
                ? { config: { model_reasoning_effort: draft.selection.reasoningEffort } }
                : {}),
              ...(draft.permissionModeId ? { permissions: draft.permissionModeId } : {}),
            }),
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
      draft.started = { thread: result.thread, harnessId: owner.harnessId };
    }
    const { thread, harnessId } = draft.started;
    if (draft.projectId && thread.projectId !== draft.projectId) {
      const updated = await this.host.request<{ thread: ChThread }>("thread/metadata/update", {
        threadId: thread.id,
        projectId: draft.projectId,
      });
      if (updated.thread.projectId !== draft.projectId)
        throw new RpcError(
          "workspace/assignment-unconfirmed",
          "Codex did not confirm the conversation's project.",
        );
      thread.projectId = updated.thread.projectId;
      this.refreshingProjectAssignments?.set(thread.id, draft.projectId);
    }
    draft.canonicalId = thread.id;
    this.files?.bind(draft.id, thread.id);
    this.rows.set(thread.id, thread);
    this.threads.setHarness(thread.id, harnessId);
    this.workspaces.detachSession(draft.id);
    if (this.workspaces.usesNativeProjects) {
      this.workspaces.updateNativeProjectMember(thread.id, draft.projectId);
    } else if (draft.cwd) {
      this.workspaces.selectReferenceWorkspace(draft.cwd);
      this.workspaces.attachReferencedSession(thread.id, thread.cwd);
      this.workspaces.addDraftReference(thread.id, draft.cwd);
    } else {
      this.workspaces.addDraftReference(thread.id, undefined);
    }
    this.events.emit("api-session/added", await this.summary(thread));
    this.publishedCatalog?.set(thread.id, this.catalogKey(thread));
    this.events.emit("codexhost/session-bound", draft.id, thread.id);
    // Navigation reads the retained draft during binding; remove its row only afterward.
    // Keep the alias for in-flight requests, without deleting the native Thread.
    this.events.emit("api-session/removed", draft.id);
    return thread.id;
  }

  /**
   * Working directory of one Host-confirmed local Thread.
   *
   * Drafts and remote Threads have no local directory
   * here: file access reports them unavailable rather than inventing one.
   * @param sessionId - Session identity the browser addressed.
   * @returns the Host-recorded directory, or undefined when this Thread has none.
   */
  localWorkspaceRoot(sessionId: string): string | undefined {
    const id = this.id(sessionId);
    if (this.drafts.has(id)) return undefined;
    return this.rows.get(id)?.cwd ?? this.threads.view(id)?.thread.cwd;
  }

  /**
   * Resolve a Host-confirmed local Thread's working directory, loading its metadata
   * from the Host if this Web process has not listed it yet (e.g. headless Peer startup
   * or older catalog pages). Never creates a Thread and never resolves drafts.
   */
  async ensureLocalWorkspaceRoot(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    const existing = this.localWorkspaceRoot(sessionId);
    if (existing !== undefined) return existing;
    if (
      this.closed ||
      !sessionId ||
      sessionId.startsWith("web-remote:") ||
      sessionId.startsWith("remote-control:") ||
      sessionId.startsWith("draft-")
    ) {
      return undefined;
    }
    const id = this.id(sessionId);
    if (this.drafts.has(id)) return undefined;
    try {
      const { thread, harnessId } = await this.readThread(id);
      if (this.closed || signal?.aborted) return undefined;
      this.rows.set(thread.id, thread);
      this.threads.setHarness(thread.id, harnessId);
      return thread.cwd;
    } catch {
      return undefined;
    }
  }

  /**
   * Terminal cwd for a known local Session, including an unsubmitted draft.
   * Missing cwd uses the Web service user's home without assigning a workspace
   * or creating a Thread. Unknown identities do not acquire an execution scope.
   * @param sessionId - Session identity the browser addressed.
   * @returns the saved cwd or home directory, or undefined for an unknown Session.
   */
  terminalWorkspaceRoot(sessionId: string): string | undefined {
    const id = this.id(sessionId);
    const session = this.drafts.get(id) ?? this.rows.get(id);
    return session === undefined ? undefined : session.cwd || homedir();
  }

  /** Workspace files are also available before a draft creates its native Thread. */
  fileWorkspaceRoot(sessionId: string): string | undefined {
    const id = this.id(sessionId);
    return this.drafts.get(id)?.cwd ?? this.localWorkspaceRoot(id);
  }

  setRemoteFileSearch(search: RemoteFileReferencesSearch | undefined): void {
    this.fileReferences.setRemoteSearch(search);
  }

  uploadFile(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    name?: string,
    imageMediaType?: string,
    timing?: FileUploadTiming,
  ) {
    if (!this.fileInputs)
      throw new RpcError("session/attachment-invalid", "File uploads are unavailable.");
    return this.fileInputs.upload(id, chunks, name, imageMediaType, timing);
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
    if (draft.canonicalId || draft.creating || draft.started)
      throw new RpcError("session/busy", "A submitted Thread cannot change Session source.");
    this.drafts.delete(id);
  }

  private updateArchive(id: string, archived: boolean): void {
    this.refreshingArchiveChanges?.set(id, archived);
    const ids = new Set(this.workspaces.localArchivedSessionIds());
    if (archived) ids.add(id);
    else ids.delete(id);
    this.workspaces.setReferenceArchives([...ids].sort());
  }

  private async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const id = this.id(sessionId);
    const operation = Symbol();
    this.archiveOperations.set(id, operation);
    try {
      if (this.drafts.has(id))
        throw new RpcError(
          "session/not-started",
          "Send the first message before archiving this Thread.",
        );
      if (!this.threads.hasHarness(id)) {
        const { thread, harnessId } = await this.readThread(id);
        this.rows.set(id, thread);
        this.threads.setHarness(id, harnessId);
      }
      const owner = await this.owner(id);
      if (this.archiveOperations.get(id) !== operation) return;
      try {
        await this.host.request(archived ? "thread/archive" : "thread/unarchive", { threadId: id });
      } catch (error) {
        if (
          !archived ||
          owner.owner !== "codex" ||
          !(error instanceof RpcError) ||
          error.code !== "host/rejected" ||
          !("hostCode" in error.details) ||
          error.details.hostCode !== -32600 ||
          error.message !== `no rollout found for thread id ${id}`
        )
          throw error;
        // Drain older catalog merges before the final, native-only confirmation.
        await this.refreshing?.catch(() => undefined);
        if (this.archiveOperations.get(id) !== operation) throw error;
        const confirmation = await this.host
          .request(THREAD_ARCHIVE_CONFIRM_METHOD, { threadId: id })
          .then((value) => threadArchiveConfirmResultSchema.safeParse(value))
          .catch(() => undefined);
        if (
          !confirmation?.success ||
          !confirmation.data.confirmed ||
          this.archiveOperations.get(id) !== operation
        )
          throw error;
        this.updateArchive(id, true);
        return;
      }
      // A failed read cannot reject an acknowledged mutation. Newer operations
      // and realtime notifications, however, supersede this completion.
      await this.refreshing?.catch(() => undefined);
      if (this.archiveOperations.get(id) === operation) this.updateArchive(id, archived);
    } finally {
      if (this.archiveOperations.get(id) === operation) this.archiveOperations.delete(id);
    }
  }

  private async readThread(id: string) {
    const owner = await this.owner(id);
    const { thread } = await this.host.request<{ thread: ChThread & { archived?: boolean } }>(
      "thread/read",
      {
        threadId: id,
        includeTurns: false,
      },
    );
    if (thread.id !== id || (owner.owner === "external" && thread.modelProvider !== "codexhost"))
      throw new RpcError("session/ownership-unconfirmed", "Thread identity was not confirmed.");
    return { thread, harnessId: owner.harnessId };
  }

  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    this.fileReferences.register(rpc);
    this.fileInputs?.register(rpc);
    rpc.register("codexhost/turnDiffs", async (args) => {
      const parsed = webTurnDiffsRequestSchema.safeParse(requestOf(args));
      if (!parsed.success) throw new RpcError("session/diff-invalid", "Invalid Turn diff request.");
      const { sessionId, turn, path } = parsed.data;
      const id = this.id(sessionId);
      await this.owner(id);
      const view = this.threads.view(id) ?? (await this.view(id, true));
      return { diffs: view.turnDiffs(turn, path) };
    });
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
        const pinnedSessionIds = await this.pins.sync({ threadId: id, pinned });
        await this.refresh().catch(() => undefined);
        return { pinnedSessionIds };
      });
    }
    rpc.register("workspace/moveSessionToSection", async (args) => {
      const input = requestOf<{ sessionId: string; sectionId: string | null }>(args);
      const move = clientThreadSectionMoveSchema.safeParse({
        threadId: input.sessionId,
        sectionId: input.sectionId,
      });
      if (!move.success)
        throw new RpcError("workspace/section-invalid", "Invalid Thread section move.");
      const { threadId, sectionId } = move.data;
      if (
        this.threads.harnessId(threadId) !== "codex" ||
        this.rows.get(threadId)?.parentThreadId ||
        this.workspaces.isArchived(threadId) ||
        this.workspaces.pinnedSessionIds().includes(threadId) ||
        (sectionId !== null && !this.workspaces.hasThreadSection(sectionId))
      )
        throw new RpcError(
          "workspace/section-unavailable",
          "This Thread or section is unavailable for a move.",
        );
      await this.host.request("codexhost/thread/sections/move", move.data);
      await this.refreshing?.catch(() => undefined);
      await this.refresh().catch(() => undefined);
      return { sectionId };
    });
    rpc.register("session/list", async (args, context) => {
      const {
        includeArchived = false,
        cursor,
        sessionId,
        workspaceId,
      } = requestOf<{
        includeArchived?: boolean;
        cursor?: string;
        sessionId?: string;
        workspaceId?: string;
      }>(args);
      if (
        workspaceId !== undefined &&
        (typeof workspaceId !== "string" || !workspaceId || cursor === undefined)
      )
        throw new RpcError("session/list-invalid", "workspaceId only continues a cursor page.");
      if (sessionId !== undefined) {
        if (typeof sessionId !== "string" || !sessionId || cursor !== undefined)
          throw new RpcError("session/list-invalid", "Invalid direct-link identity.");
        const draft = this.drafts.get(sessionId);
        if (draft && !draft.canonicalId)
          return {
            items: [await this.draftSummary(draft, false)],
            archivedSessionIds: this.workspaces.archivedSessionIds(),
          };
        const id = this.id(sessionId);
        if (id.startsWith("draft-"))
          throw new RpcError("session/not-found", "Draft Session is no longer available.");
        await Promise.all([this.tree.refresh(), this.refreshPins()]);
        const { thread, harnessId } = await this.readThread(id);
        this.rows.set(thread.id, thread);
        this.threads.setHarness(thread.id, harnessId);
        const direct = new Map([[thread.id, thread]]);
        await this.tree.supplement(direct, async (ancestorId) => {
          const ancestor = await this.readThread(ancestorId);
          this.rows.set(ancestorId, ancestor.thread);
          this.threads.setHarness(ancestorId, ancestor.harnessId);
          if (ancestor.thread.archived === true) this.updateArchive(ancestorId, true);
          return ancestor.thread;
        });
        // Catalog/organization refreshes reconcile project grouping for these retained rows.
        return {
          items: await Promise.all([...direct.values()].map((row) => this.summary(row))),
          archivedSessionIds: this.workspaces.archivedSessionIds(),
        };
      }
      if (typeof includeArchived !== "boolean")
        throw new RpcError("session/list-invalid", "includeArchived must be a boolean.");
      const timing = context.sessionListTiming ?? new SessionListTiming();
      if (cursor !== undefined && typeof cursor !== "string")
        throw new RpcError("session/list-invalid", "cursor must be a string.");
      // Explicit pages are request-local and are never joined to another browser's refresh.
      // A Workspace's page reads on until it reaches one of that Workspace's Threads.
      const scope =
        workspaceId === undefined ? undefined : this.workspaces.catalogScope(workspaceId);
      if (workspaceId !== undefined && scope === undefined)
        return {
          items: [],
          archivedSessionIds: this.workspaces.archivedSessionIds(),
          nextCursor: null,
        };
      const page = await this.refresh(timing, includeArchived, cursor, scope);
      const pageIds = this.tree.withAncestors(page?.threads.map((row) => row.id) ?? []);
      const archivedSessionIds = this.workspaces.archivedSessionIds();
      const archived = new Set(archivedSessionIds);
      const items = await timing.measure("summaries", async () => [
        ...(await Promise.all(
          [...this.rows.values()]
            .filter((row) => pageIds.has(row.id) && (includeArchived || !archived.has(row.id)))
            .map((row) => this.summary(row)),
        )),
        ...(await Promise.all(
          [...this.drafts.values()]
            .filter((d) => !d.canonicalId)
            .map((d) => this.draftSummary(d, false)),
        )),
      ]);
      timing.count("resultRows", items.length);
      return {
        items,
        archivedSessionIds,
        nextCursor: page ? nextCatalogCursor(page, includeArchived) : null,
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
    rpc.register("session/handoff", async (args) => {
      const request = requestOf<{
        sessionId: string;
        atSeq?: number;
        targetHarnessId: string;
        targetModel?: string;
        targetThinkingOptionId?: string;
      }>(args);
      if (
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        typeof request.targetHarnessId !== "string" ||
        !request.targetHarnessId.trim() ||
        (request.atSeq !== undefined &&
          (!Number.isSafeInteger(request.atSeq) || request.atSeq < 0)) ||
        (request.targetModel !== undefined &&
          (typeof request.targetModel !== "string" || !request.targetModel.trim())) ||
        (request.targetThinkingOptionId !== undefined &&
          (typeof request.targetThinkingOptionId !== "string" ||
            !request.targetThinkingOptionId.trim()))
      )
        throw new RpcError("session/handoff-invalid", "Invalid handoff request.");
      const id = this.id(request.sessionId);
      if (this.drafts.has(id))
        return handoffUnavailable(id, "Send a message before handing off this session.");
      const displayed = this.threads.view(id);
      if (request.atSeq !== undefined && !displayed)
        return handoffUnavailable(id, "Handoff history expired. Reopen the conversation.");
      const view = await this.view(id);
      if (request.atSeq !== undefined && view !== displayed)
        return handoffUnavailable(id, "Handoff history changed. Reopen the conversation.");
      const result = await handoffChThread(this.host, view, {
        ...(request.atSeq !== undefined ? { atSeq: request.atSeq } : {}),
        targetHarnessId: request.targetHarnessId,
        ...(request.targetModel !== undefined ? { targetModel: request.targetModel } : {}),
        ...(request.targetThinkingOptionId !== undefined
          ? { targetThinkingOptionId: request.targetThinkingOptionId }
          : {}),
      });
      this.handoffs.set(result.sessionId, result.handoff);
      // A failed catalog read must not turn a confirmed handoff into a rejected write.
      await this.refresh().catch(() => undefined);
      return result;
    });
    rpc.register("session/modelCatalog", (args) => {
      const request = requestOf<{ refresh?: true; harnessId?: string } | undefined>(args);
      return this.catalog.models(request?.refresh === true, request?.harnessId);
    });
    rpc.register("session/selectModel", async (args) => {
      const request = requestOf<ModelSelection & { sessionId: string }>(args);
      const model = harnessModelRefFromKey(request.model);
      const draft = this.drafts.get(request.sessionId);
      if (draft && !draft.canonicalId) {
        if (draft.creating || draft.started)
          throw new RpcError("session/busy", "Draft creation is in progress.");
        const before = draft.selection;
        if (before.provider !== request.provider) {
          const config = await this.preferences
            ?.configuration(request.provider)
            .catch(() => undefined);
          const inspection = await this.catalog.inspect(request.provider, draft.cwd);
          if (draft.creating || draft.started || draft.selection !== before)
            throw new RpcError("session/busy", "Draft selection changed.");
          const permissionModeId = draftPermissionMode(
            request.provider,
            inspection,
            config?.permissionModeId,
          );
          delete draft.permissionModeId;
          if (permissionModeId) draft.permissionModeId = permissionModeId;
        }
        draft.selection = request;
        await this.preferences
          ?.remember(request.provider, {
            model,
            thinkingOptionId: request.reasoningEffort,
            permissionModeId: draft.permissionModeId,
          })
          .catch(() =>
            this.events.emit(
              "codexhost/preferences-error",
              "New session defaults could not be saved.",
            ),
          );
        this.events.emit("api-session/added", await this.draftSummary(draft, false));
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
      const id = this.id(request.sessionId);
      const hostEpoch = this.hostEpoch;
      const publish = (value: unknown) => {
        const configuration = harnessModelSelectionStateSchema.parse(value);
        if (!configuration.effectiveModel)
          throw new RpcError("session/model-unavailable", "Host did not confirm the Model.");
        if (this.closed || this.hostEpoch !== hostEpoch) return configuration;
        const state = this.threads.ensure(id);
        // Reads started before this acknowledgement cannot replace its confirmed state.
        state.configurationRevision = (state.configurationRevision ?? 0) + 1;
        const selection = {
          provider: owner.harnessId,
          model: harnessModelRefKey(configuration.effectiveModel),
          ...(configuration.effectiveThinkingOptionId
            ? { reasoningEffort: configuration.effectiveThinkingOptionId }
            : {}),
        };
        state.view?.log.setProjection("modelSelection", { lastUsed: selection, next: selection });
        return configuration;
      };
      // Unchanged native settings may not emit a confirmation notification.
      const configuration = publish(
        owner.owner === "codex" && sameHarnessModelRef(owner.effectiveModel, model)
          ? {
              effectiveModel: owner.effectiveModel,
              effectiveThinkingOptionId: owner.effectiveThinkingOptionId,
            }
          : await this.host.request("codexhost/thread/model/select", {
              threadId: id,
              model,
            }),
      );
      if (
        request.reasoningEffort &&
        request.reasoningEffort !== configuration.effectiveThinkingOptionId
      )
        publish({
          ...configuration,
          ...harnessModelSelectionStateSchema.parse(
            await this.host.request("codexhost/thread/thinking/select", {
              threadId: id,
              thinkingOptionId: request.reasoningEffort,
            }),
          ),
        });
      return {};
    });
    rpc.register("session/prompt", async (args) => {
      const request = requestOf<{
        sessionId: string;
        requestId?: string;
        content: Array<{ type: string; text?: string }>;
        mode?: string;
        expectedTurnId?: string | null;
      }>(args);
      if (!this.images && request.content.some((part) => part.type !== "text"))
        throw new RpcError(
          "session/attachment-invalid",
          "Shared CH input currently accepts text only.",
        );
      const draft = this.drafts.get(request.sessionId);
      const existingOwner =
        !draft || draft.canonicalId ? await this.owner(request.sessionId) : undefined;
      let steerTurnId: string | undefined;
      if (request.mode === "steer") {
        const view = existingOwner && (await this.view(request.sessionId, true));
        const activeTurnId = view ? view.log.projections[WEB_ACTIVE_TURN_PROJECTION] : null;
        if (
          !existingOwner ||
          !view ||
          typeof activeTurnId !== "string" ||
          (request.expectedTurnId !== undefined && request.expectedTurnId !== activeTurnId)
        )
          throw new RpcError("remote/turn-changed", "The selected Turn has ended or changed.");
        if (
          existingOwner.owner === "external" &&
          view.thread[THREAD_STEER_STRICT_TARGET_FIELD] !== true
        )
          throw new RpcError(
            "remote/steer-unavailable",
            "This Host does not support steering with a confirmed Turn target.",
          );
        steerTurnId = activeTurnId;
      }
      // Validate/save before creating a native Thread. Only native path context crosses the Host channel.
      const prepared = this.fileInputs
        ? await this.fileInputs.prepare(this.id(request.sessionId), request.content)
        : {
            input: this.images?.prepare(request.content) ?? request.content,
            presentation: this.images?.presentation(request.content) ?? request.content,
          };
      const { input: preparedInput, presentation } = prepared;
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
      const owner = existingOwner ?? (await this.owner(threadId));
      if (steerTurnId) {
        await this.host.request("turn/steer", {
          threadId,
          expectedTurnId: steerTurnId,
          input,
          ...(owner.owner === "external" ? { [THREAD_STEER_STRICT_TARGET_PARAM]: true } : {}),
          ...(request.requestId ? { clientUserMessageId: request.requestId } : {}),
        });
      } else {
        await this.host.request("turn/start", {
          threadId,
          input,
          ...(request.mode === "queue"
            ? { delivery: "queue", presentationInput: presentation }
            : {}),
          ...(request.requestId ? { clientUserMessageId: request.requestId } : {}),
        });
      }
      if (draft && !draft.titleRequested) {
        draft.titleRequested = true;
        const row = this.rows.get(threadId);
        if (row) {
          this.titleRequests.add(threadId);
          const prompt = request.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
          void tryGenerateThreadTitle(
            this.host,
            row,
            prompt,
            owner.owner === "external",
            () => !this.closed && this.titleRequests.has(threadId),
          )
            .then(async (changed) => {
              if (changed && !this.closed) await this.refresh();
            })
            .catch(() => undefined)
            .finally(() => this.titleRequests.delete(threadId));
        }
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
    rpc.register("session/toolOutput", async (args) => {
      const parsed = webToolOutputReferenceSchema.safeParse(requestOf(args));
      if (!parsed.success) throw new RpcError("gateway/invalid", "Invalid tool output reference.");
      const ref = parsed.data;
      await this.owner(ref.sessionId);
      const view = await this.view(ref.sessionId, true);
      return readToolOutput(view.log, ref);
    });
    rpc.register("session/attachment", async (args) => {
      const { sessionId, attachmentId } = requestOf<{ sessionId: string; attachmentId: string }>(
        args,
      );
      const view = await this.view(sessionId, true);
      if (!this.attachments)
        throw new RpcError("session/attachment-not-found", "Image previews are unavailable.");
      return this.attachments.read(
        view,
        attachmentId,
        view.ownerSnapshot?.queue?.items.map((item) => item.input),
      );
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
      if (this.drafts.has(threadId))
        throw new RpcError("session/queue-item-not-found", "Queued message is no longer pending.");
      return this.runQueuedOperation(threadId, async () => {
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
    });
    rpc.register("codexhost/editQueueItem", async (args) => {
      const request = requestOf<{ sessionId?: unknown; itemId?: unknown; revision?: unknown }>(
        args,
      );
      if (
        typeof request.sessionId !== "string" ||
        !request.sessionId ||
        typeof request.itemId !== "string" ||
        !request.itemId ||
        typeof request.revision !== "string" ||
        !request.revision
      )
        throw new RpcError("session/queue-edit-invalid", "Invalid queued message edit request.");
      const threadId = this.id(request.sessionId);
      if (this.drafts.has(threadId))
        throw new RpcError("session/queue-item-not-found", "Queued message is no longer pending.");
      const itemId = request.itemId;
      const revision = request.revision;
      return this.runQueuedOperation(threadId, async () => {
        if (this.closed) throw new RpcError("host/offline", "The Web connection is closed.");
        await this.owner(threadId);
        if (!this.rows.has(threadId) && !this.threads.view(threadId)) await this.refresh();
        const row = this.rows.get(threadId) ?? this.threads.view(threadId)?.thread;
        if (!row)
          throw new RpcError(
            "session/not-found",
            "Open this Thread before editing its queued messages.",
          );
        if (row.canAcceptDirectInput === false)
          throw new RpcError("session/queue-edit-unsupported", "This Thread is read-only.");
        const allowsAttachments = Boolean(
          this.fileInputs && !row.parentThreadId && !this.attachmentThreadError(threadId),
        );
        return takeQueuedItemForEdit({
          host: this.host,
          threadId,
          itemId,
          revision,
          allowsAttachments,
          ...(this.fileInputs ? { fileInputs: this.fileInputs } : {}),
          refreshView: async () => {
            await this.view(threadId, true);
          },
          invalidateView: () => {
            this.realtime?.invalidate(threadId);
          },
        });
      });
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
      this.titleRequests.delete(this.id(request.sessionId));
      await this.owner(request.sessionId);
      await this.host.request("thread/name/set", {
        threadId: this.id(request.sessionId),
        name: request.title,
      });
      const view = await this.view(request.sessionId);
      return { title: request.title, seq: view.log.lastSeq };
    });
    rpc.register("session/search", async (args) => {
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
    rpc.register("session/page", async (args, context) => {
      const req = requestOf<{
        address: { sessionId: string };
        throughSeq: number;
        beforeSeq?: number;
        maxMessages?: number;
      }>(args);
      const view =
        this.threads.view(this.id(req.address.sessionId)) ??
        (await this.view(req.address.sessionId, true));
      const page = await this.threads.trackPageRead(view.thread.id, view, () =>
        view.olderPage(req.throughSeq, req.beforeSeq, req.maxMessages),
      );
      return context.relay
        ? {
            ...page,
            records: toolOutputRecords(
              view.log,
              page.records as Array<{ type: "event"; event: WireEvent }>,
            ),
          }
        : page;
    });
    rpc.register("session/workspacePathApplications", () => ({ applications: [] }));
    rpc.register("session/openWorkspacePath", async (args, context) => {
      if (context.relay)
        throw new RpcError(
          "session/open-unavailable",
          "Remote connections cannot open Host files.",
        );
      const request = requestOf<{
        sessionId?: string;
        path: string;
        action?: string;
        application?: string;
      }>(args);
      if (
        typeof request.sessionId !== "string" ||
        request.sessionId.length === 0 ||
        request.sessionId.startsWith("web-remote:") ||
        request.sessionId.startsWith("remote-control:")
      ) {
        throw new RpcError(
          "session/open-unavailable",
          "Opening Host files requires a local session.",
        );
      }
      if (this.fileWorkspaceRoot(request.sessionId) === undefined) {
        throw new RpcError(
          "session/open-unavailable",
          "Opening Host files requires a known local session.",
        );
      }
      if (
        (request.action !== undefined && request.action !== "reveal") ||
        request.application !== undefined
      )
        throw new RpcError(
          "session/open-unavailable",
          "Only the system default application is supported.",
        );
      if (!this.openFile)
        throw new RpcError("session/open-unavailable", "The native launcher is unavailable.");
      return this.openFile(request.path, request.action);
    });
    for (const [method, archived] of [
      ["workspace/archiveSession", true],
      ["workspace/unarchiveSession", false],
      ["session/archive", true],
      ["session/unarchive", false],
    ] as const)
      rpc.register(method, async (args) => {
        const { sessionId, scope } = requestOf<{ sessionId: string; scope?: "single" }>(args);
        const id = this.id(sessionId);
        if (scope !== undefined && scope !== "single")
          throw new RpcError("session/archive-invalid", "Invalid archive scope.");
        this.archiveOperations.delete(id);
        try {
          if (scope === "single") {
            await this.setArchived(id, archived);
            if (this.workspaces.localArchivedSessionIds().includes(id) !== archived)
              throw new RpcError(
                "session/archive-unconfirmed",
                "The requested archive state was not confirmed.",
              );
          } else {
            await this.tree.archive(
              id,
              archived,
              new Set(this.workspaces.localArchivedSessionIds()),
              (member) => this.setArchived(member, archived),
            );
          }
        } finally {
          await this.refresh().catch(() => undefined);
        }
        return method.startsWith("workspace/")
          ? { archivedSessionIds: this.workspaces.archivedSessionIds() }
          : {};
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
      for (const [id, view] of this.threads.views()) {
        const baseline = view.log.projectionBaseline();
        projections[id] = {
          ...baseline,
          values: globalProjectionValues(baseline.values),
        };
      }
      this.controls.add(sink);
      sink.onClose(() => this.controls.delete(sink));
      sink.push({ type: "baseline", value: { projections } });
      // Dropped views stay out of `baseline` so `ProjectionStore.seed` does not
      // clear non-catalog global projections; replay current catalog values as
      // live frames above the retired sequence watermark instead.
      for (const id of this.threads.droppedViewIds()) {
        if (sink.closed) break;
        const row = this.rows.get(id);
        const seq = row ? this.threads.reserveDroppedProjectionSeq(id) : undefined;
        if (!row || seq === undefined) continue;
        for (const [key, value] of Object.entries(this.catalogProjections(row)))
          sink.push({ type: "projection", sessionId: id, key, value, seq });
      }
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
      view.log.follow(toolOutputSink(view.log, sink), request);
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
            return undefined;
          })
          .finally(() => {
            this.refreshing = undefined;
          });
        void this.refreshing.catch(() => undefined);
      }
    }, 10000);
    this.timer.unref();
    this.idleViewTimer = setInterval(() => {
      this.threads.discardIdleViews(
        Date.now(),
        (id) => this.rows.get(id)?.status.type === "active",
      );
    }, 60_000);
    this.idleViewTimer.unref();
  }

  registerCommands(rpc: RpcRegistry): void {
    this.skills.register(rpc);
    const native = new ChHarnessCommands(this.host, async (sessionId) => {
      const id = this.id(sessionId);
      if (
        typeof sessionId !== "string" ||
        !sessionId ||
        (this.drafts.has(sessionId) && !this.drafts.get(sessionId)?.canonicalId)
      )
        throw new RpcError("command/unavailable", "Commands require an existing Thread.");
      if (this.closed || !this.hostOnline)
        throw new RpcError("host/offline", "The Host is disconnected.");
      await this.owner(id);
      const { thread } = await this.host.request<{ thread: ChThread }>("thread/read", {
        threadId: id,
        includeTurns: false,
      });
      if (thread.id !== id || thread.parentThreadId || thread.canAcceptDirectInput === false)
        throw new RpcError("command/unavailable", "Commands require an editable local Thread.");
      return thread;
    });
    rpc.register("codexhost/threadCommands", (args) => {
      const { sessionId } = requestOf<{ sessionId: string }>(args);
      const draft = this.drafts.get(sessionId);
      // Only official Codex lists a draft's Skills; other Harnesses use the Skill Library.
      if (draft && !draft.canonicalId && draft.selection.provider === "codex") {
        if (this.closed || !this.hostOnline)
          throw new RpcError("host/offline", "The Host is disconnected.");
        return native.inspectDraft("codex", draft.cwd);
      }
      return native.inspect(sessionId);
    });
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
        if (draft.creating || draft.started || draft.selection.provider !== harnessId)
          throw new RpcError("session/busy", "Draft selection changed.");
        draft.permissionModeId = modeId;
        await this.preferences
          ?.remember(harnessId, {
            model: harnessModelRefFromKey(draft.selection.model),
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
    this.catalog.close();
    this.fileReferences.close();
    this.skills.close();
    this.closed = true;
    this.archiveOperations.clear();
    this.queueOperations.clear();
    this.titleRequests.clear();
    this.pins.close();
    this.realtime?.close();
    this.interactions?.clear();
    clearInterval(this.timer);
    clearInterval(this.idleViewTimer);
    this.host.close();
    for (const sink of this.controls) sink.end();
  }
}
