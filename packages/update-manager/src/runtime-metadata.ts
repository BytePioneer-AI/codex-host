import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDistributionMetadata } from "./distribution.js";
import { requireSemanticVersion } from "./status.js";

/** Runtime identity shared by Host status, update checks and the console. Version overrides
 * apply only to source checkouts; they do not turn a checkout into an npm installation. */
export async function readRuntimeMetadata(
  entryPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ version: string; distribution: "development" | "npm" | "installer" }> {
  const directory = path.dirname(entryPath);
  try {
    return parseDistributionMetadata(
      JSON.parse(await readFile(path.join(directory, "codexhost-distribution.json"), "utf8")),
    );
  } catch (error) {
    if (
      path.basename(directory) !== "dist" ||
      path.basename(path.resolve(directory, "../..")) !== "packages"
    )
      throw error;
    const workspace = JSON.parse(
      await readFile(path.resolve(directory, "../../../package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (workspace.name !== "codexhost" || typeof workspace.version !== "string") throw error;
    const workspaceVersion = requireSemanticVersion(workspace.version);
    const version =
      environment.CODEXHOST_DEV_VERSION === undefined
        ? `${workspaceVersion}-dev`
        : requireSemanticVersion(environment.CODEXHOST_DEV_VERSION);
    return { version, distribution: "development" };
  }
}
