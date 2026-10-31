import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessSessionCapabilities,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import { resolve } from "node:path";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { array, record, requiredText, text, TraeError } from "./protocol.js";

export const HARNESS_ID = harnessIdSchema.parse("trae");
export const CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
  autonomousTurns: { observe: true },
};
export const PERMISSION_MODES = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "workspace-write",
  modes: [
    {
      id: "read-only",
      label: "Read only",
      description: "Native read-only sandbox with approval on request",
      localizations: { "zh-CN": { label: "只读" } },
    },
    {
      id: "workspace-write",
      label: "Workspace write",
      description: "Native workspace-write sandbox with approval on request",
      localizations: { "zh-CN": { label: "工作区可写" } },
    },
    {
      id: "full-access",
      label: "Full access",
      description: "No sandbox or approval prompts",
      dangerous: true,
      localizations: { "zh-CN": { label: "完全访问" } },
    },
  ],
});
export function modelRef(model: string, provider = ""): HarnessModelRef {
  return harnessModelRefSchema.parse({
    id: "trae-model-v1." + Buffer.from(JSON.stringify([provider, model])).toString("base64url"),
  });
}
export function decodeModel(ref: HarnessModelRef): { model: string; modelProvider?: string } {
  if (!ref.id.startsWith("trae-model-v1."))
    throw new TraeError("invalidRequest", "Model Ref does not belong to Trae");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(ref.id.slice(14), "base64url").toString("utf8"));
  } catch {
    throw new TraeError("invalidRequest", "Malformed Trae Model Ref");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    !text(decoded[1]).trim()
  )
    throw new TraeError("invalidRequest", "Malformed Trae Model Ref");
  if (modelRef(text(decoded[1]), decoded[0]).id !== ref.id)
    throw new TraeError("invalidRequest", "Noncanonical Trae Model Ref");
  return { model: text(decoded[1]), ...(decoded[0] ? { modelProvider: decoded[0] } : {}) };
}
export function catalogFrom(rows: unknown[]): HarnessModelCatalog {
  const thinking = new Map<
    string,
    { id: ReturnType<typeof harnessThinkingOptionIdSchema.parse>; label: string }
  >();
  const seen = new Set<string>();
  const models: HarnessModelCatalog["models"] = [];
  let defaultModel: HarnessModelRef | undefined;
  for (const value of rows) {
    const m = record(value);
    if (m.hidden === true || !text(m.model).trim()) continue;
    const ref = modelRef(text(m.model), text(m.modelProviderId));
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const supportedThinkingOptionIds = array(m.supportedReasoningEfforts).flatMap((value) => {
      const e = record(value);
      const id = harnessThinkingOptionIdSchema.safeParse(e.reasoningEffort);
      if (!id.success) return [];
      thinking.set(id.data, { id: id.data, label: text(e.description) || id.data });
      return [id.data];
    });
    models.push({ ref, label: text(m.displayName) || text(m.model), supportedThinkingOptionIds });
    if (m.isDefault === true) defaultModel = ref;
  }
  return {
    models,
    thinkingOptions: [...thinking.values()],
    ...(defaultModel ? { defaultModel } : {}),
  };
}
export function permissionParams(mode: string): Record<string, unknown> {
  if (mode === "full-access") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  if (mode === "read-only" || mode === "workspace-write")
    return { approvalPolicy: "on-request", sandbox: mode };
  throw new TraeError("invalidRequest", "Unknown Trae permission mode");
}
export function stateFrom(
  value: unknown,
  cwd: string,
  catalog: HarnessModelCatalog,
): HarnessSessionState {
  const r = record(value);
  const thread = record(r.thread);
  const id = requiredText(thread.id, "thread.id");
  const actualCwd = requiredText(r.cwd, "cwd");
  const canonical = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (canonical(actualCwd) !== canonical(cwd))
    throw new TraeError("protocolError", "Trae did not confirm the requested workspace");
  const state: HarnessSessionState = {
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: HARNESS_ID,
      nativeSessionId: id,
      formatVersion: 1,
      locator: { cwd: actualCwd },
    }),
  };
  if (text(r.model)) {
    const exact = modelRef(text(r.model), text(r.modelProvider));
    // A catalog entry without provider identity selects Trae's own configured default provider.
    // Keep that public Ref only when no provider-specific entry matches the acknowledgment.
    state.effectiveModel =
      catalog.models.find((m) => m.ref.id === exact.id)?.ref ??
      catalog.models.find((m) => m.ref.id === modelRef(text(r.model)).id)?.ref ??
      exact;
    state.availableThinkingOptions = catalog.thinkingOptions.filter((o) =>
      catalog.models
        .find((m) => m.ref.id === state.effectiveModel?.id)
        ?.supportedThinkingOptionIds?.includes(o.id),
    );
    const effort = harnessThinkingOptionIdSchema.safeParse(r.reasoningEffort);
    if (effort.success && state.availableThinkingOptions.some((o) => o.id === effort.data))
      state.effectiveThinkingOptionId = effort.data;
  }
  const sandbox = text(record(r.sandbox).type);
  const mode =
    sandbox === "dangerFullAccess" && r.approvalPolicy === "never"
      ? "full-access"
      : sandbox === "readOnly" && r.approvalPolicy === "on-request"
        ? "read-only"
        : sandbox === "workspaceWrite" && r.approvalPolicy === "on-request"
          ? "workspace-write"
          : undefined;
  const permission = PERMISSION_MODES.modes.find((m) => m.id === mode);
  if (permission) state.effectivePermissionModeId = permission.id;
  return state;
}
