import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { PiRpcSession } from "./pi-rpc-session.js";
export type { PiRpcSessionOptions, PiSessionState, PiTextTurnResult } from "./pi-rpc-session.js";

export const packageMetadata = {
  name: "@codexhost/adapter-pi",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
