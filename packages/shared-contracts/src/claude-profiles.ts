import { z } from "zod";

import { harnessLaunchPathSchema } from "./harness-launch-settings.js";
import { harnessPluginIdSchema, pluginIconStyleSchema } from "./harness-plugins.js";

export const claudeCodeProfileSchema = z
  .object({
    id: harnessPluginIdSchema.refine((id) => id !== "claude-code", {
      message: "Profile ID cannot be the default 'claude-code' ID",
    }),
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(256).optional(),
    command: harnessLaunchPathSchema.optional(),
    configDir: z.string().trim().min(1).max(1024).optional(),
    icon: z.string().trim().min(1).max(131072).optional(),
    iconStyle: pluginIconStyleSchema.optional(),
    environment: z.record(z.string().min(1).max(256), z.string().max(8192)).optional(),
  })
  .strict();

export type ClaudeCodeProfile = z.infer<typeof claudeCodeProfileSchema>;

export const claudeCodeProfilesListSchema = z.array(claudeCodeProfileSchema).max(32);

export const claudeCodeProfilesFileSchema = z
  .object({
    version: z.literal(1).optional().default(1),
    profiles: claudeCodeProfilesListSchema,
  })
  .strict();

export type ClaudeCodeProfilesFile = z.infer<typeof claudeCodeProfilesFileSchema>;

export function parseClaudeCodeProfiles(value: unknown): ClaudeCodeProfile[] {
  if (Array.isArray(value)) {
    return claudeCodeProfilesListSchema.parse(value);
  }
  const file = claudeCodeProfilesFileSchema.parse(value);
  return file.profiles;
}
