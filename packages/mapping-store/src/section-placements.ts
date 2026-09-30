import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm, type FileHandle } from "node:fs/promises";

import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { z } from "zod";

/**
 * Section placements for External Threads (for example Codex Desktop's "Pinned" section).
 *
 * Official Threads keep their section and order in the official app-server. External
 * Threads have no official record, so the Host keeps their placement here. The file is
 * separate from Thread records on purpose: an older codexhost ignores it instead of
 * quarantining Thread records that carry an unknown field.
 */

const threadIdSchema = z.string().min(1).max(1_024);

export const storedThreadSectionSchema = z
  .object({
    id: threadIdSchema,
    name: z.string().max(4_096),
    // Mirrors the official ThreadSectionAppearance.
    appearance: z
      .object({ icon: z.string().nullable(), color: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

export type StoredThreadSection = z.infer<typeof storedThreadSectionSchema>;

export const storedSectionPlacementV1Schema = z
  .object({
    hostThreadId: hostThreadIdSchema,
    section: storedThreadSectionSchema,
    enteredAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Timestamp must be an ISO date",
    }),
    /** Thread (official or External) this one sits before; null places it last. */
    beforeThreadId: threadIdSchema.nullable(),
  })
  .strict();

export type StoredSectionPlacementV1 = z.infer<typeof storedSectionPlacementV1Schema>;

const storedSectionPlacementsFileV1Schema = z
  .object({
    formatVersion: z.literal(1),
    /** Array order is insertion order, which resolves Threads that share an anchor. */
    placements: z.array(storedSectionPlacementV1Schema),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    for (const [index, placement] of file.placements.entries()) {
      if (seen.has(placement.hostThreadId)) {
        context.addIssue({
          code: "custom",
          path: ["placements", index, "hostThreadId"],
          message: "A Thread can have only one section placement",
        });
      }
      seen.add(placement.hostThreadId);
    }
  });

export function parseSectionPlacements(value: unknown): StoredSectionPlacementV1[] {
  return storedSectionPlacementsFileV1Schema.parse(value).placements as StoredSectionPlacementV1[];
}

export async function readSectionPlacementsFile(file: string): Promise<StoredSectionPlacementV1[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw error;
  }
  return parseSectionPlacements(JSON.parse(text));
}

export async function writeSectionPlacementsFile(
  file: string,
  placements: readonly StoredSectionPlacementV1[],
): Promise<StoredSectionPlacementV1[]> {
  const parsed = parseSectionPlacements({ formatVersion: 1, placements });
  const temp = `${file}.tmp-${randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
    await handle.writeFile(
      `${JSON.stringify({ formatVersion: 1, placements: parsed }, null, 2)}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    return parsed;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
