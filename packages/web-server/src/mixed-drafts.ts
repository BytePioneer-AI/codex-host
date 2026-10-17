/** Source-neutral Web drafts. No native Session exists until the first submission. */
import { draftPermissionMode } from "./draft-configuration.ts";
import { randomUUID } from "node:crypto";
import { defaultProjections } from "./session-log.ts";
import { nativePermissionView } from "./session-presentation.ts";
import type { Inspection } from "./harnesses.ts";
import type { WebHarnessPreferences } from "./harness-preferences.ts";
import type { ModelSelection } from "./ch-harness-catalog.ts";
import type { Workspaces } from "./workspaces.ts";
import { type EventHub, RpcError, type StreamSink } from "./transport.ts";

export interface MixedDraft {
  id: string;
  cwd?: string;
  selection: ModelSelection;
  createdAt: number;
  title?: string;
  permissionModeId?: string;
  submitting?: Promise<unknown>;
}

interface DraftCatalog {
  models(): Promise<{ default: ModelSelection }>;
  inspect(id: string, cwd?: string): Promise<Inspection>;
  name(id: string): Promise<string>;
  preferences?: WebHarnessPreferences | undefined;
}

interface DraftSummary {
  sessionId: string;
  cwd: string | undefined;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  agentAvailable: boolean;
  projections: { kind: "cached"; asOfSeq: number; values: Record<string, unknown> };
}

export class MixedDrafts {
  readonly entries = new Map<string, MixedDraft>();
  private readonly controls = new Set<StreamSink>();
  private readonly follows = new Map<string, Set<StreamSink>>();
  private revision = 0;
  private closed = false;
  constructor(
    private readonly catalog: DraftCatalog,
    private readonly workspaces: Workspaces,
    private readonly events: EventHub,
    private readonly inputCapabilities: (draft: MixedDraft) => Record<string, unknown>,
  ) {}

