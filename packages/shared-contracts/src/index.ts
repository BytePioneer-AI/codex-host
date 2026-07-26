import { z } from "zod";
import { WORKSPACE_CONTRACT_VERSION } from "./version.js";

export { WORKSPACE_CONTRACT_VERSION } from "./version.js";

export const workspaceContractVersionSchema = z.literal(WORKSPACE_CONTRACT_VERSION);

export const packageMetadata = {
  name: "@codexhost/shared-contracts",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
} as const;
