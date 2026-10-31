import { createHash } from "node:crypto";
import {
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";
import type { BridgeInspection } from "./protocol.js";
import { record, TraeError } from "./errors.js";

/** Native custom IDs contain slashes; Host model references must remain opaque and transport safe. */
export function modelRef(agentType: string, nativeId: string): HarnessModelRef {
  const id = createHash("sha256")
    .update(JSON.stringify([agentType, nativeId]))
    .digest("base64url");
  return harnessModelRefSchema.parse({ id: `trae.${id}` });
}

export function modelCatalog(inspection: BridgeInspection): HarnessModelCatalog {
  return {
    models: inspection.models.map((model) => ({
      ref: modelRef(inspection.agentType, model.id),
      label: model.label,
    })),
    thinkingOptions: [],
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
