import { z } from "zod";

import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

/** Children of each parent in the Thread tree (the Web sidebar's relation), with their live state. */
export const DELEGATION_CHILDREN_METHOD = "codexhost/thread/delegation-children";
export const DELEGATION_CHILDREN_MAX_PARENTS = 100;

export const delegationChildrenParamsSchema = z.strictObject({
  threadIds: z.array(hostThreadIdSchema).min(1).max(DELEGATION_CHILDREN_MAX_PARENTS),
  /** Titles of native Codex children cost an official read each; ask only when showing them. */
  includeTitles: z.boolean().optional(),
});
export type DelegationChildrenParams = z.infer<typeof delegationChildrenParamsSchema>;

/** A pending question outranks running; anything else is idle. */
export const delegationChildStatusSchema = z.enum(["question", "running", "idle"]);
export type DelegationChildStatus = z.infer<typeof delegationChildStatusSchema>;

export const delegationChildSchema = z.strictObject({
  threadId: hostThreadIdSchema,
  harnessId: harnessIdSchema,
  status: delegationChildStatusSchema,
  title: z.string().optional(),
});
export type DelegationChild = z.infer<typeof delegationChildSchema>;

export const delegationChildrenResultSchema = z.strictObject({
  /** One entry per requested parent, in request order; parents without children list none. */
  parents: z
    .array(
      z.strictObject({
        threadId: hostThreadIdSchema,
        /** Newest first. */
        children: z.array(delegationChildSchema),
      }),
    )
    .max(DELEGATION_CHILDREN_MAX_PARENTS),
});
export type DelegationChildrenResult = z.infer<typeof delegationChildrenResultSchema>;
