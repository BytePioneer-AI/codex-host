import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native UI text only: never treat a label as a historical model ID or a pricing alias. */
export async function readQoderModelLabels(
  configDirectory: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  signal.throwIfAborted();
  try {
    const file = path.join(configDirectory, ".auth", "dynamic-texts.json");
    if ((await stat(file)).size > 1024 * 1024) return {};
    const data: unknown = JSON.parse(await readFile(file, { encoding: "utf8", signal }));
    if (!record(data) || !record(data.locales)) return {};
    const labels = new Map<string, string>();
    // Prefer a stable English model name, with the other native locale as a fallback.
    for (const locale of ["zh-CN", "en"]) {
      const texts = data.locales[locale];
      if (!record(texts)) continue;
      for (const [key, value] of Object.entries(texts)) {
        const prefix = "modelSelector.item.";
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (!id || id.length > 512 || /\.(description|markdownDescription)(\.|$)/u.test(id))
          continue;
        if (typeof value !== "string" || !value.trim() || value.trim().length > 512) continue;
        labels.set(id, value.trim());
      }
    }
    return Object.fromEntries(labels);
  } catch {
    signal.throwIfAborted();
    // Metadata is optional. Missing, unreadable or partially written text files do not hide usage.
    return {};
  }
}
