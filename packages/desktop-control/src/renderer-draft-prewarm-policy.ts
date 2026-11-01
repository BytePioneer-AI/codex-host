import type { CdpClient } from "./cdp-client.js";
import { committedReactAncestors } from "./renderer-react-ownership.js";
import { retainRendererHostResponses } from "./renderer-host-response-ownership.js";
import { createDraftPrewarmPolicyBridge } from "./renderer-draft-prewarm-runtime.js";
import { isolateRendererPrewarmConsumption } from "./renderer-prewarm-consumption.js";
import {
  discoverRendererHosts,
  requestManagerFromHookState,
  resolveRendererHostManager,
} from "./renderer-host-discovery.js";
import { installRendererHostRouting } from "./renderer-host-routing.js";
import {
  findRendererAppScopeStore,
  findRendererHostRpcFamily,
  rendererHostRpcHostIds,
  resolveRendererHostRpc,
} from "./renderer-host-rpc-discovery.js";
import { installRendererHostRpcRouting } from "./renderer-host-rpc-routing.js";

export { requestManagerFromHookState } from "./renderer-host-discovery.js";

interface InspectorEvaluator {
  evaluate<T>(expression: string): Promise<T>;
}

export interface RendererDraftPrewarmPolicyStatus {
  state: "ready";
  reason: "owned-request-bridge";
}

const REQUEST_MANAGER_WAIT_TIMEOUT_MS = 60_000;
const REQUEST_MANAGER_POLL_INTERVAL_MS = 25;

function directRendererInstaller(): string {
  return `(() => {
    const committedReactAncestors = ${committedReactAncestors.toString()};
    const requestManagerFromHookState = ${requestManagerFromHookState.toString()};
    const discoverRendererHosts = ${discoverRendererHosts.toString()};
    const resolveRendererHostManager = ${resolveRendererHostManager.toString()};
    const retainRendererHostResponses = ${retainRendererHostResponses.toString()};
    const createDraftPrewarmPolicyBridge = ${createDraftPrewarmPolicyBridge.toString()};
    const isolateRendererPrewarmConsumption = ${isolateRendererPrewarmConsumption.toString()};
    const discover = (root) =>
      discoverRendererHosts(root, committedReactAncestors, requestManagerFromHookState);
    const installNative = () => (${installRendererHostRouting.toString()})(
      document, window, discover,
      (discovery, hostId) => resolveRendererHostManager(discovery, hostId, requestManagerFromHookState),
      (manager, bridge, hostId, target, prewarmed, isCurrent) => createDraftPrewarmPolicyBridge(
        manager, bridge, hostId, target, prewarmed, isCurrent, retainRendererHostResponses,
        isolateRendererPrewarmConsumption,
      ),
    );
    const installRpc = () => typeof MessagePort !== 'function' ? null : (${installRendererHostRpcRouting.toString()})(document, window, {
      findStore: ${findRendererAppScopeStore.toString()},
      findFamily: ${findRendererHostRpcFamily.toString()},
      resolve: ${resolveRendererHostRpc.toString()},
      hostIds: ${rendererHostRpcHostIds.toString()},
      composerHostIds: (composer) => {
        const source = composer?.matches?.('[data-codex-composer], [contenteditable="true"][role="textbox"]')
          ? { querySelectorAll: () => [composer] }
          : (composer ?? document);
        return discover(source);
      },
      portPrototype: MessagePort.prototype,
    });
    const connected = (routing) => routing.forComposer() !== null ||
      ['local', ...(routing.knownHostIds?.() ?? [])].some((hostId) => routing.forHost(hostId) !== null);
    let nativeReady = false;
    // A legacy registry can remain mounted without a usable native manager.
    // Prefer a ready native route, then try the identified main-process RPC store.
    const routing = (() => {
      if (window.__codexhostHostRoutingV1) return window.__codexhostHostRoutingV1;
      const native = discover(document);
      if (native.managers.length || native.registries.length) {
        const routing = installNative();
        if (connected(routing)) {
          nativeReady = true;
          return routing;
        }
        routing.dispose();
      }
      const rpc = installRpc();
      if (rpc) return rpc;
      throw new Error('Renderer Host request manager is unavailable');
    })();
    // Publish a default draft policy only when its Host is unambiguous. Host
    // connections can be ready even when multiple Composers coexist.
    if (!nativeReady && !connected(routing)) throw new Error('Renderer Host request manager is unavailable');
    return { state: 'ready', reason: 'owned-request-bridge' };
  })()`;
}

function mainProcessInstaller(rendererWebContentsId: number): string {
  // Both transports evaluate the same browser implementation. Do not maintain a
  // second manager-discovery path through Inspector object IDs.
  return `(async () => {
    const mainModule = process.mainModule;
    const electron = mainModule != null && typeof mainModule.require === 'function'
      ? mainModule.require('electron')
      : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const contents = electron.webContents.fromId(${rendererWebContentsId});
    if (!contents || contents.isDestroyed() || contents.getType() !== 'window') {
      throw new Error('Owned Renderer is unavailable for draft prewarm policy');
    }
    return contents.executeJavaScript(${JSON.stringify(directRendererInstaller())});
  })()`;
}

async function waitForDraftPrewarmPolicy(
  evaluate: (expression: string) => Promise<unknown>,
  expression: string,
): Promise<RendererDraftPrewarmPolicyStatus> {
  const deadline = Date.now() + REQUEST_MANAGER_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      const value = await evaluate(expression);
      if (
        typeof value !== "object" ||
        value === null ||
        !("state" in value) ||
        value.state !== "ready" ||
        !("reason" in value) ||
        value.reason !== "owned-request-bridge"
      ) {
        throw new Error("Renderer draft prewarm policy returned an invalid status");
      }
      return { state: "ready", reason: "owned-request-bridge" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const remaining = deadline - Date.now();
      if (!message.includes("Renderer Host request manager is unavailable") || remaining <= 0)
        throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(REQUEST_MANAGER_POLL_INTERVAL_MS, remaining)),
      );
    }
  }
}

export function installRendererDraftPrewarmPolicyDirect(
  renderer: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
): Promise<RendererDraftPrewarmPolicyStatus> {
  return waitForDraftPrewarmPolicy(
    (expression) => renderer.evaluate<unknown>(expression),
    directRendererInstaller(),
  );
}

export async function installRendererDraftPrewarmPolicy(
  inspector: Pick<CdpClient, "evaluate"> | InspectorEvaluator,
  rendererWebContentsId: number,
): Promise<RendererDraftPrewarmPolicyStatus> {
  if (!Number.isInteger(rendererWebContentsId) || rendererWebContentsId <= 0)
    throw new Error("Renderer webContents ID must be a positive integer");
  return waitForDraftPrewarmPolicy(
    (expression) => inspector.evaluate<unknown>(expression),
    mainProcessInstaller(rendererWebContentsId),
  );
}
