import { nativeRpcObjectShape } from "./renderer-native-rpc-discovery.js";
import { findRendererAppScopeStore } from "./renderer-host-rpc-discovery.js";

interface Client {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
}
interface Remote {
  objectId?: string;
  type?: string;
  description?: string;
  value?: unknown;
}
interface Property {
  name: string;
  value?: Remote;
}
interface Properties {
  result: Property[];
  internalProperties?: Property[];
}
interface Evaluation {
  result: Remote;
  exceptionDetails?: unknown;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;
const retries = new WeakMap<Client, { attempts: number; nextAt: number }>();

/** The Controller reconciles every monitor tick and discovery walks the heap, so failures back
 * off. A failure keeps external submission gated and must not tear down the Renderer Session:
 * official Codex submission does not depend on this binding. */
export async function installRendererRpcSteeringDirect(
  client: Client,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    const needed = await client.evaluate<boolean>(`(() => {
      const steering = window.__codexhostRpcSteeringV1;
      if (steering && steering.controller.forHost === steering.forHost) return false;
      steering?.release();
      const routing=window.__codexhostHostRoutingV1;
      return ['local', ...(routing?.knownHostIds?.() ?? [])].some(id => routing?.forHost(id)?.manager.kind === 'main-process-rpc');
    })()`);
    if (!needed) return false;
    const retry = retries.get(client);
    if (retry && now() < retry.nextAt) return false;
    try {
      await discoverAndInstall(client);
      retries.delete(client);
      return true;
    } catch (error) {
      const attempts = (retry?.attempts ?? 0) + 1;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      retries.set(client, { attempts, nextAt: now() + delay });
      console.error(
        `codexhost native steering discovery failed (attempt ${attempts}):`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  } catch {
    return false;
  }
}

/** Locate the already-owned UI Controller through its snapshot closure. This
 * works across ES-module and bundler layouts without importing native code. */
async function discoverAndInstall(client: Client): Promise<void> {
  const group = `codexhost-rpc-steering-${crypto.randomUUID()}`;
  const command = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    client.command(method, params) as Promise<T>;
  const properties = (objectId: string) =>
    command<Properties>("Runtime.getProperties", { objectId, ownProperties: true });
  const call = (
    objectId: string,
    functionDeclaration: string,
    args: { objectId?: string }[] = [],
  ) =>
    command<Evaluation>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args,
      objectGroup: group,
      returnByValue: true,
    });
  try {
    const proto = await command<Evaluation>("Runtime.evaluate", {
      expression: "Object.getPrototypeOf(async function(){})",
      objectGroup: group,
    });
    if (!proto.result.objectId) throw new Error("Native RPC steering discovery is unavailable");
    const objects = await command<{ objects: Remote }>("Runtime.queryObjects", {
      prototypeObjectId: proto.result.objectId,
      objectGroup: group,
    });
    if (!objects.objects.objectId) throw new Error("Native RPC steering discovery is unavailable");
    const filtered = await command<Evaluation>("Runtime.callFunctionOn", {
      objectId: objects.objects.objectId,
      functionDeclaration:
        'function(){return this.filter(fn=>fn.name==="collectAppStateSnapshot"&&String(fn).includes("collectSnapshot")).slice(0,9)}',
      objectGroup: group,
    });
    if (!filtered.result.objectId) throw new Error("Native RPC Controller is unavailable");
    const snapshots = (await properties(filtered.result.objectId)).result.flatMap((entry) =>
      entry.value?.type === "function" && entry.value.objectId ? [entry.value.objectId] : [],
    );
    if (snapshots.length > 8) throw new Error("Native RPC Controller is ambiguous");
    const controllers: string[] = [];
    for (const snapshot of snapshots) {
      const scopes = (await properties(snapshot)).internalProperties?.find(
        (entry) => entry.name === "[[Scopes]]",
      )?.value?.objectId;
      if (!scopes) continue;
      for (const scope of (await properties(scopes)).result) {
        if (!scope.value?.objectId || !scope.value.description?.startsWith("Closure")) continue;
        const bindings = (await properties(scope.value.objectId)).result;
        const owners: string[] = [];
        let rootScope: string | undefined;
        for (const binding of bindings) {
          if (binding.value?.type !== "object" || !binding.value.objectId) continue;
          const id = binding.value.objectId;
          const result = await call(
            id,
            `function(){return (${nativeRpcObjectShape.toString()})(this)}`,
          );
          const shape = result.result.value as ReturnType<typeof nativeRpcObjectShape> | undefined;
          if (shape?.scope) rootScope = id;
          if (
            shape?.controller &&
            (
              await call(id, "function(fn){return this.collectAppStateSnapshot===fn}", [
                { objectId: snapshot },
              ])
            ).result.value === true
          )
            owners.push(id);
        }
        if (owners.length !== 1 || !rootScope) continue;
        // The Controller and scope must be native objects in this exact Realm.
        const root = await call(
          rootScope,
          `function(){let node=this.node;const seen=new Set();while(node?.parent&&!seen.has(node.parent)&&seen.size<100){seen.add(node);node=node.parent}return (${findRendererAppScopeStore.toString()})(document)===node}`,
        );
        if (root.result.value === true) controllers.push(owners[0] as string);
      }
    }
    if (controllers.length !== 1) throw new Error("Native RPC Controller is missing or ambiguous");
    const result = await call(
      controllers[0] as string,
      "function(){return window.__codexhostInstallRpcSteeringV1?.(this) === true}",
    );
    if (result.exceptionDetails || result.result.value !== true)
      throw new Error("Native RPC steering installation failed");
  } finally {
    await client
      .command("Runtime.releaseObjectGroup", { objectGroup: group })
      .catch(() => undefined);
  }
}
