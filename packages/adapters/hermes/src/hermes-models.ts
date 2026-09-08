import type {
  HarnessModelRef,
  HarnessPermissionModeCatalog,
  HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";

/**
 * Hermes maps its edit-approval policy onto ACP session modes; the ids come
 * from acp_adapter/server.py and are already transport-safe.
 */
export const HERMES_MODE_DEFAULT = "default";
export const HERMES_MODE_ACCEPT_EDITS = "accept_edits";
export const HERMES_MODE_DONT_ASK = "dont_ask";

const hermesModeIds = new Set<string>([
  HERMES_MODE_DEFAULT,
  HERMES_MODE_ACCEPT_EDITS,
  HERMES_MODE_DONT_ASK,
]);

export const HERMES_DEFAULT_PERMISSION_MODE_ID: HarnessPermissionModeId =
  harnessPermissionModeIdSchema.parse(HERMES_MODE_DEFAULT);

export function hermesPermissionModeCatalog(): HarnessPermissionModeCatalog {
  return harnessPermissionModeCatalogSchema.parse({
    modes: [
      {
        id: HERMES_MODE_DEFAULT,
        label: "默认",
        description: "编辑前询问。",
      },
      {
        id: HERMES_MODE_ACCEPT_EDITS,
        label: "自动接受编辑",
        description: "自动允许工作区和 /tmp 内的编辑；敏感路径仍会询问。",
      },
      {
        id: HERMES_MODE_DONT_ASK,
        label: "不再询问",
        description: "本次会话自动允许文件编辑（敏感路径除外）。",
        dangerous: true,
      },
    ],
    defaultModeId: HERMES_DEFAULT_PERMISSION_MODE_ID,
  });
}

export function isHermesModeId(value: string): value is typeof HERMES_MODE_DEFAULT {
  return hermesModeIds.has(value);
}

/**
 * Native Hermes model ids look like `zai:glm-5-turbo` (contain `:`), which
 * the transport-safe HarnessModelRef regex rejects. Model refs are opaque to
 * the Host, so encode the native id reversibly (base64url) inside the ref id.
 */
export function encodeHermesModelRef(modelId: string): HarnessModelRef | null {
  const ref = harnessModelRefSchema.safeParse({
    id: Buffer.from(modelId, "utf8").toString("base64url"),
  });
  return ref.success ? ref.data : null;
}

export function decodeHermesModelRefId(modelRefId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(modelRefId)) return null;
  try {
    const decoded = Buffer.from(modelRefId, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export interface HermesSessionModelStateProjection {
  effectiveModel: HarnessModelRef | null;
  resolvedModelLabel: string | null;
}

interface HermesModelChoice {
  modelId: string;
  name: string;
}

/**
 * The ACP SessionState names models as `{provider} · {model}` while the
 * inventory catalog renders `{provider} / {model}`. The Host picker treats a
 * differing resolved label as an alias route worth surfacing next to the
 * selected entry, so normalize the native separator to keep one spelling.
 */
function catalogAlignedModelLabel(name: string): string {
  return name.replace(/\s+·\s+/g, " / ");
}

export function projectHermesModelState(
  models: { availableModels: HermesModelChoice[]; currentModelId?: string } | null,
): HermesSessionModelStateProjection {
  if (!models || models.availableModels.length === 0) {
    return { effectiveModel: null, resolvedModelLabel: null };
  }
  const current = models.currentModelId
    ? models.availableModels.find(({ modelId }) => modelId === models.currentModelId)
    : undefined;
  if (!current) return { effectiveModel: null, resolvedModelLabel: null };
  return {
    effectiveModel: encodeHermesModelRef(current.modelId),
    resolvedModelLabel: catalogAlignedModelLabel(current.name),
  };
}
