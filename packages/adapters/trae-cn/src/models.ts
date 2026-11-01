import { createHash } from "node:crypto";
import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";
import type { BridgeInspection, BridgeModel } from "./protocol.js";
import { record, TraeError } from "./errors.js";

/** Native custom IDs contain slashes; Host model references must remain opaque and transport safe. */
export function modelRef(agentType: string, nativeId: string): HarnessModelRef {
  const id = createHash("sha256")
    .update(JSON.stringify([agentType, nativeId]))
    .digest("base64url");
  return harnessModelRefSchema.parse({ id: `trae.${id}` });
}

export function modelCatalog(inspection: BridgeInspection): HarnessModelCatalog {
  const entries = inspection.models.map((model) => {
    const ref = modelRef(inspection.agentType, model.id);
    return { model, ref, thinking: modelThinkingOptions(inspection, ref) };
  });
  return {
    models: entries.map(({ model, ref, thinking }) => ({
      ref,
      label: model.label,
      supportedThinkingOptionIds: thinking.map((option) => option.id),
    })),
    thinkingOptions: entries.flatMap((entry) => entry.thinking),
  };
}

export function nativeModelId(inspection: BridgeInspection, requested: HarnessModelRef): string {
  const model = inspection.models.find(
    (entry) => modelRef(inspection.agentType, entry.id).id === requested.id,
  );
  if (!model)
    throw new TraeError(
      "configurationRequired",
      "Choose a currently available TRAE CN conversation model",
    );
  return model.id;
}

/** Only a native-confirmed config name can establish effective configuration. */
export function confirmedModel(value: unknown, agentType: string): HarnessModelRef | undefined {
  return record(value) && typeof value.config_name === "string" && value.config_name.trim()
    ? modelRef(agentType, value.config_name)
    : undefined;
}

export interface NativeThinkingSelection {
  field: "reasoning_effort" | "reasoning_effort_level";
  level: string;
}

export function thinkingOptionId(
  agentType: string,
  model: BridgeModel,
  level: string,
): HarnessThinkingOptionId {
  const hash = createHash("sha256")
    .update(JSON.stringify([agentType, model.id, model.thinking?.field, level]))
    .digest("base64url");
  return harnessThinkingOptionIdSchema.parse(`trae.thinking.${hash}`);
}

export function modelThinkingOptions(
  inspection: BridgeInspection,
  model?: HarnessModelRef,
): HarnessThinkingOption[] {
  if (inspection.configuration?.thinkingSelection !== "per-request" || !model) return [];
  const native = inspection.models.find(
    (entry) => modelRef(inspection.agentType, entry.id).id === model.id,
  );
  return (
    native?.thinking?.options.map((level) => ({
      id: thinkingOptionId(inspection.agentType, native, level),
      label: level,
    })) ?? []
  );
}

export function nativeThinkingSelection(
  inspection: BridgeInspection,
  model: HarnessModelRef,
  option: HarnessThinkingOptionId,
): NativeThinkingSelection {
  if (inspection.configuration?.thinkingSelection !== "per-request")
    throw new TraeError("unsupported", "Update the TRAE CN Companion to select Thinking");
  const native = inspection.models.find(
    (entry) => modelRef(inspection.agentType, entry.id).id === model.id,
  );
  if (!native?.thinking)
    throw new TraeError("unsupported", "This native model does not support Thinking selection");
  const level = native.thinking.options.find(
    (level) => thinkingOptionId(inspection.agentType, native, level) === option,
  );
  if (level === undefined)
    throw new TraeError(
      "invalidRequest",
      "Thinking option does not belong to the selected native model",
    );
  return { field: native.thinking.field, level };
}

export function confirmedThinking(
  value: unknown,
  inspection: BridgeInspection,
): HarnessThinkingOptionId | undefined {
  if (
    inspection.configuration?.thinkingSelection !== "per-request" ||
    !record(value) ||
    typeof value.config_name !== "string"
  )
    return undefined;
  const model = inspection.models.find((entry) => entry.id === value.config_name);
  const level = model?.thinking ? value[model.thinking.field] : undefined;
  return model?.thinking && typeof level === "string" && model.thinking.options.includes(level)
    ? thinkingOptionId(inspection.agentType, model, level)
    : undefined;
}

export function historyThinking(
  value: unknown,
  inspection: BridgeInspection,
): HarnessThinkingOptionId | undefined {
  if (!record(value) || !Array.isArray(value.items)) return undefined;
  const latest = value.items
    .filter(
      (entry): entry is Record<string, unknown> =>
        record(entry) && Number.isSafeInteger(entry.message_index),
    )
    .sort((a, b) => Number(b.message_index) - Number(a.message_index))[0];
  return confirmedThinking(latest?.model, inspection);
}
