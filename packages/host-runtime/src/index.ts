import { packageMetadata as claudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { packageMetadata as deepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { packageMetadata as grokAdapter } from "@codexhost/adapter-grok";
import { packageMetadata as piAdapter } from "@codexhost/adapter-pi";
import { packageMetadata as desktopControl } from "@codexhost/desktop-control";
import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { packageMetadata as protocolCore } from "@codexhost/protocol-core";
import { packageMetadata as sharedContracts } from "@codexhost/shared-contracts";
import { packageMetadata as updateManager } from "@codexhost/update-manager";

export {
  CLAUDE_CODE_COMMAND_ENV,
  DEEPSEEK_HARNESS_COMMAND_ENV,
  DEEPSEEK_HARNESS_ENDPOINT_ENV,
  GROK_COMMAND_ENV,
  PI_COMMAND_ENV,
  createExternalHarnessAdapters,
  prefetchClaudeCodeModelCatalog,
} from "./adapter-composition.js";
export { AppServerHost, classifyCreateRequestRoute } from "./app-server-host.js";
export type { AppServerHostOptions } from "./app-server-host.js";
export { createHostUpdateCoordinator, requestControllerShutdown } from "./update-coordinator.js";
export type {
  CreateHostUpdateCoordinatorOptions,
  HostUpdateCoordinator,
} from "./update-coordinator.js";
export { classifyThreadPurpose, RequestRouteObservationTracker } from "./route-observation.js";
export type {
  CreateRequestRouteObservation,
  RequestRouteObservation,
  ThreadPurpose,
  TrackedCreateRouteObservation,
  TurnRequestRouteObservation,
} from "./route-observation.js";
export const packageMetadata = {
  name: "@codexhost/host-runtime",
  dependencies: [
    protocolCore.name,
    claudeCodeAdapter.name,
    deepSeekHarnessAdapter.name,
    desktopControl.name,
    harnessAdapter.name,
    grokAdapter.name,
    mappingStore.name,
    piAdapter.name,
    sharedContracts.name,
    updateManager.name,
  ],
} as const;
