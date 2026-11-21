import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  desktopExtensionConfigurationSchema,
  desktopExtensionIdSchema,
  type DesktopExtensionConfiguration,
} from "@codexhost/shared-contracts";
import {
  DESKTOP_EXTENSION_CONFIGURATION_LOCK,
  desktopExtensionsRoot,
  extensionFileMissing,
  privateExtensionDirectory,
  readExtensionResource,
} from "./extension-discovery.js";

const CONFIG_FILE = "enabled.json";

export function missingDesktopExtensionConfiguration(error: unknown) {
  const configuration: DesktopExtensionConfiguration = { version: 1, revision: 0, enabled: [] };
  return extensionFileMissing(error)
    ? { configuration }
    : {
        configuration,
        diagnostic: `Invalid extension configuration: ${error instanceof Error ? error.message : String(error)}`,
      };
}

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
    return missingDesktopExtensionConfiguration(error);
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
  return withDesktopExtensionConfiguration(root, async ({ configuration, save }) => {
    if (expectedRevision !== undefined && expectedRevision !== configuration.revision)
      throw new DesktopExtensionRevisionConflict(configuration.revision);
    return save(await update(configuration));
  });
}

export async function withDesktopExtensionConfiguration<T>(
  root: string,
  operation: (locked: {
    directory: string;
    configuration: DesktopExtensionConfiguration;
    save(
      update: Pick<DesktopExtensionConfiguration, "enabled" | "reloadToken">,
    ): Promise<DesktopExtensionConfiguration>;
  }) => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await privateExtensionDirectory(root);
  return withDesktopExtensionDirectoryLock(directory, async (assertLocked) => {
    const { configuration } = await readDesktopExtensionConfiguration(directory);
    return operation({
      directory,
      configuration,
      async save(update) {
        const next = desktopExtensionConfigurationSchema.parse({
          ...configuration,
          ...update,
          revision: configuration.revision + 1,
        });
        const temporary = path.join(directory, `.enabled-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
          assertLocked();
          await rename(temporary, path.join(directory, CONFIG_FILE));
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        return next;
      },
    });
  });
}

/** Hold the same cross-process lock while reading a configuration and its package files. */
export async function withDesktopExtensionDirectoryLock<T>(
  directory: string,
  operation: (assertLocked: () => void) => Promise<T>,
): Promise<T> {
  let compromised: Error | undefined;
  const release = await lockfile.lock(directory, {
    lockfilePath: path.join(directory, DESKTOP_EXTENSION_CONFIGURATION_LOCK),
    retries: { retries: 24, minTimeout: 50, maxTimeout: 500 },
    onCompromised(error) {
      compromised = error;
    },
  });
  const assertLocked = () => {
    if (compromised) throw compromised;
  };
  try {
    const result = await operation(assertLocked);
    assertLocked();
    return result;
  } finally {
    if (!compromised) await release();
  }
}

export async function withDesktopExtensionInstallationDirectory<T>(
  dataDir: string,
  id: string,
  read: (directory: string) => Promise<T>,
): Promise<T> {
  desktopExtensionIdSchema.parse(id);
  const root = await privateExtensionDirectory(desktopExtensionsRoot(dataDir));
  return withDesktopExtensionDirectoryLock(root, async () =>
    read(await privateExtensionDirectory(path.join(root, id))),
  );
}

export function desktopExtensionDirectory(dataDir: string, id: string): Promise<string> {
  return withDesktopExtensionInstallationDirectory(dataDir, id, async (directory) => directory);
}
