import { createHash, type Hash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

async function hashDirectory(root: string, hash: Hash, relative = ""): Promise<void> {
  for (const name of (await readdir(join(root, relative))).sort()) {
    const file = join(relative, name);
    const metadata = await stat(join(root, file));
    hash.update(JSON.stringify([file, metadata.mode & 0o777, metadata.isDirectory()]));
    if (metadata.isDirectory()) await hashDirectory(root, hash, file);
    else {
      hash.update(String(metadata.size) + ":");
      hash.update(await readFile(join(root, file)));
    }
  }
}

/** Retain the Host's complete bundled payload independently of mutable Web build output. */
export async function snapshotPackagedHost(distribution: string, data: string): Promise<string> {
  const builds = join(data, "host-builds");
  await mkdir(builds, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(builds, ".preparing-"));
  try {
    await mkdir(join(staging, "app"));
    await cp(join(distribution, "app/host-runtime.mjs"), join(staging, "app/host-runtime.mjs"));
    for (const directory of ["native", "adapters"]) {
      await cp(join(distribution, directory), join(staging, directory), {
        recursive: true,
        dereference: true,
      });
    }
    const hash = createHash("sha256");
    await hashDirectory(staging, hash);
    const destination = join(builds, hash.digest("hex"));
    // Concurrent Web starts may publish identical payloads. Only complete directories
    // are visible, and existing builds are never overwritten or garbage-collected here.
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!(await stat(destination).catch(() => null))?.isDirectory()) throw error;
    }
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