  async create(request: {
    sessionId?: string;
    cwd?: string;
    workspaceId?: string;
  }): Promise<{ sessionId: string; agentPreset: string }> {
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    const id = request.sessionId ?? `draft-${randomUUID()}`;
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id))
      throw new RpcError("session/invalid-id", "Invalid draft identity.");
    const cwd =
      request.cwd ??
      (request.workspaceId ? this.workspaces.get(request.workspaceId)?.path : undefined);
    if ((request.workspaceId || request.cwd) && !cwd)
      throw new RpcError("workspace/invalid-path", "Choose a valid workspace.");
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.submitting || existing.cwd !== cwd)
        throw new RpcError("session/busy", "This draft is already in use.");
      return { sessionId: id, agentPreset: "standard" };
    }
    const selection = (await this.catalog.models()).default;
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    if (this.entries.has(id)) return this.create(request);
    const draft: MixedDraft = { id, ...(cwd ? { cwd } : {}), selection, createdAt: Date.now() };
    const config = await this.catalog.preferences
      ?.configuration(selection.provider)
      .catch(() => undefined);
    const inspection = await this.catalog.inspect(selection.provider, cwd);
    const permissionModeId = draftPermissionMode(inspection, config?.permissionModeId);
    if (permissionModeId) draft.permissionModeId = permissionModeId;
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    if (this.entries.has(id)) return this.create(request);
    this.entries.set(id, draft);
    this.revision++;
    if (cwd) this.workspaces.attachReferencedSession(id, cwd);
    this.workspaces.addDraftReference(id, cwd);
    await this.publish(draft);
    return { sessionId: id, agentPreset: "standard" };
  }

  async summary(draft: MixedDraft): Promise<DraftSummary> {
    const selection = draft.selection;
    const inspection = await this.catalog.inspect(draft.selection.provider, draft.cwd);
    const name = await this.catalog.name(draft.selection.provider);
    if (selection !== draft.selection) return this.summary(draft);
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
          ...this.inputCapabilities(draft),
          title: draft.title ?? null,
          modelSelection: { lastUsed: null, next: draft.selection },
          harnessIdentity: { id: draft.selection.provider, name },
          nativePermissions: nativePermissionView(draft.selection.provider, inspection, false),
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

  async select(draft: MixedDraft, selection: ModelSelection): Promise<void> {
    const before = draft.selection;
    if (this.closed || draft.submitting || draft.selection !== before)
      throw new RpcError("session/busy", "Draft selection changed or submission is in progress.");
    const inspection = await this.catalog.inspect(selection.provider, draft.cwd);
    if (this.closed || draft.submitting || draft.selection !== before)
      throw new RpcError("session/busy", "Draft selection changed or submission is in progress.");
    const model =
      inspection.status === "ready" &&
      inspection.catalog.models.find((m) => m.ref.id === selection.model);
    if (
      !model ||
      (selection.reasoningEffort &&
        !(
          model.supportedThinkingOptionIds ??
          (inspection.status === "ready"
            ? inspection.catalog.thinkingOptions.map((option) => option.id)
            : [])
        ).includes(selection.reasoningEffort))
    )
      throw new RpcError(
        "session/model-unavailable",
        "Model or reasoning option is unavailable for this Harness.",
      );
    const config =
      before.provider !== selection.provider
        ? await this.catalog.preferences?.configuration(selection.provider).catch(() => undefined)
        : undefined;
    if (this.closed || draft.submitting || draft.selection !== before)
      throw new RpcError("session/busy", "Draft selection changed or submission is in progress.");
    if (before.provider !== selection.provider) {
      delete draft.permissionModeId;
      const permissionModeId = draftPermissionMode(inspection, config?.permissionModeId);
      if (permissionModeId) draft.permissionModeId = permissionModeId;
    }
    draft.selection = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
    this.revision++;
    await this.publish(draft);
  }

  async permission(draft: MixedDraft, line: string) {
    const before = draft.selection;
    if (draft.submitting) throw new RpcError("session/busy", "Draft submission is in progress.");
    const modeId = /^\/permission\s+(.+)$/u.exec(line)?.[1];
    if (!modeId)
      throw new RpcError("session/not-started", "Send a message before running this command.");
    const inspection = await this.catalog.inspect(draft.selection.provider, draft.cwd);
    const mode =
      inspection.status === "ready" &&
      inspection.capabilities.configuration.selectPermissionMode &&
      inspection.permissionModes?.modes.find((m) => m.id === modeId);
    if (!mode || this.closed || draft.submitting || draft.selection !== before)
      throw new RpcError("session/permission-unavailable", "Permission mode is unavailable.");
    draft.permissionModeId = modeId;
    this.revision++;
    await this.publish(draft);
    return { commandId: randomUUID(), result: { kind: "success", text: mode.label } };
  }

  async rename(draft: MixedDraft, title: string) {
    if (this.closed) throw new RpcError("session/closed", "Web sessions are closing.");
    if (draft.submitting) throw new RpcError("session/busy", "Draft submission is in progress.");
    draft.title = title;
    this.revision++;
    await this.publish(draft);
    return {};
  }

  private async publish(draft: MixedDraft) {
    const summary = await this.summary(draft);
    if (this.closed || !this.entries.has(draft.id)) return;
    this.events.emit("api-session/added", summary);
    this.publishBaseline(draft.id, summary.projections);
  }

  private publishBaseline(id: string, block: { asOfSeq: number; values: Record<string, unknown> }) {
    if (this.closed) return;
    for (const [key, value] of Object.entries(block.values))
      for (const sink of this.controls)
        sink.push({ type: "projection", sessionId: id, key, value, seq: block.asOfSeq });
  }

  async control(sink: StreamSink) {
    let projections: Record<string, unknown>;
    let revision: number;
    do {
      revision = this.revision;
      projections = Object.fromEntries(
        await Promise.all(
          [...this.entries.values()].map(async (d) => [d.id, (await this.summary(d)).projections]),
        ),
      );
    } while (revision !== this.revision && !sink.closed && !this.closed);
    if (sink.closed || this.closed) {
      sink.end();
      return;
    }
    this.controls.add(sink);
    sink.onClose(() => this.controls.delete(sink));
    sink.push({ type: "baseline", value: { projections } });
  }

  async follow(draft: MixedDraft, sink: StreamSink) {
    const summary = await this.summary(draft);
    if (sink.closed || this.closed) {
      sink.end();
      return;
    }
    if (!this.entries.has(draft.id)) {
      sink.end();
      return;
    }
    const followers = this.follows.get(draft.id) ?? new Set<StreamSink>();
    this.follows.set(draft.id, followers);
    followers.add(sink);
    sink.onClose(() => {
      followers.delete(sink);
      if (!followers.size) this.follows.delete(draft.id);
    });
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
  }

  bound(id: string) {
    this.entries.delete(id);
    this.revision++;
    for (const sink of this.follows.get(id) ?? []) sink.end();
  }

  close() {
    this.closed = true;
    for (const sink of this.controls) sink.end();
    for (const followers of this.follows.values()) for (const sink of followers) sink.end();
  }
}
