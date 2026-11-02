import { withNativeRpcComponents } from "./renderer-native-rpc-discovery.js";
import { installNativeRpcRemoteControl } from "./renderer-native-rpc-runtime.js";
import { createNativeRemoteManager } from "./renderer-native-remote-manager.js";
import { createNativeRpcChannel } from "./renderer-native-rpc-channel.js";
import { createNativeRpcService } from "./renderer-native-rpc-service.js";
import { createDraftPrewarmPolicyBridge } from "./renderer-draft-prewarm-runtime.js";
import { retainRendererHostResponses } from "./renderer-host-response-ownership.js";
import { isolateRendererPrewarmConsumption } from "./renderer-prewarm-consumption.js";

interface RendererClient {
  evaluate<T>(expression: string): Promise<T>;
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Optional Desktop contract discovery runs once per loaded-module catalog.
 * A missing contract never prevents official Codex or SSH from becoming ready. */
export async function installNativeRpcRemoteControlDirect(
  renderer: RendererClient,
): Promise<boolean> {
  const attempt = await renderer.evaluate<string | null>(`(() => {
    if (window.__codexhostNativeRpcRemoteControlV1) return null;
    const routing = window.__codexhostHostRoutingV1;
    if (routing?.forHost('local')?.manager?.kind !== 'main-process-rpc') return null;
    const catalog = window.__codexhostLoadedModulesV1;
    if (!catalog?.complete) return null;
    const key = JSON.stringify(catalog.urls.filter(url => /renderer-app-server-managers|app-shared/.test(url)).sort());
    if (window.__codexhostNativeRpcDiscoveryV1?.key === key) return null;
    window.__codexhostNativeRpcDiscoveryV1 = { key, state: 'discovering' };
    return key;
  })()`);
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
      if (status?.key === ${JSON.stringify(attempt)}) status.state = ${JSON.stringify(installed ? "ready" : "unavailable")};
    })()`,
      )
      .catch(() => undefined);
  }
}
