import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm, type FileHandle } from "node:fs/promises";

import {
  hostThreadIdSchema,
  threadHandoffMetadataSchema,
  type HostThreadId,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";
import { z } from "zod";

/**
 * Cross-Harness handoff metadata keyed by the derived target Thread ID.
 *
 * Stored separately from External Thread records so both official Codex and External
 * Harness targets persist handoff provenance uniformly across restarts.
 */

export const storedThreadHandoffV1Schema = z
  .object({
    targetThreadId: hostThreadIdSchema,
    handoff: threadHandoffMetadataSchema,
  })
  .strict();

export type StoredThreadHandoffV1 = z.infer<typeof storedThreadHandoffV1Schema>;

const storedThreadHandoffsFileV1Schema = z
  .object({
    formatVersion: z.literal(1),
    handoffs: z.array(storedThreadHandoffV1Schema),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of file.handoffs.entries()) {
      if (seen.has(entry.targetThreadId)) {
        context.addIssue({
          code: "custom",
          path: ["handoffs", index, "targetThreadId"],
          message: "A Thread can have only one handoff record",
        });
      }
      seen.add(entry.targetThreadId);
    }
  });

export function parseThreadHandoffs(value: unknown): StoredThreadHandoffV1[] {
  return storedThreadHandoffsFileV1Schema.parse(value).handoffs as StoredThreadHandoffV1[];
}

export async function readThreadHandoffsFile(
  file: string,
): Promise<Map<HostThreadId, ThreadHandoffMetadata>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return new Map();
    throw error;
  }
  const entries = parseThreadHandoffs(JSON.parse(text));
  return new Map(entries.map(({ targetThreadId, handoff }) => [targetThreadId, handoff] as const));
}

export async function writeThreadHandoffsFile(
  file: string,
  handoffs: ReadonlyMap<HostThreadId, ThreadHandoffMetadata>,
): Promise<Map<HostThreadId, ThreadHandoffMetadata>> {
  const list: StoredThreadHandoffV1[] = [...handoffs.entries()].map(
    ([targetThreadId, handoff]) => ({ targetThreadId, handoff }),
  );
  const parsed = parseThreadHandoffs({ formatVersion: 1, handoffs: list });
  const temp = `${file}.tmp-${randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
    await handle.writeFile(
      `${JSON.stringify({ formatVersion: 1, handoffs: parsed }, null, 2)}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    return new Map(parsed.map(({ targetThreadId, handoff }) => [targetThreadId, handoff] as const));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
