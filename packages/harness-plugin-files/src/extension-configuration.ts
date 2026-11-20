import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  desktopExtensionConfigurationSchema,
  type DesktopExtensionConfiguration,
} from "@codexhost/shared-contracts";
import {
  DESKTOP_EXTENSION_CONFIGURATION_LOCK,
  extensionFileMissing,
  privateExtensionDirectory,
  readExtensionResource,
} from "./extension-discovery.js";

const CONFIG_FILE = "enabled.json";

export async function readDesktopExtensionConfiguration(
  root: string,
): Promise<{ configuration: DesktopExtensionConfiguration; diagnostic?: string }> {
  try {
    const directory = await privateExtensionDirectory(root);
    const bytes = await readExtensionResource(
      directory,
      CONFIG_FILE,
      DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
    );
    return {
      configuration: desktopExtensionConfigurationSchema.parse(JSON.parse(bytes.toString("utf8"))),
    };
  } catch (error) {
    return {
      configuration: { version: 1, revision: 0, enabled: [] },
      diagnostic: extensionFileMissing(error)
        ? "No extension configuration saved"
        : `Invalid extension configuration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export class DesktopExtensionRevisionConflict extends Error {
  constructor(readonly revision: number) {
    super("Extension selection changed; refresh and try again");
  }
}

/** Console and Host run in separate processes and share a revision and lock. */
export async function writeDesktopExtensionConfiguration(
  root: string,
  expectedRevision: number | undefined,
  update: (
    current: DesktopExtensionConfiguration,
  ) =>
    | Pick<DesktopExtensionConfiguration, "enabled" | "reloadToken">
    | Promise<Pick<DesktopExtensionConfiguration, "enabled" | "reloadToken">>,
): Promise<DesktopExtensionConfiguration> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await privateExtensionDirectory(root);
  let compromised: Error | undefined;
  const release = await lockfile.lock(directory, {
    lockfilePath: path.join(directory, DESKTOP_EXTENSION_CONFIGURATION_LOCK),
    retries: { retries: 24, minTimeout: 50, maxTimeout: 500 },
    onCompromised(error) {
      compromised = error;
    },
  });
  try {
    const { configuration } = await readDesktopExtensionConfiguration(directory);
    if (expectedRevision !== undefined && expectedRevision !== configuration.revision)
      throw new DesktopExtensionRevisionConflict(configuration.revision);
    const next = desktopExtensionConfigurationSchema.parse({
      ...configuration,
      ...(await update(configuration)),
      revision: configuration.revision + 1,
    });
    const temporary = path.join(directory, `.enabled-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
      if (compromised) throw compromised;
      await rename(temporary, path.join(directory, CONFIG_FILE));
    } finally {
      await rm(temporary, { force: true });
    }
    return next;
  } finally {
    if (!compromised) await release();
  }
}
