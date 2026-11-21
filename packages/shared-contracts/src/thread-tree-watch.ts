import { z } from "zod";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

export const THREAD_TREE_WATCH_METHOD = "codexhost/thread/tree/watch";
export const THREAD_TREE_UNWATCH_METHOD = "codexhost/thread/tree/unwatch";
export const THREAD_TREE_SNAPSHOT_METHOD = "codexhost/thread/tree/snapshot";
export const THREAD_TREE_MAX_NODES = 5000;

export const threadTreeStatusSchema = z.enum(["running", "waiting", "idle", "unknown"]);
export type ThreadTreeStatus = z.infer<typeof threadTreeStatusSchema>;

export const threadTreeNodeSchema = z.strictObject({
  harnessId: harnessIdSchema,
  title: z.string().optional(),
  status: threadTreeStatusSchema,
  archived: z.boolean(),
});
export type ThreadTreeNode = z.infer<typeof threadTreeNodeSchema>;

export const threadTreeSnapshotSchema = z
  .strictObject({
    revision: z.int().nonnegative(),
    parents: z.record(hostThreadIdSchema, hostThreadIdSchema),
    nodes: z.record(hostThreadIdSchema, threadTreeNodeSchema),
    truncated: z.boolean(),
  })
  .refine(
    (snapshot) => Object.keys(snapshot.nodes).length <= THREAD_TREE_MAX_NODES,
    "Too many Thread tree nodes",
  )
  .refine(
    ({ parents, nodes }) =>
      Object.entries(parents).every(
        ([child, parent]) => Object.hasOwn(nodes, child) && Object.hasOwn(nodes, parent),
      ),
    "Missing Thread tree node",
  );
export type ThreadTreeSnapshot = z.infer<typeof threadTreeSnapshotSchema>;

const subscriptionId = z.string().min(1).max(128);
export const threadTreeWatchParamsSchema = z.strictObject({});
export const threadTreeUnwatchParamsSchema = z.strictObject({ subscriptionId });
export const threadTreeUnwatchResultSchema = z.strictObject({});
export const threadTreeWatchResultSchema = threadTreeUnwatchParamsSchema.extend({
  snapshot: threadTreeSnapshotSchema,
});
export const threadTreeSnapshotNotificationSchema = threadTreeWatchResultSchema;
export type ThreadTreeWatchResult = z.infer<typeof threadTreeWatchResultSchema>;
