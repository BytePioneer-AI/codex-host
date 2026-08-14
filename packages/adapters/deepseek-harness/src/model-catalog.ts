import { Buffer } from "node:buffer";

import type { ModelProviderGroup, ModelSelection } from "@deepseek-ai/dsh-host-apiproxy/api";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

const MODEL_REF_PREFIX = "deepseek-harness-model-v2.";
const LEGACY_MODEL_REF_PREFIX = "deepseek-harness-model-v1.";

export interface DeepSeekNativeModelRef {
  provider: string;
  model: string;
}

export function encodeDeepSeekHarnessModelRef(model: DeepSeekNativeModelRef): HarnessModelRef {
  const provider = model.provider.trim();
  const modelId = model.model.trim();
  if (!provider || !modelId) throw new Error("DeepSeek Harness Model identity must not be empty");
  const encoded = Buffer.from(JSON.stringify([provider, modelId]), "utf8").toString("base64url");
  const id = `${MODEL_REF_PREFIX}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("DeepSeek Harness Model is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeDeepSeekHarnessModelRef(ref: HarnessModelRef): DeepSeekNativeModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  if (parsed.id.startsWith(LEGACY_MODEL_REF_PREFIX)) {
    const encoded = parsed.id.slice(LEGACY_MODEL_REF_PREFIX.length);
    const model = Buffer.from(encoded, "base64url").toString("utf8");
    if (!encoded || !model) throw new Error("DeepSeek Harness legacy Model Ref is invalid");
    return { provider: "deepseek-official", model };
  }
  if (!parsed.id.startsWith(MODEL_REF_PREFIX)) {
    throw new Error("DeepSeek Harness Model Ref belongs to another Adapter");
  }
  const encoded = parsed.id.slice(MODEL_REF_PREFIX.length);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("DeepSeek Harness Model Ref is invalid");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new Error("DeepSeek Harness Model Ref is invalid");
  }
  const native = { provider: decoded[0], model: decoded[1] };
  if (encodeDeepSeekHarnessModelRef(native).id !== parsed.id) {
    throw new Error("DeepSeek Harness Model Ref is not canonical");
  }
  return native;
}

export function normalizeDeepSeekModelCatalog(
  groups: readonly ModelProviderGroup[],
  selection: ModelSelection,
): HarnessModelCatalog {
  const models = groups.flatMap((group) =>
    group.models.map((model) => ({
      ref: encodeDeepSeekHarnessModelRef({ provider: group.id, model: model.id }),
      label: `${group.name} / ${model.name}`,
      ...(model.description ? { description: model.description } : {}),
    })),
  );
  const defaultModel = encodeDeepSeekHarnessModelRef(selection);
  if (!models.some((model) => model.ref.id === defaultModel.id)) {
    models.unshift({ ref: defaultModel, label: `${selection.provider} / ${selection.model}` });
  }
  return harnessModelCatalogSchema.parse({ models, defaultModel, thinkingOptions: [] });
}
