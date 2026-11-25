import { z } from "zod";
import { threadOwnershipSchema } from "./harness-models.js";
import { hostThreadIdSchema } from "./ids.js";
import { jsonObjectSchema } from "./json-value.js";

/** Host-owned, source-separated metadata pages for clients, including Desktop/CDP. */
export const THREAD_CATALOG_READ_METHOD = "codexhost/thread/catalog/read";
export const threadCatalogReadParamsSchema = z
  .object({
    includeArchived: z.boolean().optional(),
    /** Absent means first page; null means this branch is exhausted. Native cursors only. */
    officialCursor: z
      .object({ live: z.string().nullable(), archived: z.string().nullable().optional() })
      .strict()
      .optional(),
    /**
     * Keep reading native pages until one holds a Thread in `cwd` but outside every
     * `excludeCwds` folder, the branch ends, or a page bound is reached. Every row read is
     * returned, so the native cursors stay contiguous.
     */
    scope: z
      .union([
        z
          .object({
            cwd: z.string().min(1).max(4_096),
            excludeCwds: z.array(z.string().min(1).max(4_096)).max(1_024),
          })
          .strict(),
        z
          .object({
            projectId: z.string().min(1).max(1_024),
            legacyThreadIds: z.array(z.string().min(1).max(1_024)).max(1_024),
            /** Roots whose Threads without a project ID belong to this project, as on Desktop. */
            rootPaths: z.array(z.string().min(1).max(4_096)).max(1_024).optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type ThreadCatalogReadParams = z.infer<typeof threadCatalogReadParamsSchema>;

/** Rows and ownership have the same order: updatedAt descending, external first on ties. */
export const threadCatalogReadResultSchema = z
  .object({
    threads: z.array(jsonObjectSchema),
    ownership: z.array(threadOwnershipSchema),
    /** Known archived IDs, including visible local external records even when their rows are
     * excluded. Native archived IDs describe only the returned page, never a complete set. */
    archivedThreadIds: z.array(hostThreadIdSchema),
    officialCursor: z
      .object({ live: z.string().nullable(), archived: z.string().nullable().optional() })
      .strict()
      .optional(),
  })
  .strict();
export type ThreadCatalogReadResult = z.infer<typeof threadCatalogReadResultSchema>;
