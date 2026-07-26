import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts/version";

export const rendererBuildMetadata = {
  name: "@codexhost/renderer-extension",
  target: "browser",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
