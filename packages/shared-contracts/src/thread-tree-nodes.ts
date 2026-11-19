import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

/**
 * Display data for Threads that the sidebar Thread tree places (`codexhost/thread/tree/read`
 * says where; this says what to show): the Harness, title, archive state and live state.
 */
export const THREAD_TREE_NODES_METHOD = "codexhost/thread/tree/nodes";
export const THREAD_TREE_NODES_MAX_LENGTH = 100;
export const THREAD_TREE_NODE_TITLE_MAX_LENGTH = 512;

export const threadTreeNodesParamsSchema = z
  .object({
    threadIds: z.array(hostThreadIdSchema).min(1).max(THREAD_TREE_NODES_MAX_LENGTH),
    /**
     * Official Codex Threads have no Host record: their titles cost one official read each and
     * their archive state a bounded read of the archived listing. Ask when first showing a
     * Thread, not on every state refresh.
     */
    includeOfficial: z.boolean().optional(),
  })
  .strict()
  .superRefine(({ threadIds }, context) => {
    const seen = new Set<string>();
    for (const [index, threadId] of threadIds.entries()) {
      if (seen.has(threadId)) {
        context.addIssue({
          code: "custom",
          message: "Thread tree node IDs must be unique",
          path: ["threadIds", index],
        });
      }
      seen.add(threadId);
    }
  });
export type ThreadTreeNodesParams = z.infer<typeof threadTreeNodesParamsSchema>;

/** A pending question outranks running; anything else is idle. */
export const threadTreeNodeStatusSchema = z.enum(["question", "running", "idle"]);
export type ThreadTreeNodeStatus = z.infer<typeof threadTreeNodeStatusSchema>;

export const threadTreeNodeSchema = z
  .object({
    threadId: hostThreadIdSchema,
    /** `codex` for an official Codex Thread. */
    harnessId: z.string().max(256).pipe(harnessIdSchema),
    status: threadTreeNodeStatusSchema,
    /** Absent when unknown: an official Thread that was not or could not be read, or no title. */
    title: z.string().max(THREAD_TREE_NODE_TITLE_MAX_LENGTH).optional(),
    /** Absent when unknown: an official Thread whose archive state was not or could not be read. */
    archived: z.boolean().optional(),
    /** When the Thread was delegated; absent for a Thread that was not delegated. */
    delegatedAt: z.string().max(64).optional(),
  })
  .strict();
export type ThreadTreeNode = z.infer<typeof threadTreeNodeSchema>;

export const threadTreeNodesResultSchema = z
  .object({
    /** Requested Threads in request order; an external Thread whose record is gone is left out. */
    threads: z.array(threadTreeNodeSchema).max(THREAD_TREE_NODES_MAX_LENGTH),
  })
  .strict();
export type ThreadTreeNodesResult = z.infer<typeof threadTreeNodesResultSchema>;
