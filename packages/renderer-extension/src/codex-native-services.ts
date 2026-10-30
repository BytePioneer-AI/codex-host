/** Discover native Renderer services exported by Desktop's preloaded ES modules. */
export async function loadCodexNativeServices<T>(
  ownerWindow: Window,
  matchesServices: (value: unknown) => value is T,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<T | null> {
  if (!ownerWindow.document || !ownerWindow.location) return null;
  const page = new URL(ownerWindow.location.href);
  const urls = new Set<string>();
  for (const link of ownerWindow.document.querySelectorAll('link[rel="modulepreload"][href]')) {
    const url = new URL(link.getAttribute("href") ?? "", page);
    if (
      url.protocol === page.protocol &&
      url.host === page.host &&
      url.pathname.endsWith(".js") &&
      !url.search &&
      !url.hash
    )
      urls.add(url.href);
  }
  // Load shared first, but verify uniqueness across all eligible preloads.
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
  return [...matches][0] ?? null;
}
