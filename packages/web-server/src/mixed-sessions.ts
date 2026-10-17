/** Web composition only: external CH Threads and isolated Codex Sessions never share executors. */
import { readFileSync } from "node:fs";
import type { ChSessions } from "./ch-sessions.ts";
import type { ModelSelection } from "./ch-harness-catalog.ts";
import type { HarnessRegistry, Inspection, HarnessManifest } from "./harnesses.ts";
import { MixedDrafts, type MixedDraft } from "./mixed-drafts.ts";
import { SourceEndpoints, mergeSessionControls } from "./session-source-endpoints.ts";
import type { RemoteCodexSessions } from "./remote-codex-sessions.ts";
import type { Sessions, SessionNotification } from "./sessions.ts";
import { requestOf } from "./store.ts";
import {
  RpcError,
  type EventHub,
  type RpcRegistry,
  type StreamRegistry,
  type StreamSink,
} from "./transport.ts";
import type { Workspaces } from "./workspaces.ts";
import { contentTypeOf } from "./web-assets.ts";
import { withHarnessDisplayOrder } from "./harness-display-order.ts";
import type { WebHarnessPreferences } from "./harness-preferences.ts";

type Source = "shared" | "local";
type Catalog = Awaited<ReturnType<HarnessRegistry["modelCatalog"]>>;
type Row = { sessionId: string; updatedAt?: number };

function addressedSession(args: Record<string, unknown>): string | undefined {
  const request = requestOf<Record<string, unknown>>(args);
  const address = request.address as { sessionId?: string; childSessionId?: string } | undefined;
  const id =
    request.sessionId ??
    request.agentId ??
    args.agentId ??
    address?.sessionId ??
    address?.childSessionId;
  return typeof id === "string" ? id : undefined;
}

export class MixedSessions {
  private readonly sources = { shared: new SourceEndpoints(), local: new SourceEndpoints() };
  private readonly workspace = new SourceEndpoints();
  private readonly drafts: MixedDrafts;
  private readonly preparedSharedDrafts = new Set<string>();
  private preferred: ModelSelection | undefined;
  private registered = false;
  private closed = false;
  private readonly catalogFailures = new Map<Source, unknown>();
  private readonly receipts = new Map<
    string,
    { signature: string; promise: Promise<unknown>; settled: boolean }
  >();

  readonly catalog = {
    preferences: undefined as WebHarnessPreferences | undefined,
    models: () => this.models(),
    list: async (): Promise<Array<Omit<HarnessManifest, "entry">>> => [
      ...(await this.shared.catalog.list()),
      ...this.localHarnesses.ids().flatMap((id) => {
        const value = this.localHarnesses.manifest(id);
        return value ? [value] : [];
      }),
    ],
    inspect: (id: string, cwd?: string): Promise<Inspection> =>
      id === "codex"
        ? this.localHarnesses.inspect(id)
        : (this.shared.catalog.inspect(id, cwd) as Promise<Inspection>),
    name: async (id: string) =>
      id === "codex"
        ? (this.localHarnesses.manifest(id)?.name ?? "Codex")
        : this.shared.catalog.name(id),
    icon: async (id: string) => {
      if (id !== "codex") return this.shared.catalog.icon(id);
      const path = this.localHarnesses.iconPath(id);
      return path ? { body: readFileSync(path), contentType: contentTypeOf(path) } : undefined;
    },
  };

  constructor(
    private readonly shared: ChSessions,
    private readonly local:
      | Pick<
          Sessions,
          | "register"
          | "registerCommands"
          | "registerImport"
          | "owns"
          | "ids"
          | "prepareDraft"
          | "close"
          | "notifier"
        >
      | RemoteCodexSessions,
    private readonly localHarnesses: Pick<
      HarnessRegistry,
      "ids" | "manifest" | "iconPath" | "inspect" | "modelCatalog" | "close"
    >,
    private readonly workspaces: Workspaces,
    private readonly events: EventHub,
  ) {
    this.catalog.preferences = shared.catalog.preferences;
    this.drafts = new MixedDrafts(this.catalog, workspaces, events, (draft) =>
      draft.selection.provider === "codex" ? {} : shared.draftInputCapabilities(),
    );
    for (const [source, sessions] of [
      [this.sources.shared, shared],
      [this.sources.local, local],
    ] as const) {
      sessions.register(source.rpc, source.streams);
      sessions.registerCommands(source.rpc);
      sessions.registerImport(source.rpc);
    }
    workspaces.register(this.workspace.rpc, this.workspace.streams);
    this.syncLocalIds();
  }

