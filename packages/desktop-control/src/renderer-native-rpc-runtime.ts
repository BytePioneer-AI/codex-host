import type { NativeRpcComponents, NativeRpcController } from "./renderer-native-rpc-contracts.js";
import type { RendererHostRouting } from "./renderer-host-routing.js";
import type {
  DraftPrewarmPolicyTarget,
  createDraftPrewarmPolicyBridge,
} from "./renderer-draft-prewarm-runtime.js";
import type { createNativeRemoteManager } from "./renderer-native-remote-manager.js";
import type { createNativeRpcChannel } from "./renderer-native-rpc-channel.js";
import type { createNativeRpcService } from "./renderer-native-rpc-service.js";
import type { retainNativeRpcInteractions } from "./renderer-native-rpc-interactions.js";

/** Reuse Desktop's controller for history, replay admission, subscriptions and
 * approvals. Replacing the published connection signal alone misses UI calls. */
export function installNativeRpcRemoteControl(
  components: NativeRpcComponents,
  target: DraftPrewarmPolicyTarget,
  dependencies: {
    createPolicy: typeof createDraftPrewarmPolicyBridge;
    createManager: typeof createNativeRemoteManager;
    createChannel: typeof createNativeRpcChannel;
    createService: typeof createNativeRpcService;
    retainInteractions: typeof retainNativeRpcInteractions;
  },
): boolean {
  if (target.__codexhostNativeRpcRemoteControlV1) return true;
  const routing = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
  if (!routing) return false;
  const adapted = dependencies.createService(components, (hostId, upstream) =>
    dependencies.createManager(
      components,
      hostId,
      upstream,
      target,
      dependencies.createPolicy,
      dependencies.createChannel,
      dependencies.retainInteractions,
    ),
  );
  const controller = components.controller;
  const originalHost = routing.forHost,
    originalComposer = routing.forComposer,
    originalDispose = routing.dispose;
  controller.dispose();
  let replacement: NativeRpcController;
  try {
    replacement = components.createController(components.scope, adapted.service);
  } catch (error) {
    replacement = components.createController(
      components.scope,
      components.services.appServerManagers,
    );
    throw error;
  } finally {
    adapted.service[Symbol.dispose]();
    controller.forHost = (hostId) => replacement.forHost(hostId);
    controller.collectAppStateSnapshot = (hostId, options) =>
      replacement.collectAppStateSnapshot(hostId, options);
    controller.getReviewPaneSnapshotMetrics = (hostId) =>
      replacement.getReviewPaneSnapshotMetrics(hostId);
    controller.dispose = () => replacement.dispose();
  }
  const forHost: RendererHostRouting["forHost"] = (hostId) => {
    const route = adapted.route(hostId);
    return route === undefined ? originalHost.call(routing, hostId) : route;
  };
  const forComposer: RendererHostRouting["forComposer"] = (composer) => {
    const hostId = routing.hostIdForComposer(composer);
    return hostId ? forHost(hostId) : originalComposer.call(routing, composer);
  };
  routing.forHost = forHost;
  routing.forComposer = forComposer;
  const installation = {
    dispose() {
      if (target.__codexhostNativeRpcRemoteControlV1 !== installation) return;
      delete target.__codexhostNativeRpcRemoteControlV1;
      replacement.dispose();
      replacement = components.createController(
        components.scope,
        components.services.appServerManagers,
      );
      if (routing.forHost === forHost) routing.forHost = originalHost;
      if (routing.forComposer === forComposer) routing.forComposer = originalComposer;
      routing.dispose = originalDispose;
    },
  };
  routing.dispose = () => {
    installation.dispose();
    originalDispose.call(routing);
  };
  target.__codexhostNativeRpcRemoteControlV1 = installation;
  return true;
}
