/** Desktop symbols are private and renamed on release. Match their contracts
 * and caller relationships, never a minified name or an asset content hash. */
export function nativeManagerDependencies(factoryName: string, callers: readonly string[]) {
  const identifier = "[$A-Z_a-z][$\\w]*";
  const escaped = factoryName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `${escaped}\\((${identifier}),(${identifier}),\\1\\.get\\((${identifier}),\\2\\),(${identifier})\\.bind\\(null,\\1\\),\\((${identifier}),(${identifier})\\)=>\\5\\((${identifier}),\\6\\)\\)`,
  );
  const matches = callers.flatMap((source) => {
    const match = pattern.exec(source);
    return match?.[3] && match[4] && match[7]
      ? [
          {
            requestDefinition: match[3],
            isHostForConversation: match[4],
            imageDefinition: match[7],
          },
        ]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function nativeRpcRole(
  source: string,
): "createManager" | "Manager" | "RpcManager" | "createController" | undefined {
  if (
    ["dispatchMessageFromView", "threadProjectAssignments", "queuedMessageCoordination"].every(
      (part) => source.includes(part),
    )
  )
    return "createManager";
  if (
    ["collectAppStateSnapshot", "getReviewPaneSnapshotMetrics", "registerReplayAdmission"].every(
      (part) => source.includes(part),
    )
  )
    return "createController";
  if (
    ["getWorkInProgress", "getCachedThreadSearchSnapshot", "registerReplayAdmission"].every(
      (part) => source.includes(part),
    )
  )
    return "RpcManager";
  if (
    ["prewarmedThreadManager", "onNotification", "dispatchAppServerResponse"].every((part) =>
      source.includes(part),
    )
  )
    return "Manager";
  return undefined;
}

/** RPC proxies accept arbitrary property reads; only own data distinguishes a
 * real scope/service/controller from a synthetically callable remote member. */
export function nativeRpcObjectShape(value: unknown) {
  if (value === null || typeof value !== "object")
    return { scope: false, services: false, controller: false };
  const candidate = value as Record<string, unknown>;
  const own = (keys: string[]) => keys.every((key) => Object.hasOwn(candidate, key));
  const methods = (keys: string[]) => keys.every((key) => typeof candidate[key] === "function");
  return {
    scope: own(["node", "scope", "get", "set", "watch"]) && methods(["get", "set", "watch"]),
    services:
      own(["appServerManagers", "remoteConnections", "applicationMenu"]) &&
      typeof (candidate.appServerManagers as { subscribe?: unknown } | undefined)?.subscribe ===
        "function",
    controller:
      own(["forHost", "collectAppStateSnapshot", "getReviewPaneSnapshotMetrics", "dispose"]) &&
      methods(["forHost", "collectAppStateSnapshot", "getReviewPaneSnapshotMetrics", "dispose"]),
  };
}

interface RemoteObject {
  objectId?: string;
  type?: string;
  description?: string;
  value?: unknown;
}
interface Property {
  name: string;
  value?: RemoteObject;
}
interface Properties {
  result: Property[];
  internalProperties?: Property[];
}
interface Evaluation {
  result: RemoteObject;
  exceptionDetails?: unknown;
}
interface DiscoveryClient {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** All object handles share one CDP group/default Realm. The caller installs
 * before release; nothing gets published when discovery is missing/ambiguous. */
export async function withNativeRpcComponents(
  client: DiscoveryClient,
  install: (objectId: string) => Promise<boolean>,
): Promise<boolean> {
  const group = `codexhost-native-rpc-${crypto.randomUUID()}`;
  const command = async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    client.command(method, params) as Promise<T>;
  const evaluate = (expression: string) =>
    command<Evaluation>("Runtime.evaluate", { expression, awaitPromise: true, objectGroup: group });
  const properties = (objectId: string) =>
    command<Properties>("Runtime.getProperties", { objectId, ownProperties: true });
  const call = (
    objectId: string,
    functionDeclaration: string,
    args: { value?: unknown; objectId?: string }[] = [],
  ) =>
    command<Evaluation>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args,
      objectGroup: group,
      returnByValue: true,
    });
  try {
    const initial = await evaluate(String.raw`(() => {
      const catalog = globalThis.__codexhostLoadedModulesV1;
      if (!catalog?.complete || catalog.documentUrl !== location.href) return null;
      const urls = catalog.urls.filter(url => /^app:\/\/-\/assets\/(?:renderer-app-server-managers|app-shared)-[^/]+\.js$/.test(url));
      return { document, urls };
    })()`);
    if (!initial.result.objectId) return false;
    const holder = initial.result.objectId;
    const catalog = await call(holder, "function(){return this.urls}");
    const urls = catalog.result.value;
    if (!Array.isArray(urls) || urls.length !== 2) return false;
    const managerUrl = urls.find((url: string) => url.includes("renderer-app-server-managers"));
    const sharedUrl = urls.find((url: string) => url.includes("app-shared"));
    if (!managerUrl || !sharedUrl) return false;
    const attach = async (name: string, objectId: string) => {
      const result = await call(
        holder,
        "function(name,value){if(this.document!==document)throw Error('Renderer Realm changed');this[name]=value;return true}",
        [{ value: name }, { objectId }],
      );
      if (result.exceptionDetails) throw new Error("Native RPC discovery lost its Renderer Realm");
    };
    const imported = await evaluate(`import(${JSON.stringify(managerUrl)})`);
    if (!imported.result.objectId) return false;
    const exports = (await properties(imported.result.objectId)).result.filter(
      (entry) => entry.value?.type === "function",
    );
    let bindings: Property[] = [];
    for (const entry of exports.slice(0, 3)) {
      if (!entry.value?.objectId) continue;
      const scopes = (await properties(entry.value.objectId)).internalProperties?.find(
        (entry) => entry.name === "[[Scopes]]",
      )?.value?.objectId;
      if (!scopes) continue;
      const modules = (await properties(scopes)).result.filter(
        (entry) => entry.value?.description?.startsWith("Module") && entry.value.objectId,
      );
      const moduleId = modules[0]?.value?.objectId;
      if (modules.length !== 1 || !moduleId) continue;
      bindings = (await properties(moduleId)).result;
      break;
    }
    const functions = bindings.filter((entry) => entry.value?.type === "function");
    const roles = new Map<string, Property[]>();
    for (const entry of functions) {
      const role = nativeRpcRole(entry.value?.description ?? "");
      if (role) roles.set(role, [...(roles.get(role) ?? []), entry]);
    }
    if (
      ["createManager", "Manager", "RpcManager", "createController"].some(
        (role) => roles.get(role)?.length !== 1,
      )
    )
      return false;
    const factory = roles.get("createManager")?.[0];
    if (!factory) return false;
    const dependencies = nativeManagerDependencies(
      factory.name,
      functions.map((entry) => entry.value?.description ?? ""),
    );
    if (!dependencies) return false;
    for (const [role, entries] of roles) {
      const id = entries[0]?.value?.objectId;
      if (!id) return false;
      await attach(role, id);
    }
    for (const [role, name] of Object.entries(dependencies)) {
      const value = bindings.find((entry) => entry.name === name)?.value?.objectId;
      if (!value) return false;
      await attach(role, value);
    }
    const shared = await evaluate(`import(${JSON.stringify(sharedUrl)})`);
    if (!shared.result.objectId) return false;
    const sharedExports = (await properties(shared.result.objectId)).result;
    const sessions = sharedExports.filter(
      (entry) =>
        entry.value?.type === "function" &&
        ["getRemoteMain", "getStats", "drain", "getMainImport"].every((word) =>
          entry.value?.description?.includes(word),
        ),
    );
    const sessionId = sessions[0]?.value?.objectId;
    if (sessions.length !== 1 || !sessionId) return false;
    await attach("RpcSession", sessionId);
    const serviceMatches = await command<Evaluation>("Runtime.callFunctionOn", {
      objectId: shared.result.objectId,
      functionDeclaration: `function(){return [...new Set(Object.values(this).filter(value => (${nativeRpcObjectShape.toString()})(value).services))]}`,
      objectGroup: group,
    });
    if (!serviceMatches.result.objectId) return false;
    const services = (await properties(serviceMatches.result.objectId)).result.flatMap((entry) =>
      entry.value?.type === "object" && entry.value.objectId ? [entry.value.objectId] : [],
    );
    const serviceId = services[0];
    if (services.length !== 1 || !serviceId) return false;
    await attach("services", serviceId);
    // Query only async functions in this Realm; inspect only the small closures
    // of Desktop's snapshot method, never the large application module scope.
    const prototype = await evaluate("Object.getPrototypeOf(async function(){})");
    if (!prototype.result.objectId) return false;
    const objects = await command<{ objects: RemoteObject }>("Runtime.queryObjects", {
      prototypeObjectId: prototype.result.objectId,
      objectGroup: group,
    });
    if (!objects.objects.objectId) return false;
    const filtered = await command<Evaluation>("Runtime.callFunctionOn", {
      objectId: objects.objects.objectId,
      functionDeclaration:
        'function(){return this.filter(fn=>fn.name==="collectAppStateSnapshot"&&String(fn).includes("collectSnapshot")).slice(0,9)}',
      objectGroup: group,
    });
    if (!filtered.result.objectId) return false;
    const snapshots = (await properties(filtered.result.objectId)).result.filter(
      (entry) => entry.value?.type === "function",
    );
    if (snapshots.length > 8) return false;
    const owners: { controller: string; scope: string }[] = [];
    for (const snapshot of snapshots) {
      const fn = snapshot.value?.objectId;
      if (!fn) continue;
      const scopes = (await properties(fn)).internalProperties?.find(
        (entry) => entry.name === "[[Scopes]]",
      )?.value?.objectId;
      if (!scopes) continue;
      for (const scope of (await properties(scopes)).result) {
        if (!scope.value?.description?.startsWith("Closure") || !scope.value.objectId) continue;
        const candidates = (await properties(scope.value.objectId)).result;
        const controllers: string[] = [],
          handles: string[] = [];
        for (const binding of candidates) {
          if (binding.value?.type !== "object" || !binding.value.objectId) continue;
          const id = binding.value.objectId;
          const response = await call(
            id,
            `function(){return (${nativeRpcObjectShape.toString()})(this)}`,
          );
          const shape = response.result.value as
            ReturnType<typeof nativeRpcObjectShape> | undefined;
          if (shape?.scope) handles.push(id);
          if (
            shape?.controller &&
            (
              await call(id, "function(fn){return this.collectAppStateSnapshot===fn}", [
                { objectId: fn },
              ])
            ).result.value === true
          )
            controllers.push(id);
        }
        const controller = controllers[0],
          handle = handles[0];
        if (controllers.length === 1 && handles.length === 1 && controller && handle)
          owners.push({ controller, scope: handle });
      }
    }
    const owner = owners[0];
    if (owners.length !== 1 || !owner) return false;
    await attach("controller", owner.controller);
    await attach("scope", owner.scope);
    return await install(holder);
  } finally {
    await client
      .command("Runtime.releaseObjectGroup", { objectGroup: group })
      .catch(() => undefined);
  }
}
