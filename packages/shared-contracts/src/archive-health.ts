import { z } from "zod";

export const archiveHealthInconsistentThreadSchema = z.strictObject({
  threadId: z.string(),
  title: z.string().nullable().optional(),
  harnessId: z.string().nullable().optional(),
  kind: z.enum(["external", "official"]),
  state: z.string(),
  reason: z.string(),
  occupyingPid: z.number().nullable().optional(),
  occupyingCommand: z.string().nullable().optional(),
  recoverable: z.boolean(),
  hint: z.string().nullable().optional(),
});

export type ArchiveHealthInconsistentThread = z.infer<typeof archiveHealthInconsistentThreadSchema>;

export const archiveHealthProcessSchema = z.strictObject({
  pid: z.number(),
  command: z.string(),
  hint: z.string(),
});

export type ArchiveHealthProcess = z.infer<typeof archiveHealthProcessSchema>;

export const archiveHealthParamsSchema = z.strictObject({
  includeOfficial: z.boolean().optional(),
});

export type ArchiveHealthParams = z.infer<typeof archiveHealthParamsSchema>;

export const archiveHealthResultSchema = z.strictObject({
  inconsistentThreads: z.array(archiveHealthInconsistentThreadSchema),
  officialProcesses: z.array(archiveHealthProcessSchema),
  summary: z.strictObject({
    totalInconsistent: z.number(),
    officialOccupied: z.number(),
    externalRecoverable: z.number(),
    /**
     * Whether the official-process scan actually ran. A failed scan must not read as
     * "no official sessions are occupied".
     */
    processScan: z.enum(["ok", "failed", "skipped"]),
  }),
});

export type ArchiveHealthResult = z.infer<typeof archiveHealthResultSchema>;

export const archiveForceParamsSchema = z.strictObject({
  threadId: z.string().trim().min(1),
});

export type ArchiveForceParams = z.infer<typeof archiveForceParamsSchema>;

export const archiveForceResultSchema = z.strictObject({
  ok: z.literal(true),
  threadId: z.string(),
  archived: z.literal(true),
});

export type ArchiveForceResult = z.infer<typeof archiveForceResultSchema>;
