import { packageMetadata as claudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { packageMetadata as codeBuddyAdapter } from "@codexhost/adapter-codebuddy";
import { packageMetadata as deepSeekHarnessAdapter } from "@codexhost/adapter-deepseek-harness";
import { packageMetadata as grokAdapter } from "@codexhost/adapter-grok";
import { packageMetadata as openCodeAdapter } from "@codexhost/adapter-opencode";
import { packageMetadata as piAdapter } from "@codexhost/adapter-pi";
import { packageMetadata as ompAdapter } from "@codexhost/adapter-omp";
import { packageMetadata as desktopControl } from "@codexhost/desktop-control";
import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { packageMetadata as harnessBroker } from "@codexhost/harness-broker";
import { packageMetadata as mappingStore } from "@codexhost/mapping-store";
import { packageMetadata as protocolCore } from "@codexhost/protocol-core";
import { packageMetadata as sharedContracts } from "@codexhost/shared-contracts";
import { packageMetadata as updateManager } from "@codexhost/update-manager";

export {
  CLAUDE_CODE_COMMAND_ENV,
  CODEBUDDY_COMMAND_ENV,
  DEEPSEEK_HARNESS_COMMAND_ENV,
  DEEPSEEK_HARNESS_ENDPOINT_ENV,
  GROK_COMMAND_ENV,
  OMP_COMMAND_ENV,
  OPENCODE_COMMAND_ENV,
  PI_COMMAND_ENV,
  createExternalHarnessAdapters,
  prefetchAntigravityModelCatalog,
  prefetchClaudeCodeModelCatalog,
} from "./adapter-composition.js";
export {
  AppServerHost,
  classifyCreateRequestRoute,
  officialEnvironment,
} from "./app-server-host.js";
export type { AppServerHostOptions } from "./app-server-host.js";
export {
  createRemoteAppServerWebSocketListener,
  isRemoteUnixListenerInvocation,
  remoteAppServerSocketPath,
  remoteUnixListenerUrl,
  stdioArgumentsForRemoteListener,
} from "./remote-app-server.js";
export type {
  RemoteAppServerSession,
  RemoteAppServerSessionStreams,
  RemoteAppServerWebSocketListener,
} from "./remote-app-server.js";
export { runDelegationCli, DELEGATION_HELP } from "./delegation-cli.js";
export { DelegationControlRegistry } from "./delegation-control-registry.js";
export { startDelegationControlServer } from "./delegation-control-server.js";
export { installDelegationSkills, CODEXHOST_DELEGATION_SKILL } from "./delegation-skill.js";
export {
  DELEGATION_CLI_PATH_ENV,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
} from "./delegation-types.js";
export type {
  DelegationControlApi,
  DelegationStartInput,
  DelegationStartResult,
  DelegationThreadListResult,
  DelegationThreadSnapshot,
  ThreadListInput,
  ThreadReadInput,
  ThreadWaitInput,
} from "./delegation-types.js";
export { hasLauncherManagedUpdateRuntime, runHostRuntime } from "./run-host-runtime.js";
export { runClaudeAquaHarnessBroker } from "./aqua-harness-broker.js";
export {
  REMOTE_CONTROL_BRIDGE_DESCRIPTOR_FILE,
  createRemoteControlAppServerPlan,
  publishRemoteControlAppServerDescriptor,
  remoteControlBridgeDescriptorPath,
  remoteControlBridgePipePath,
  runRemoteControlAppServerBridge,
} from "./remote-control-app-server.js";
export type {
  RemoteControlAppServerDescriptorV1,
  RemoteControlAppServerPlan,
} from "./remote-control-app-server.js";
export { runRemoteHostCli } from "./remote-host-cli.js";
export {
  inspectRemoteHostInstallation,
  installRemoteHost,
  uninstallRemoteHost,
} from "./remote-host-install.js";
export type {
  RemoteHostInstallationStatus,
  RemoteHostInstallOptions,
  RemoteHostManifestV1,
} from "./remote-host-install.js";
export {
  classifyRemoteHostProbeResponse,
  inspectRemoteHost,
  startRemoteHost,
  stopRemoteHost,
} from "./remote-host-lifecycle.js";
export type {
  RemoteHostLifecycleResult,
  RemoteHostRuntimeStatus,
  RemoteHostStatus,
} from "./remote-host-lifecycle.js";
export { createHostUpdateCoordinator } from "./update-coordinator.js";
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
    codeBuddyAdapter.name,
    deepSeekHarnessAdapter.name,
    desktopControl.name,
    harnessAdapter.name,
    harnessBroker.name,
    grokAdapter.name,
    mappingStore.name,
    piAdapter.name,
    ompAdapter.name,
    openCodeAdapter.name,
    sharedContracts.name,
    updateManager.name,
  ],
} as const;
