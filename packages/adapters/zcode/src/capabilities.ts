import type { HarnessSessionCapabilities } from "@codexhost/shared-contracts";
export const ZCODE_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: true, readTranscript: false },
  autonomousTurns: { observe: true },
};
