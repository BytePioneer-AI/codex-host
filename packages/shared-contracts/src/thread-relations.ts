import { z } from "zod";

import { hostThreadIdSchema } from "./ids.js";

/** Fixed read-only Host method that reports persisted sidebar parent relations. */
export const THREAD_RELATION_LIST_METHOD = "codexhost/thread/relation/list";
export const THREAD_RELATION_LIST_MAX_LENGTH = 100;

function uniqueThreadIds(
  ids: readonly string[],
  context: z.RefinementCtx,
  message: string,
  path: (index: number) => (string | number)[],
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) context.addIssue({ code: "custom", message, path: path(index) });
    seen.add(id);
  }
}

export const threadRelationListParamsSchema = z
  .object({
    threadIds: z.array(hostThreadIdSchema).min(1).max(THREAD_RELATION_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threadIds }, context) =>
    uniqueThreadIds(threadIds, context, "Thread relation-list IDs must be unique", (index) => [
      "threadIds",
      index,
    ]),
  );

export type ThreadRelationListParams = z.infer<typeof threadRelationListParamsSchema>;

/**
 * `delegation` comes from a CodexHost Delegation record; `fork` from a
 * persisted Fork source. Codex Subagent relations are not reported because
 * Desktop already renders them natively.
 */
export const threadRelationKindSchema = z.enum(["delegation", "fork"]);

export type ThreadRelationKind = z.infer<typeof threadRelationKindSchema>;

export const threadRelationParentSchema = z
  .object({
    threadId: hostThreadIdSchema,
    relation: threadRelationKindSchema,
  })
  .strict();

export type ThreadRelationParent = z.infer<typeof threadRelationParentSchema>;

export const threadRelationSchema = z
  .object({
    threadId: hostThreadIdSchema,
    /**
     * `codex` means this Host has no external record for the Thread, so a
     * native Codex Fork source can only be read from native `thread/read`.
     */
    owner: z.enum(["codex", "external"]),
    parent: threadRelationParentSchema.nullable(),
  })
  .strict()
  .refine((value) => value.parent?.threadId !== value.threadId, {
    message: "A Thread cannot be its own parent",
    path: ["parent", "threadId"],
  });

export type ThreadRelation = z.infer<typeof threadRelationSchema>;

export const threadRelationListResultSchema = z
  .object({
    threads: z.array(threadRelationSchema).min(1).max(THREAD_RELATION_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threads }, context) =>
    uniqueThreadIds(
      threads.map(({ threadId }) => threadId),
      context,
      "Thread relation-list results must be unique",
      (index) => ["threads", index, "threadId"],
    ),
  );

export type ThreadRelationListResult = z.infer<typeof threadRelationListResultSchema>;