  set notifier(value: ((notification: SessionNotification) => void) | undefined) {
    this.shared.notifier = value;
    this.local.notifier = value;
  }

  private syncLocalIds() {
    this.workspaces.setLocalSessionIds(this.local.ids());
  }
  private source(id: string): Source {
    return this.local.owns(id) ? "local" : "shared";
  }

  private async models(): Promise<Catalog> {
    const values = await Promise.allSettled([
      this.shared.catalog.models(),
      this.localHarnesses.modelCatalog(),
    ]);
    const catalogs: Catalog[] = [];
    for (const [index, value] of values.entries()) {
      const source = index === 0 ? "shared" : "local";
      if (value.status === "fulfilled") {
        catalogs.push(value.value);
        this.catalogFailures.delete(source);
      } else this.catalogFailures.set(source, value.reason);
    }
    const groups = catalogs.flatMap((c) => c.groups);
    const defaultSelection =
      this.preferred &&
      groups.some(
        (g) =>
          g.id === this.preferred?.provider && g.models.some((m) => m.id === this.preferred?.model),
      )
        ? this.preferred
        : catalogs.find((c) => c.groups.length)?.default;
    if (!defaultSelection) throw new RpcError("host/no-harness", "No ready Harness is available.");
    const catalog = withHarnessDisplayOrder(
      {
        default: defaultSelection,
        groups,
        routableProviders: groups.map((g) => g.id),
        failures: [
          ...catalogs.flatMap((c) => c.failures),
          ...[...this.catalogFailures].map(([id, error]) => ({
            id,
            name: id === "shared" ? "CH" : "Codex",
            message: error instanceof Error ? error.message : String(error),
          })),
        ],
      },
      await this.shared.catalog.displayEntries(),
    );
    return this.shared.catalog.preferences
      ? this.shared.catalog.preferences.decorate(catalog)
      : catalog;
  }

