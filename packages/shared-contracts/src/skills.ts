import { z } from "zod";
import { hostThreadIdSchema } from "./ids.js";

export const SKILLS_LIST_METHOD = "codexhost/skills/list";
export const SKILLS_CHANGED_METHOD = "codexhost/skills/changed";

export const skillsListParamsSchema = z
  .object({
    threadId: hostThreadIdSchema.optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict()
  .refine((params) => !(params.threadId && params.cwd), {
    message: "Specify threadId or cwd, not both",
  });
export type SkillsListParams = z.infer<typeof skillsListParamsSchema>;

export const librarySkillSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[^\s[\]]+$/u),
    description: z.string().optional(),
    path: z.string().min(1),
    scope: z.enum(["project", "global"]),
    source: z.string().min(1),
  })
  .strict();
export type LibrarySkill = z.infer<typeof librarySkillSchema>;

export const skillsListResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    complete: z.boolean(),
    skills: z.array(librarySkillSchema),
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type SkillsListResult = z.infer<typeof skillsListResultSchema>;

export const skillsChangedParamsSchema = z.object({ cwd: z.string().min(1).optional() }).strict();
export type SkillsChangedParams = z.infer<typeof skillsChangedParamsSchema>;
