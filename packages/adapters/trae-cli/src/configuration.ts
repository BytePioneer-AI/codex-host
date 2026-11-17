import type { LoadSessionResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  HarnessModelCatalog,
  HarnessPermissionModeCatalog,
  HarnessSessionCapabilities,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";
import { TraeCliError } from "./common.js";

export type SessionInfo = LoadSessionResponse;
export const modelRef = (id: string) =>
  harnessModelRefSchema.parse({ id: `trae.${Buffer.from(id).toString("base64url")}` });
export const thinkingRef = (id: string) =>
  harnessThinkingOptionIdSchema.parse(`trae.${Buffer.from(id).toString("base64url")}`);
export const selector = (info: SessionInfo, category: string) =>
  info.configOptions?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && (option.category === category || option.id === category),
  );
export function choices(option: ReturnType<typeof selector>) {
  return option?.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options)) ?? [];
}
export function permissionModes(info: SessionInfo): HarnessPermissionModeCatalog | undefined {
  const modes = info.modes;
  if (!modes?.availableModes.length) return undefined;
  return harnessPermissionModeCatalogSchema.parse({
    modes: modes.availableModes.map((mode) => ({
      id: mode.id,
      label: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
      ...(/bypass|yolo/iu.test(mode.id) ? { dangerous: true } : {}),
    })),
    defaultModeId: modes.currentModeId,
  });
}
export function state(info: SessionInfo): HarnessSessionState {
  const modes = permissionModes(info);
  const model = selector(info, "model"),
    thinking = selector(info, "thought_level");
  for (const option of [model, thinking])
    if (option && !choices(option).some((entry) => entry.value === option.currentValue))
      throw new TraeCliError(
        "protocolError",
        "TRAE CLI configuration current value is absent from its options",
      );
  return {
    ...(model ? { effectiveModel: modelRef(model.currentValue) } : {}),
    ...(thinking ? { effectiveThinkingOptionId: thinkingRef(thinking.currentValue) } : {}),
    availableThinkingOptions: choices(thinking).map((entry) => ({
      id: thinkingRef(entry.value),
      label: entry.name,
    })),
    ...(modes ? { effectivePermissionModeId: modes.defaultModeId } : {}),
  };
}
export function capabilities(info: SessionInfo): HarnessSessionCapabilities {
  return {
    configuration: {
      selectModel: choices(selector(info, "model")).length > 0,
      selectThinkingOption: choices(selector(info, "thought_level")).length > 0,
      selectPermissionMode: permissionModes(info) !== undefined,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
}
/** CLI catalog inspection is sessionless. Unknown output is rejected, never replaced by Desktop models. */
export function cliCatalog(raw: unknown): HarnessModelCatalog {
  if (!Array.isArray(raw))
    throw new TraeCliError("protocolError", "Unsupported traecli models --json output");
  const models = raw.map((row: unknown) => {
    if (typeof row !== "object" || row === null)
      throw new TraeCliError("protocolError", "Invalid TRAE CLI model entry");
    const value = row as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id.trim())
      throw new TraeCliError("protocolError", "TRAE CLI model has no ID");
    const label = typeof value.name === "string" ? value.name : value.id;
    return { ref: modelRef(value.id), label };
  });
  return { models, thinkingOptions: [] };
}
