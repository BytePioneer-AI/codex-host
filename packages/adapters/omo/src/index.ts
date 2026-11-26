import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { OMO_COMMAND_ENV, omoDiscoverySpec, resolveOmoExecutable } from "./command.js";
export type { OmoExecutableDependencies, OmoExecutableInput } from "./command.js";
export {
  createOmoInstallation,
  OMO_VERSION_TIMEOUT_MS,
  OmoVersionError,
  parseOmoVersion,
} from "./installation.js";
export { OmoAdapter } from "./omo-adapter.js";
export type { OmoAdapterOptions } from "./omo-adapter.js";

export const packageMetadata = {
  name: "@codexhost/adapter-omo",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
