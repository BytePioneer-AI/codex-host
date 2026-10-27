import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { machineIdSchema } from "@codexhost/shared-contracts";

export function hostDataDirectory(environment: NodeJS.ProcessEnv): string {
  return path.resolve(environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"));
}

/** Per-user Host installation identity. Publish atomically across concurrent Runtime starts. */
export async function loadHostIdentity(environment: NodeJS.ProcessEnv): Promise<string> {
  const directory = hostDataDirectory(environment);
  const filename = path.join(directory, "host-id");
  const read = async () => machineIdSchema.parse((await readFile(filename, "utf8")).trim());
  try {
    return await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const temporary = path.join(directory, `.host-id-${id}`);
  try {
    await writeFile(temporary, `${id}\n`, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await read();
  } finally {
    await rm(temporary, { force: true });
  }
}
