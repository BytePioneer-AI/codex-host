import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";

import { resolveCodexStartupCatalogConfig } from "./codex-config-overrides.js";
import { extendModelCatalog, readBundledModelCatalog } from "./codex-model-catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Catalogs are session-static in Codex. Prepare both tiers before starting the local backend. */
export async function prepareCodexServiceTierCatalog(input: {
  codexHome: string;
  stockCodexPath: string;
  arguments: readonly string[];
}): Promise<{ arguments: string[]; available: boolean }> {
  const unchanged = { arguments: [...input.arguments], available: false };
  try {
    let config: Record<string, unknown> = {};
    try {
      config = parse(await readFile(path.join(input.codexHome, "config.toml"), "utf8"));
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) throw error;
    }
    const resolved = resolveCodexStartupCatalogConfig(config, input.arguments);
    const provider = resolved.model_provider;
    // Official OpenAI accounts keep their original catalog and native tier controls.
    if (typeof provider !== "string" || provider === "openai") {
      return unchanged;
    }
    const sourcePath = resolved.model_catalog_json;
    const catalog =
      typeof sourcePath === "string"
        ? extendModelCatalog(await readFile(path.resolve(input.codexHome, sourcePath), "utf8"))
        : readBundledModelCatalog(input.stockCodexPath);
    const hash = createHash("sha256").update(catalog.json).digest("hex");
    const directory = path.join(input.codexHome, "codexhost", "service-tier-catalogs");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${hash}.json`);
    try {
      await writeFile(file, catalog.json, { flag: "wx" });
    } catch (error) {
      if (!(isRecord(error) && error.code === "EEXIST")) throw error;
    }
    return {
      arguments: [...input.arguments, "-c", `model_catalog_json=${JSON.stringify(file)}`],
      available: true,
    };
  } catch {
    // Unsupported catalogs must not prevent the native backend from starting.
    return unchanged;
  }
}
