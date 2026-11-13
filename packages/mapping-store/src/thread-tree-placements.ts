import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { z } from "zod";

const threadId = z.string().min(1).max(1_024);
export const storedThreadTreePlacementV1Schema = z
  .object({
    hostThreadId: threadId,
    parentThreadId: threadId.nullable(),
    placedAt: z.string().datetime(),
  })
  .strict();
export type StoredThreadTreePlacementV1 = z.infer<typeof storedThreadTreePlacementV1Schema>;
const fileSchema = z
  .object({
    formatVersion: z.literal(1),
    placements: z.array(storedThreadTreePlacementV1Schema),
  })
  .strict()
  .refine(
    ({ placements }) =>
      new Set(placements.map((entry) => entry.hostThreadId)).size === placements.length,
    "A Thread can have only one tree placement",
  );

/** Presentation metadata never prevents access to Threads, including on older file versions. */
export async function readThreadTreePlacementsFile(
  file: string,
): Promise<StoredThreadTreePlacementV1[]> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(file, "utf8"))).placements;
  } catch {
    return [];
  }
}

export async function writeThreadTreePlacementsFile(
  file: string,
  placements: readonly StoredThreadTreePlacementV1[],
): Promise<StoredThreadTreePlacementV1[]> {
  const parsed = fileSchema.parse({ formatVersion: 1, placements });
  const temp = `${file}.tmp-${randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    return parsed.placements;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
