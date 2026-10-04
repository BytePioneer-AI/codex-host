import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";

import { resolveCodexStartupCatalogConfig } from "./codex-config-overrides.js";
import { extendModelCatalog, readBundledModelCatalog } from "./codex-model-catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `-c key=value` splits at the first `=` and trims each `.`-separated key segment, so a
 * legacy profile name is safe as one key segment only when it round-trips exactly.
 */
function isSingleKeySegment(profile: string): boolean {
  return (
    profile.length > 0 &&
    profile === profile.trim() &&
    !profile.includes(".") &&
    !profile.includes("=")
  );
}

/**
 * Only a complete catalog matching `contents` may be published or reused; a failed
 * publication leaves the existing target intact and reports failure to the caller.
 */
async function publishIfNeeded(file: string, contents: string): Promise<void> {
  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) throw error;
  }
  if (existing === contents) return;
  const temporaryDirectory = await mkdtemp(`${file}.`);
  try {
    const temporary = path.join(temporaryDirectory, path.basename(file));
    await writeFile(temporary, contents);
    try {
      await rename(temporary, file);
    } catch (error) {
      // A concurrent publish may have completed the exact target first; nothing else is safe
      // to assume, and the existing target is never removed.
      if ((await readFile(file, "utf8").catch(() => null)) !== contents) throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
    const profile = resolved.catalogProfileName;
    // A name that cannot be one `-c` key segment would silently retarget the override.
    if (profile !== undefined && !isSingleKeySegment(profile)) {
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
    await publishIfNeeded(file, catalog.json);
    const value = JSON.stringify(file);
    return {
      arguments: [
        ...input.arguments,
        "-c",
        `model_catalog_json=${value}`,
        // A selected legacy profile that declares its own catalog overrides the root layer.
        ...(profile === undefined ? [] : ["-c", `profiles.${profile}.model_catalog_json=${value}`]),
      ],
      available: true,
    };
  } catch {
    // Unsupported catalogs must not prevent the native backend from starting.
    return unchanged;
  }
}
