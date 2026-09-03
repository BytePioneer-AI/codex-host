export { BrokeredHarnessAdapter } from "./client.js";
export {
  HARNESS_BROKER_DESCRIPTOR_ENV,
  HARNESS_BROKER_DESCRIPTOR_FILE,
  HARNESS_BROKER_SOCKET_FILE,
  defaultHarnessBrokerDescriptorPath,
  defaultHarnessBrokerDirectory,
  defaultHarnessBrokerSocketPath,
} from "./paths.js";
export {
  HARNESS_BROKER_MAX_FRAME_BYTES,
  HARNESS_BROKER_MAX_PENDING_REQUESTS,
  HARNESS_BROKER_PROTOCOL_VERSION,
} from "./protocol.js";
export { startHarnessBrokerServer } from "./server.js";
export type { HarnessBrokerServer } from "./server.js";

export const packageMetadata = { name: "@codexhost/harness-broker", protocolVersion: 1 } as const;