  private async rows(): Promise<{ items: Row[] }> {
    const [shared, local] = await Promise.all([
      this.sources.shared.rpc.invoke("session/list", {}) as Promise<{ items: Row[] }>,
      this.sources.local.rpc.invoke("session/list", {}) as Promise<{ items: Row[] }>,
    ]);
    this.syncLocalIds();
    const rows = [...shared.items, ...local.items].filter(
      (row) => !this.drafts.entries.has(row.sessionId),
    );
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.sessionId))
        throw new RpcError(
          "session/identity-conflict",
          "Session sources returned the same identity.",
        );
      ids.add(row.sessionId);
    }
    const drafts = await Promise.all(
      [...this.drafts.entries.values()].map((d) => this.drafts.summary(d)),
    );
    return { items: [...rows, ...drafts].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) };
  }

  private readonly sharedPreparations = new Map<string, Promise<void>>();

  private prepareShared(draft: MixedDraft): Promise<void> {
    const previous = this.sharedPreparations.get(draft.id) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        if (
          this.closed ||
          draft.selection.provider === "codex" ||
          !this.drafts.entries.has(draft.id)
        )
          throw new RpcError("session/busy", "Draft source changed.");
        await this.shared.prepareDraft(
          { sessionId: draft.id, ...(draft.cwd ? { cwd: draft.cwd } : {}) },
          {
            selection: { ...draft.selection },
            ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
          },
        );
        this.preparedSharedDrafts.add(draft.id);
      });
    this.sharedPreparations.set(draft.id, work);
    void work
      .finally(() => {
        if (this.sharedPreparations.get(draft.id) === work)
          this.sharedPreparations.delete(draft.id);
      })
      .catch(() => {});
    return work;
  }

  private submit(draft: MixedDraft, args: Record<string, unknown>): Promise<unknown> {
    if (draft.submitting)
      throw new RpcError(
        "session/busy",
        "Submission already started; its outcome must be reconciled before retrying.",
      );
    const source = draft.selection.provider === "codex" ? "local" : "shared";
    const request = requestOf<{ content?: Array<{ type: string }> }>(args);
    if (source === "local" && !draft.cwd)
      throw new RpcError("workspace/invalid-path", "Choose a workspace before sending to Codex.");
    if (source === "local" && request.content?.some((part) => part.type !== "text"))
      throw new RpcError(
        "session/attachment-invalid",
        "Codex Web currently accepts text input only.",
      );
    draft.submitting = (async () => {
      const endpoint = this.sources[source].rpc;
      if (source === "shared") await this.prepareShared(draft);
      else {
        await this.sharedPreparations.get(draft.id)?.catch(() => {});
        if (this.preparedSharedDrafts.has(draft.id)) {
          this.shared.discardUnsubmittedDraft(draft.id);
          this.preparedSharedDrafts.delete(draft.id);
        }
        await this.local.prepareDraft(
          { sessionId: draft.id, ...(draft.cwd ? { cwd: draft.cwd } : {}) },
          {
            selection: { ...draft.selection },
            ...(draft.permissionModeId ? { permissionModeId: draft.permissionModeId } : {}),
          },
        );
        this.syncLocalIds();
      }
      if (draft.title)
        await endpoint.invoke("session/rename", {
          request: { sessionId: draft.id, title: draft.title },
        });
      if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
      const result = await endpoint.invoke("session/prompt", args);
      this.drafts.bound(draft.id);
      return result;
    })();
    return draft.submitting;
  }

  private async invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    const request = requestOf<Record<string, unknown>>(args);
    const id = addressedSession(args);
    const draft = id ? this.drafts.entries.get(id) : undefined;
    if (method === "session/modelCatalog") return this.models();
    if (method === "session/list") return this.rows();
    if (method === "session/create") {
      if (
        typeof request.sessionId === "string" &&
        !draft &&
        (await this.rows()).items.some((r) => r.sessionId === request.sessionId)
      )
        throw new RpcError("session/busy", "This Session already exists.");
      return this.drafts.create(request);
    }
    if (method === "session/search") {
      const query = String(request.query ?? "").toLowerCase();
      const values = await Promise.all(
        Object.values(this.sources).map(
          (s) => s.rpc.invoke(method, args) as Promise<{ items: unknown[]; hasMore: boolean }>,
        ),
      );
      const items = values.flatMap((v) => v.items);
      for (const draft of this.drafts.entries.values())
        if (draft.title?.toLowerCase().includes(query))
          items.push({ sessionId: draft.id, snippet: draft.title });
      return {
        items: items.slice(0, 20),
        hasMore: items.length > 20 || values.some((v) => v.hasMore),
      };
    }
    if (method === "codexhost/importSources") {
      const values = await Promise.all(
        Object.values(this.sources).map((s) => s.rpc.invoke(method, {})),
      );
      return {
        sources: values.flatMap((v) =>
          Array.isArray(v) ? v : (v as { sources: unknown[] }).sources,
        ),
      };
    }
    if (method === "codexhost/importCandidates" || method === "codexhost/import") {
      const value = await this.sources[
        request.harnessId === "codex" ? "local" : "shared"
      ].rpc.invoke(method, args);
      this.syncLocalIds();
      return value;
    }
    if (draft) {
      switch (method) {
        case "session/selectModel":
          await this.drafts.select(draft, request as unknown as ModelSelection);
          this.preferred = draft.selection;
          await this.shared.catalog.preferences
            ?.remember(draft.selection.provider, {
              model: { id: draft.selection.model },
              thinkingOptionId: draft.selection.reasoningEffort,
              permissionModeId: draft.permissionModeId,
            })
            .catch(() =>
              this.events.emit(
                "codexhost/preferences-error",
                "New session defaults could not be saved.",
              ),
            );
          return { selected: draft.selection };
        case "session/prompt":
          return this.submit(draft, args);
        case "session/projections":
          return (await this.drafts.summary(draft)).projections;
        case "session/page":
          return { records: [], hasMore: false };
        case "session/rename":
          return this.drafts.rename(draft, String(request.title ?? ""));
        case "commands/execute": {
          const response = await this.drafts.permission(draft, String(args.line ?? ""));
          await this.shared.catalog.preferences
            ?.remember(draft.selection.provider, {
              model: { id: draft.selection.model },
              thinkingOptionId: draft.selection.reasoningEffort,
              permissionModeId: draft.permissionModeId,
            })
            .catch(() =>
              this.events.emit(
                "codexhost/preferences-error",
                "New session defaults could not be saved.",
              ),
            );
          return response;
        }
        case "commands/list":
          return this.sources.shared.rpc.invoke(method, args);
        case "permissionPresets/catalog":
          return { options: [], defaultOptions: [], defaultPreset: "" };
        case "fileUploads/upload":
          if (draft.selection.provider === "codex") break;
          await this.prepareShared(draft);
          return this.sources.shared.rpc.invoke(method, args);
      }
      if (method.startsWith("fileUploads/") || method === "session/attachment")
        throw new RpcError("session/attachment-invalid", "Codex Web file uploads are not enabled.");
      throw new RpcError(
        "session/not-started",
        "Send the first message before using this operation.",
      );
    }
    if (
      method === "session/selectModel" &&
      id &&
      (request.provider === "codex") !== (this.source(id) === "local")
    )
      throw new RpcError(
        "session/model-unavailable",
        "Start a new conversation to change Harness.",
      );
    if (id && this.source(id) === "local") {
      if (method.startsWith("workspace/")) return this.workspace.rpc.invoke(method, args);
      if (method === "session/archive" || method === "session/unarchive")
        return this.workspace.rpc.invoke(
          method === "session/archive" ? "workspace/archiveSession" : "workspace/unarchiveSession",
          args,
        );
      if (!this.sources.local.rpc.has(method))
        throw new RpcError("session/unsupported", "This operation is unavailable for Codex Web.");
      return this.sources.local.rpc.invoke(method, args);
    }
    const value = await this.sources.shared.rpc.invoke(method, args);
    return method === "workspace/pinSession" || method === "workspace/unpinSession"
      ? { pinnedSessionIds: this.workspaces.pinnedSessionIds() }
      : value;
  }

  /** Bounded in-process receipts; never replay a possibly accepted first submission. */
  private prompt(args: Record<string, unknown>): Promise<unknown> {
    const request = requestOf<Record<string, unknown>>(args);
    if (
      typeof request.sessionId !== "string" ||
      typeof request.requestId !== "string" ||
      !request.requestId
    )
      throw new RpcError("session/invalid-request", "A session and request identity are required.");
    const key = JSON.stringify([request.sessionId, request.requestId]);
    const signature = JSON.stringify(request);
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.signature !== signature)
        throw new RpcError(
          "session/request-conflict",
          "This request identity already carries another input.",
        );
      return previous.promise;
    }
    if (this.receipts.size >= 256) {
      const retired = [...this.receipts].find(([, value]) => value.settled)?.[0];
      if (!retired) throw new RpcError("session/busy", "Too many pending submissions.");
      this.receipts.delete(retired);
    }
    const promise = this.invoke("session/prompt", args);
    const receipt = { signature, promise, settled: false };
    this.receipts.set(key, receipt);
    void promise.then(
      () => {
        receipt.settled = true;
      },
      (error) => {
        receipt.settled = true;
        if (
          error instanceof RpcError &&
          ["workspace/invalid-path", "session/attachment-invalid"].includes(error.code)
        )
          this.receipts.delete(key);
      },
    );
    return promise;
  }

  register(rpc: RpcRegistry, streams: StreamRegistry) {
    if (this.registered) return;
    this.registered = true;
    const methods = new Set([
      ...this.sources.shared.rpc.names(),
      ...this.sources.local.rpc.names(),
    ]);
    for (const method of methods)
      rpc.register(method, (args) =>
        method === "session/prompt" ? this.prompt(args) : this.invoke(method, args),
      );
    for (const method of new Set([
      ...this.sources.shared.streams.names(),
      ...this.sources.local.streams.names(),
    ])) {
      if (method === "session/control") {
        streams.register(method, (_args, sink) =>
          mergeSessionControls(
            [
              ...(["shared", "local"] as const).map((source) => ({
                open: (child: StreamSink) => this.sources[source].streams.open(method, {}, child),
                accepts: (id: string) => !this.drafts.entries.has(id) && this.source(id) === source,
              })),
              {
                open: (child) => this.drafts.control(child),
                accepts: (id: string) => this.drafts.entries.has(id),
              },
            ],
            sink,
          ),
        );
      } else
        streams.register(method, async (args, sink) => {
          const id = addressedSession(args);
          if (!id) throw new RpcError("session/not-found", "Session identity is required.");
          const draft = this.drafts.entries.get(id);
          if (draft) return this.drafts.follow(draft, sink);
          return this.sources[this.source(id)].streams.open(method, args, sink);
        });
    }
  }
  registerCommands(rpc: RpcRegistry) {
    void rpc;
    /* Registered with the source dispatch table. */
  }
  registerImport(rpc: RpcRegistry) {
    void rpc;
    /* Registered with the source dispatch table. */
  }

  async uploadFile(id: string, chunks: AsyncIterable<Uint8Array>, name?: string) {
    const draft = this.drafts.entries.get(id);
    if (draft?.submitting) throw new RpcError("session/busy", "Draft submission is in progress.");
    if (this.local.owns(id) || draft?.selection.provider === "codex")
      throw new RpcError("session/attachment-invalid", "Codex Web file uploads are not enabled.");
    if (draft) await this.prepareShared(draft);
    return this.shared.uploadFile(id, chunks, name);
  }
  async importRecent(limit: number): Promise<number> {
    void limit;
    throw new RpcError("host/import-explicit", "Imports must be explicitly selected.");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.drafts.close();
    await Promise.all([this.shared.close(), this.local.close(), this.localHarnesses.close()]);
  }
}
