import type { HarnessSessionCapabilities } from "@codexhost/harness-adapter";
import type { BridgeInspection } from "./protocol.js";

// Older Companions do not expose model preparation or history feature flags.
// These capabilities are derived from the negotiated native bridge below.
export const SESSION_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: false,
    selectThinkingOption: false,
    selectPermissionMode: false,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  autonomousTurns: { observe: true },
};

export function sessionCapabilities(
  inspection: BridgeInspection,
  hasFileEdits = false,
  turnCount = 0,
  hasBackgroundCommands = false,
): HarnessSessionCapabilities {
  const fork =
    inspection.history?.forkFromMessage === true && !hasFileEdits && !hasBackgroundCommands;
  return {
    ...SESSION_CAPABILITIES,
    configuration: {
      ...SESSION_CAPABILITIES.configuration,
      selectModel: inspection.configuration?.modelSelection === "per-request",
      selectPermissionMode: !!inspection.permissions,
      selectThinkingOption:
        inspection.configuration?.thinkingSelection === "per-request" &&
        inspection.models.some((model) => !!model.thinking?.options.length),
    },
    history: {
      fork,
      forkAcrossCwd: false,
      rollbackLastTurn:
        inspection.history?.forkFromMessage === true &&
        ((!hasFileEdits && !hasBackgroundCommands) || turnCount <= 1),
    },
  };
}
