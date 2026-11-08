import { z } from "zod";
import { threadOwnershipSchema } from "./harness-models.js";
import { hostThreadIdSchema } from "./ids.js";
import { jsonObjectSchema } from "./json-value.js";

/** Host-owned, source-separated metadata enumeration for clients, including Desktop/CDP. */
export const THREAD_CATALOG_READ_METHOD = "codexhost/thread/catalog/read";
export const threadCatalogReadParamsSchema = z
  .object({ includeArchived: z.boolean().optional() })
  .strict();
export type ThreadCatalogReadParams = z.infer<typeof threadCatalogReadParamsSchema>;

/** Rows and ownership have the same order: createdAt descending, external first on ties. */
export const threadCatalogReadResultSchema = z
  .object({
    threads: z.array(jsonObjectSchema),
    ownership: z.array(threadOwnershipSchema),
    /** Known archived IDs, including visible local external records even when their rows are
     * excluded. Native archived IDs are complete only when includeArchived is true. */
    archivedThreadIds: z.array(hostThreadIdSchema),
  })
  .strict();
export type ThreadCatalogReadResult = z.infer<typeof threadCatalogReadResultSchema>;
