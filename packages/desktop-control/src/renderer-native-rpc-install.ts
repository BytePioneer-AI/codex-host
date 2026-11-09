import { withNativeRpcComponents } from "./renderer-native-rpc-discovery.js";
import { installNativeRpcRemoteControl } from "./renderer-native-rpc-runtime.js";
import { createNativeRemoteManager } from "./renderer-native-remote-manager.js";
import { createNativeRpcChannel } from "./renderer-native-rpc-channel.js";
import { createNativeRpcService } from "./renderer-native-rpc-service.js";
import { retainNativeRpcInteractions } from "./renderer-native-rpc-interactions.js";
import { createDraftPrewarmPolicyBridge } from "./renderer-draft-prewarm-runtime.js";
import { retainRendererHostResponses } from "./renderer-host-response-ownership.js";
import { isolateRendererPrewarmConsumption } from "./renderer-prewarm-consumption.js";

interface RendererClient {
  evaluate<T>(expression: string): Promise<T>;
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Optional discovery has a bounded retry budget per catalog/RPC owner.
 * A missing contract never prevents official Codex or SSH from becoming ready. */
export async function installNativeRpcRemoteControlDirect(
  renderer: RendererClient,
): Promise<boolean> {
  let attempt: string | null;
  const probeId = crypto.randomUUID();
  try {
    attempt = await renderer.evaluate<string | null>(`(() => {
    if (window.__codexhostNativeRpcRemoteControlV1) return null;
    const routing = window.__codexhostHostRoutingV1;
    const owner = routing?.forHost('local')?.manager;
    if (owner?.kind !== 'main-process-rpc') return null;
    const catalog = window.__codexhostLoadedModulesV1;
    if (!catalog?.complete) return null;
    const key = JSON.stringify([catalog.owner, catalog.urls.filter(url => /renderer-app-server-managers|app-shared/.test(url)).sort()]);
    const previous = window.__codexhostNativeRpcDiscoveryV1;
    const sameOwner = previous?.key === key && previous.owner === owner;
    if (sameOwner && (previous.state !== 'unavailable' || previous.attempts >= 3 || Date.now() < previous.nextRetryAt)) return null;
    const token = ${JSON.stringify(probeId)};
    window.__codexhostNativeRpcDiscoveryV1 = {
      key, owner, token, state: 'discovering', attempts: sameOwner ? previous.attempts + 1 : 1,
    };
    return token;
    })()`);
  } catch {
    return false;
  }
  if (attempt === null) return false;
  let installed = false;
  try {
    installed = await withNativeRpcComponents(renderer, async (objectId) => {
      const result = (await renderer.command("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          if (this.document !== document) return false;
          const retainRendererHostResponses = ${retainRendererHostResponses.toString()};
          const isolateRendererPrewarmConsumption = ${isolateRendererPrewarmConsumption.toString()};
          return (${installNativeRpcRemoteControl.toString()})(this, window, {
            createPolicy: ${createDraftPrewarmPolicyBridge.toString()},
            createManager: ${createNativeRemoteManager.toString()},
            createChannel: ${createNativeRpcChannel.toString()},
            createService: ${createNativeRpcService.toString()},
            retainInteractions: ${retainNativeRpcInteractions.toString()},
          });
        }`,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      return !result.exceptionDetails && result.result?.value === true;
    });
    return installed;
  } catch {
    return false;
  } finally {
    await renderer
      .evaluate(
        `(() => {
      const status = window.__codexhostNativeRpcDiscoveryV1;
      if (status?.token === ${JSON.stringify(attempt)}) {
        status.state = ${JSON.stringify(installed ? "ready" : "unavailable")};
        status.nextRetryAt = Date.now() + 5000 * 2 ** (status.attempts - 1);
      }
    })()`,
      )
      .catch(() => undefined);
  }
}
