/** Discover exports of loaded native ES modules. The Controller's CDP catalog
 * includes deep chunks without following or executing unloaded lazy imports.
 * Windows without a catalog retain the legacy modulepreload discovery path.
 */
export async function loadCodexNativeServices<T>(
  ownerWindow: Window,
  matchesServices: (value: unknown) => value is T,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<T | null> {
  if (!ownerWindow.document || !ownerWindow.location) return null;
  const page = new URL(ownerWindow.location.href);
  const urls = new Set<string>();
  const catalog: unknown = Reflect.get(ownerWindow, "__codexhostLoadedModulesV1");
  let sources: string[];
  if (catalog !== undefined) {
    if (
      typeof catalog !== "object" ||
      catalog === null ||
      !("complete" in catalog) ||
      catalog.complete !== true ||
      !("documentUrl" in catalog) ||
      catalog.documentUrl !== page.href ||
      !("urls" in catalog) ||
      !Array.isArray(catalog.urls) ||
      catalog.urls.length > 4096 ||
      catalog.urls.some((url) => typeof url !== "string")
    )
      throw new Error("Codex loaded module catalog is unavailable in this window");
    sources = catalog.urls as string[];
  } else {
    sources = [...ownerWindow.document.querySelectorAll('link[rel="modulepreload"][href]')].map(
      (link) => link.getAttribute("href") ?? "",
    );
  }
  for (const source of sources) {
    let url: URL;
    try {
      url = new URL(source, page);
    } catch {
      continue;
    }
    if (
      url.protocol === page.protocol &&
      url.host === page.host &&
      url.pathname.endsWith(".js") &&
      !url.search &&
      !url.hash
    )
      urls.add(url.href);
  }
  // Preserve legacy shared-first ordering; still check every eligible module.
  const candidates = [...urls].sort(
    (a, b) => Number(b.includes("/app-shared-")) - Number(a.includes("/app-shared-")),
  );
  const matches = new Set<T>();
  for (const url of candidates) {
    let module: Record<string, unknown>;
    try {
      module = await importModule(url);
    } catch {
      continue;
    }
    for (const value of Object.values(module).filter(matchesServices)) matches.add(value);
    if (matches.size > 1) throw new Error("Codex native services are unavailable in this window");
  }
  if (catalog !== undefined && Reflect.get(ownerWindow, "__codexhostLoadedModulesV1") !== catalog)
    throw new Error("Codex loaded module catalog changed during discovery. Try again once ready.");
  return [...matches][0] ?? null;
}
