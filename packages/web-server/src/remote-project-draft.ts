import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessInspectionSchema,
  harnessModelRefFromKey,
  harnessModelRefKey,
  harnessPluginRouteSchema,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { groupOf } from "./harnesses.ts";
import { type ModelSelection } from "./ch-harness-catalog.ts";
import { defaultProjections } from "./session-log.ts";
import { RpcError, type StreamSink } from "./transport.ts";

type Call = (operation: RemoteSessionOperation) => Promise<unknown>;
type Target = { hostId: string; epoch: string; cwd: string };
const plugins = z.array(z.object({ id: harnessIdSchema, name: z.string() }));
async function loadCatalog(target: Target, call: Call) {
  const { hostId, epoch } = target;
  const installed = plugins.parse(await call({ kind: "projectHarnesses", hostId, epoch }));
  const providers = [{ id: "codex", name: "Codex" }, ...installed.filter((p) => p.id !== "codex")];
  const rows = await Promise.all(
    providers.map(async ({ id, name }) => {
      try {
        const inspection = harnessInspectionSchema.parse(
          await call({ kind: "inspectHarness", ...target, harnessId: id }),
        );
        if (inspection.status === "ready" && inspection.catalog.models[0]) {
          return {
            group: groupOf(id, name, inspection),
            preferred: harnessModelRefKey(
              inspection.catalog.defaultModel ?? inspection.catalog.models[0].ref,
            ),
          };
        }
        if (inspection.status !== "ready" && inspection.status !== "notInstalled")
          return { failure: { id, name, message: inspection.error.message } };
      } catch {
        return { failure: { id, name, message: "Remote Harness inspection failed." } };
      }
      return {};
    }),
  );
  const groups = rows.flatMap((row) => (row.group ? [row.group] : []));
  const first = rows.find((row) => row.group && row.preferred);
  if (!first?.group || !first.preferred)
    throw new RpcError("remote/no-harness", "No ready Harness in the selected remote project.");
  return {
    default: { provider: first.group.id, model: first.preferred },
    groups,
    routableProviders: groups.map((g) => g.id),
    failures: rows.flatMap((row) => (row.failure ? [row.failure] : [])),
  };
}

/** An unsubmitted composer. Only the confirmed native ID is persisted by the workspace store. */
export class RemoteProjectDraft {
  readonly id = "web-remote:draft-" + randomUUID();
  readonly createdAt = Date.now();
  lastUsed = this.createdAt;
  sending = false;
  selection?: ModelSelection;
  private catalogRequest?: ReturnType<typeof loadCatalog>;
  submission?: { key: string; result: Promise<unknown> };
  canonicalId?: string;
  constructor(
    readonly workspaceId: string,
    readonly projectId: string,
    readonly target: Target,
    readonly displayName: string,
  ) {}
  catalog(call: Call) {
    this.catalogRequest ??= loadCatalog(this.target, call).catch((error: unknown) => {
      delete this.catalogRequest;
      throw error;
    });
    return this.catalogRequest;
  }
  async select(request: Record<string, unknown>, call: Call) {
    const catalog = await this.catalog(call);
    if (this.submission)
      throw new RpcError("session/busy", "The first message is already being sent.");
    const group = catalog.groups.find((g) => g.id === request.provider);
    const model =
      group?.models.find((m) => m.id === request.model) ??
      group?.models.find(
        (m) => m.fastModel === request.model || m.ultrafastModel === request.model,
      );
    if (
      !group ||
      !model ||
      typeof request.model !== "string" ||
      (request.reasoningEffort != null &&
        !model.reasoning?.efforts.some((e) => e.id === request.reasoningEffort))
    )
      throw new RpcError("session/model-unavailable", "Choose a model from the remote project.");
    this.selection = {
      provider: group.id,
      model: request.model,
      ...(typeof request.reasoningEffort === "string"
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
    };
  }
  async startOperation(call: Call): Promise<RemoteSessionOperation> {
    const selection: ModelSelection = this.selection ?? (await this.catalog(call)).default;
    const { provider, model, reasoningEffort } = selection;
    const ref = harnessModelRefFromKey(model);
    const base = { kind: "startSelected" as const, ...this.target, harnessId: provider };
    if (provider !== "codex")
      return {
        ...base,
        model: encodeHarnessPluginRoute(
          harnessPluginRouteSchema.parse({
            harnessId: provider,
            model: ref,
            thinkingOptionId: reasoningEffort,
          }),
        ),
      };
    return {
      ...base,
      model: ref.id,
      ...(ref.serviceTier ? { serviceTier: ref.serviceTier } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  summary() {
    return {
      sessionId: this.id,
      cwd: "",
      updatedAt: this.createdAt,
      running: false,
      blank: true,
      agentAvailable: true,
      projections: {
        kind: "cached",
        asOfSeq: 0,
        values: {
          ...defaultProjections(),
          modelSelection: { lastUsed: null, next: this.selection ?? null },
          ...(this.selection
            ? { harnessIdentity: { id: this.selection.provider, name: this.selection.provider } }
            : {}),
          threadReference: { hostId: this.target.hostId },
          remoteHost: {
            hostId: this.target.hostId,
            displayName: this.displayName,
            state: "connected",
          },
          nativeDiscovery: false,
          attachmentInput: { enabled: false },
          sessionListMetadata: { blank: true, lastPromptAt: null },
        },
      },
    };
  }
  follow(sink: StreamSink) {
    sink.push({
      type: "snapshot",
      header: {
        version: 4,
        id: this.id,
        createdAt: this.createdAt,
        cwd: "",
        isSeeded: false,
        agentPreset: "standard",
      },
      cursor: -1,
      records: [],
      hasMore: false,
      projections: this.summary().projections,
      assistantStream: { revision: 0 },
    });
  }
}
