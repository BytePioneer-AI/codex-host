import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  desktopExtensionConfigurationSchema,
  type DesktopExtensionConfiguration,
} from "@codexhost/shared-contracts";
import {
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

const pending = new Map<string, Promise<unknown>>();

/** Console is the only programmatic writer. Serialize the read/check/write transaction per root. */
export async function writeDesktopExtensionConfiguration(
  root: string,
  expectedRevision: number | undefined,
  update: (
    current: DesktopExtensionConfiguration,
  ) =>
    | Pick<DesktopExtensionConfiguration, "enabled" | "reloadToken">
    | Promise<Pick<DesktopExtensionConfiguration, "enabled" | "reloadToken">>,
): Promise<DesktopExtensionConfiguration> {
  const key = path.resolve(root);
  const operation = (pending.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await mkdir(key, { recursive: true, mode: 0o700 });
      const directory = await privateExtensionDirectory(key);
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
        await rename(temporary, path.join(directory, CONFIG_FILE));
      } finally {
        await rm(temporary, { force: true });
      }
      return next;
    });
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
}
