import { loadCodexNativeServices } from "./codex-native-services.js";

interface NativeThreadCatalogServices {
  localThreadCatalog: {
    invalidateSource(hostId: "local"): Promise<unknown>;
  };
}

function isThreadCatalogServices(value: unknown): value is NativeThreadCatalogServices {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "localThreadCatalog")
  )
    return false;
  // The registry owns the service; the service itself may be a callable RPC proxy.
  const catalog = (value as NativeThreadCatalogServices).localThreadCatalog;
  return catalog != null && typeof catalog.invalidateSource === "function";
}

function withCachedAppServices(module: Record<string, unknown>): Record<string, unknown> {
  const runtime = module.__webpack_require__;
  if (typeof runtime !== "function") return module;
  const cache: unknown = Reflect.get(runtime, "c");
  if (typeof cache !== "object" || cache === null) return module;
  const candidates = { ...module };
  // Rspack exposes already-executed modules through its cache. Never call the
  // runtime or its factories to discover a service that has not been loaded.
  for (const [id, entry] of Object.entries(cache)) {
    try {
      if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "exports")) continue;
      const exports: unknown = Reflect.get(entry, "exports");
      if (typeof exports !== "object" || exports === null || !Object.hasOwn(exports, "appServices"))
        continue;
      const services: unknown = Reflect.get(exports, "appServices");
      if (isThreadCatalogServices(services)) candidates[`cached:${id}`] = services;
    } catch {
      // Unrelated cached modules may export inaccessible cross-origin objects.
    }
  }
  return candidates;
}

/** Ask an available Desktop directory to discover native Threads once. */
export async function invalidateThreadCatalog(
  ownerWindow: Window = window,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<void> {
  try {
    const services = await loadCodexNativeServices(
      ownerWindow,
      isThreadCatalogServices,
      async (url) => withCachedAppServices(await importModule(url)),
    );
    await services?.localThreadCatalog.invalidateSource("local");
  } catch {
    // Desktop directory availability does not affect a persisted native Thread.
  }
}
