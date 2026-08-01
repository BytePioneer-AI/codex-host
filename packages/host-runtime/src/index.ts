import { packageMetadata as claudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { packageMetadata as piAdapter } from "@codexhost/adapter-pi";
import { packageMetadata as desktopControl } from "@codexhost/desktop-control";
import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { packageMetadata as protocolCore } from "@codexhost/protocol-core";
import { packageMetadata as sharedContracts } from "@codexhost/shared-contracts";

export {
  CLAUDE_CODE_COMMAND_ENV,
  PI_COMMAND_ENV,
  createExternalHarnessAdapters,
} from "./adapter-composition.js";
export { AppServerHost, classifyCreateRequestRoute } from "./app-server-host.js";
export type { AppServerHostOptions } from "./app-server-host.js";
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
    desktopControl.name,
    harnessAdapter.name,
    mappingStore.name,
    piAdapter.name,
    sharedContracts.name,
  ],
} as const;
