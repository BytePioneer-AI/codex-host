import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";
import type { HarnessModelCatalog, HarnessSessionCapabilities } from "@codexhost/harness-adapter";
import type { CursorSessionInfo } from "./transport.js";

export const CURSOR_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: true, readTranscript: false },
};
export const CURSOR_MODES = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "agent",
  modes: [
    { id: "agent", label: "Agent", description: "Native agent mode with Cursor tool approvals" },
    { id: "plan", label: "Plan", description: "Native read-only planning mode" },
    { id: "ask", label: "Ask", description: "Native read-only question mode" },
  ],
});
export const cursorModelRef = (nativeId: string) =>
  harnessModelRefSchema.parse({ id: `cursor.${Buffer.from(nativeId).toString("base64url")}` });
export function cursorModels(info: CursorSessionInfo) {
  const option = info.configOptions?.find((option) => option.id === "model");
  if (!option || option.type !== "select")
    throw new Error("Cursor returned no model configuration");
  const models = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  return { models, current: option.currentValue };
}
export function cursorCatalog(info: CursorSessionInfo): HarnessModelCatalog {
  const native = cursorModels(info);
  const models = native.models.map((model) => ({
    ref: cursorModelRef(model.value),
    label: model.name,
  }));
  if (!models.length) throw new Error("Cursor returned no model catalog");
  return { models, defaultModel: cursorModelRef(native.current), thinkingOptions: [] };
}
export function cursorNativeModel(info: CursorSessionInfo, ref: string): string {
  const native = cursorModels(info).models.find((model) => cursorModelRef(model.value).id === ref);
  if (!native) throw new Error("Model is not in this Cursor session's native catalog");
  return native.value;
}
