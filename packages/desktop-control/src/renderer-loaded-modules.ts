/** CDP's parsed ES modules are the allowlist for native-service imports. Import
 * edges and modulepreload hints alone do not prove a lazy chunk has been loaded.
 */
export interface RendererModuleCdpClient {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_MODULES = 4096;

export function nativeModuleCatalogExpression(
  urls: readonly string[],
  complete: boolean,
  owner: string,
): string {
  return `Object.defineProperty(globalThis, '__codexhostLoadedModulesV1', {
    configurable: true,
    value: Object.freeze({ owner: ${JSON.stringify(owner)}, documentUrl: location.href, complete: ${complete}, urls: Object.freeze(${JSON.stringify(urls)}) })
  }); void 0`;
}

/** Subscribe before enabling Debugger: enable replays scripts already loaded in
 * each execution context, then scriptParsed keeps the catalog current for lazy UI.
 * Publish into that context only; never mix iframe/isolated-world module registries.
 */
export async function installRendererLoadedModules(
  renderer: RendererModuleCdpClient,
): Promise<() => void> {
  const owner = crypto.randomUUID();
  const contexts = new Map<string, { urls: Set<string>; complete: boolean }>();
  const contextIds = new Map<number, string>();
  const dirty = new Set<string>();
  let ready = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishing = Promise.resolve();
  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const pending = [...dirty];
    dirty.clear();
    publishing = publishing
      .catch(() => undefined)
      .then(async () => {
        for (const uniqueId of pending) {
          const context = contexts.get(uniqueId);
          if (!context || disposed) continue;
          const response = await renderer.command("Runtime.evaluate", {
            expression: nativeModuleCatalogExpression([...context.urls], context.complete, owner),
            uniqueContextId: uniqueId,
          });
          if (record(response) && record(response.exceptionDetails))
            throw new Error("Loaded Renderer module catalog publication failed");
        }
      });
    return publishing;
  };
  const schedule = (uniqueId: string) => {
    dirty.add(uniqueId);
    if (ready && timer === undefined)
      timer = setTimeout(() => {
        void flush().catch((error: unknown) => {
          console.error("Could not publish loaded Renderer modules", error);
        });
      }, 10);
  };
  const remove = (id: number) => {
    const uniqueId = contextIds.get(id);
    contextIds.delete(id);
    if (uniqueId) {
      contexts.delete(uniqueId);
      dirty.delete(uniqueId);
    }
  };
  const listeners = [
    renderer.on("Runtime.executionContextCreated", (params) => {
      const context = record(params) ? params.context : null;
      if (
        !record(context) ||
        typeof context.id !== "number" ||
        typeof context.uniqueId !== "string" ||
        !record(context.auxData) ||
        context.auxData.isDefault !== true
      )
        return;
      contextIds.set(context.id, context.uniqueId);
      contexts.set(context.uniqueId, { urls: new Set(), complete: true });
      schedule(context.uniqueId);
    }),
    renderer.on("Runtime.executionContextDestroyed", (params) => {
      if (record(params) && typeof params.executionContextId === "number")
        remove(params.executionContextId);
    }),
    renderer.on("Runtime.executionContextsCleared", () => {
      contextIds.clear();
      contexts.clear();
      dirty.clear();
    }),
    renderer.on("Debugger.scriptParsed", (params) => {
      if (
        !record(params) ||
        params.isModule !== true ||
        params.hasSourceURL === true ||
        typeof params.url !== "string" ||
        typeof params.executionContextId !== "number"
      )
        return;
      const uniqueId = contextIds.get(params.executionContextId);
      const context = uniqueId ? contexts.get(uniqueId) : null;
      if (!context || !uniqueId || context.urls.has(params.url)) return;
      if (context.urls.size >= MAX_MODULES) context.complete = false;
      else context.urls.add(params.url);
      schedule(uniqueId);
    }),
  ];
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    for (const unsubscribe of listeners) unsubscribe();
    // A detached Controller cannot certify future imports. Keep discovery closed
    // rather than leaving an apparently complete but stale allowlist behind.
    for (const uniqueId of contexts.keys())
      void renderer
        .command("Runtime.evaluate", {
          expression: `if (globalThis.__codexhostLoadedModulesV1 === undefined || globalThis.__codexhostLoadedModulesV1?.owner === ${JSON.stringify(owner)}) { ${nativeModuleCatalogExpression([], false, owner)} }`,
          uniqueContextId: uniqueId,
        })
        .catch(() => undefined);
    contexts.clear();
    contextIds.clear();
    dirty.clear();
  };
  try {
    await renderer.command("Runtime.enable");
    await renderer.command("Debugger.enable");
    ready = true;
    await flush();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
