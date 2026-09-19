import type { HarnessSessionCapabilities } from "@codexhost/harness-adapter";
import type { ZcodeConnection } from "./connection.js";
export const CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
  subagents: { observe: true, readTranscript: true },
  autonomousTurns: { observe: true },
};
export function capabilitiesForConnection(
  connection: Pick<ZcodeConnection, "locator">,
): HarnessSessionCapabilities {
  return connection.locator?.backend === "desktop"
    ? {
        ...CAPABILITIES,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        subagents: { observe: true, readTranscript: false },
      }
    : CAPABILITIES;
}
