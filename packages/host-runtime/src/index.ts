import { packageMetadata as piAdapter } from "@codexhost/adapter-pi";
import { packageMetadata as desktopControl } from "@codexhost/desktop-control";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { packageMetadata as protocolCore } from "@codexhost/protocol-core";

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
export { LazyPiSession } from "./lazy-pi-session.js";
export type { PiTextSession } from "./lazy-pi-session.js";

export const packageMetadata = {
  name: "@codexhost/host-runtime",
  dependencies: [protocolCore.name, desktopControl.name, mappingStore.name, piAdapter.name],
} as const;
