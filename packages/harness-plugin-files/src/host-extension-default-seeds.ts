import {
  hostExtensionDefaultSeedsSchema,
  hostExtensionIdSchema,
  type HostExtensionDefaultSeeds,
} from "@codexhost/shared-contracts";
import {
  hostExtensionsRoot,
  ifMissing,
  readHostFile,
  storeRoot,
  utf8,
  withHostExtensionWrite,
  writePrivateExtensionFile,
} from "./host-extension-io.js";

const DEFAULT_SEEDS_FILE = ".default-extensions.json";
const MAX_DEFAULT_SEEDS_BYTES = 32 * 1024;

const emptyDefaultSeeds = (): HostExtensionDefaultSeeds => ({ version: 1, seeded: [] });

async function readSeedsAt(root: string): Promise<HostExtensionDefaultSeeds> {
  return (
    (await ifMissing(async () =>
      hostExtensionDefaultSeedsSchema.parse(
        JSON.parse(
          utf8.decode(await readHostFile(root, DEFAULT_SEEDS_FILE, MAX_DEFAULT_SEEDS_BYTES)),
        ),
      ),
    )) ?? emptyDefaultSeeds()
  );
}

export async function readSeededDefaultHostExtensions(dataDir: string): Promise<string[]> {
  const root = await ifMissing(() => storeRoot(hostExtensionsRoot(dataDir), false));
  return root ? (await readSeedsAt(root)).seeded : [];
}

export async function markDefaultHostExtensionSeeded(
  dataDir: string,
  id: string,
): Promise<string[]> {
  const extensionId = hostExtensionIdSchema.parse(id);
  return withHostExtensionWrite(dataDir, async (root, assertLocked) => {
    const current = await readSeedsAt(root);
    if (current.seeded.includes(extensionId)) return current.seeded;
    const next = hostExtensionDefaultSeedsSchema.parse({
      version: 1,
      seeded: [...current.seeded, extensionId],
    });
    await writePrivateExtensionFile(root, DEFAULT_SEEDS_FILE, JSON.stringify(next), assertLocked);
    return next.seeded;
  });
}
