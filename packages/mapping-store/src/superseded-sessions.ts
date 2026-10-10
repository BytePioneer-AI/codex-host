import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { z } from "zod";

/**
 * Native Sessions a Thread used to point at before the Host replaced them.
 *
 * Editing or rolling back a message makes a Harness derive a new Native Session; the Thread then
 * points at the new one and the old one stays in native storage with no mapping. Without this
 * record it looks like a Session the user never brought into codexhost and is offered for import
 * as a duplicate of the Thread it came from.
 *
 * The file is separate from Thread records on purpose: an older codexhost ignores it instead of
 * quarantining Thread records that carry an unknown field.
 */

/** Oldest entries are dropped beyond this; a forgotten one only reappears as an import candidate. */
export const SUPERSEDED_SESSIONS_MAX = 20_000;

const storedSupersededSessionV1Schema = z
  .object({
    harnessId: harnessIdSchema,
    nativeSessionId: z.string().min(1).max(1_024),
    /** The Thread that moved on. Kept after the Thread is removed: nobody wants its old versions. */
    hostThreadId: hostThreadIdSchema,
    supersededAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Timestamp must be an ISO date",
    }),
  })
  .strict();

export type StoredSupersededSessionV1 = z.infer<typeof storedSupersededSessionV1Schema>;

const storedSupersededSessionsFileV1Schema = z
  .object({
    formatVersion: z.literal(1),
    /** Array order is insertion order; the oldest entries come first. */
    sessions: z.array(storedSupersededSessionV1Schema),
  })
  .strict();

export async function readSupersededSessionsFile(
  file: string,
): Promise<StoredSupersededSessionV1[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw error;
  }
  return storedSupersededSessionsFileV1Schema.parse(JSON.parse(text))
    .sessions as StoredSupersededSessionV1[];
}

export async function writeSupersededSessionsFile(
  file: string,
  sessions: readonly StoredSupersededSessionV1[],
): Promise<StoredSupersededSessionV1[]> {
  const parsed = storedSupersededSessionsFileV1Schema.parse({
    formatVersion: 1,
    sessions: sessions.slice(-SUPERSEDED_SESSIONS_MAX),
  }).sessions as StoredSupersededSessionV1[];
  const temp = `${file}.tmp-${randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
    await handle.writeFile(
      `${JSON.stringify({ formatVersion: 1, sessions: parsed }, null, 2)}\n`,
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
