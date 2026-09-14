import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessSessionCapabilities,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "qoder.";

export const QODER_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: false, readTranscript: false },
};

export const qoderModelRef = (nativeId: string): HarnessModelRef =>
  harnessModelRefSchema.parse({
    id: `${MODEL_REF_PREFIX}${Buffer.from(nativeId, "utf8").toString("base64url")}`,
  });

export function decodeQoderModelRef(ref: HarnessModelRef | string): string {
  const id = typeof ref === "string" ? ref : ref.id;
  if (!id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("Model is not in this Qoder session's native catalog");
  }
  return Buffer.from(id.slice(MODEL_REF_PREFIX.length), "base64url").toString("utf8");
}

export function parseQoderListModels(text: string): HarnessModelCatalog {
  const names = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^MODEL$/iu.test(line));
  if (names.length === 0) throw new Error("Qoder returned no native model catalog");
  const models = names.map((name) => {
    const label = name.replace(/\s+\([^)]*\)\s*$/u, "").trim() || name;
    return { ref: qoderModelRef(name), label };
  });
  const defaultModel = models.find((model) => /^auto$/iu.test(model.label))?.ref ?? models[0]?.ref;
  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: [],
  });
}
