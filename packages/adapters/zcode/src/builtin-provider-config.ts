import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** The parts of `zcode-builtin.json` the Adapter reads: its revision and the per-Provider rules. */
export const builtinProviderConfigSchema = z.object({
  revision: z.union([z.number(), z.string()]),
  config: z.object({
    providerConfigRules: z.object({
      providerRules: z.array(
        z.object({
          providerId: z.string().min(1),
          config: z.object({
            builtinModelIds: z.array(z.string()).optional(),
            access: z.object({ mode: z.string(), accountType: z.string() }).partial().optional(),
          }),
        }),
      ),
    }),
  }),
});

/** A numeric revision, or `undefined` when the file is missing or is not a builtin Provider config. */
async function readRevision(file: string): Promise<number | undefined> {
  let config: z.infer<typeof builtinProviderConfigSchema>;
  try {
    config = builtinProviderConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
  const revision = typeof config.revision === "number" ? config.revision : Number(config.revision);
  return Number.isFinite(revision) ? revision : undefined;
}

/**
 * Finds the builtin Provider config ZCode Desktop keeps for the installed App version when it is
 * newer than the file bundled in the App.
 *
 * Desktop refreshes the bundled config from its Endpoint into
 * `{dataRoot}/runtime/provider/<platform>/<App version>/endpoint-<key>/zcode-builtin.json` and
 * starts its CLI with that file, so a Model added after the App shipped exists only there. Among
 * the Endpoint files of the installed App version the highest revision wins. Returns `undefined`
 * when none is newer than the bundled file, leaving the bundled file in use.
 */
export async function resolveDesktopBuiltinProviderConfig(
  dataRoot: string,
  appVersion: string,
  bundledFile: string,
): Promise<string | undefined> {
  const bundledRevision = await readRevision(bundledFile);
  if (bundledRevision === undefined) return undefined;
  const providerRoot = path.join(dataRoot, "runtime", "provider");
  let newest: { revision: number; file: string } | undefined;
  for (const platform of await readdir(providerRoot).catch(() => [])) {
    const versionDirectory = path.join(providerRoot, platform, appVersion);
    for (const endpoint of (await readdir(versionDirectory).catch(() => [])).sort()) {
      if (!endpoint.startsWith("endpoint-")) continue;
      const file = path.join(versionDirectory, endpoint, "zcode-builtin.json");
      const revision = await readRevision(file);
      if (revision !== undefined && (!newest || revision > newest.revision)) {
        newest = { revision, file };
      }
    }
  }
  return newest && newest.revision > bundledRevision ? newest.file : undefined;
}
