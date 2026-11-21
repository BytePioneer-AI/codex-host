import { z } from "zod";

/** Live local working-tree facts, independent of a Thread's historical gitInfo. */
export const workspaceGitStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      root: z.string(),
      branch: z.string().nullable(),
      head: z.string().nullable(),
      upstream: z.string().nullable(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      changedFiles: z.number().int().nonnegative(),
      staged: z.number().int().nonnegative(),
      unstaged: z.number().int().nonnegative(),
      untracked: z.number().int().nonnegative(),
      conflicted: z.number().int().nonnegative(),
      checkedAt: z.string(),
    })
    .strict(),
  z.object({ state: z.literal("not-repository") }).strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum(["no-directory", "remote", "git-failed"]),
    })
    .strict(),
]);
export type WorkspaceGitStatus = z.infer<typeof workspaceGitStatusSchema>;
