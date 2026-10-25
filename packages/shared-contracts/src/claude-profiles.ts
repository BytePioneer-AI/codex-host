import { z } from "zod";

import { harnessLaunchPathSchema } from "./harness-launch-settings.js";
import { pluginIconStyleSchema } from "./harness-plugins.js";

export const claudeCodeProfileSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, {
        message:
          "Profile ID must start with a lowercase letter and contain only lowercase ASCII letters, digits, and hyphens",
      })
      .min(1)
      .max(64)
      .refine((id) => id !== "claude-code", {
        message: "Profile ID cannot be the default 'claude-code' ID",
      }),
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(256).optional(),
    command: harnessLaunchPathSchema.optional(),
    configDir: z.string().trim().min(1).max(1024),
    icon: z.string().trim().min(1).max(131072).optional(),
    iconStyle: pluginIconStyleSchema.optional(),
    environment: z.record(z.string().min(1).max(256), z.string().max(8192)).optional(),
  })
  .strict();

export type ClaudeCodeProfile = z.infer<typeof claudeCodeProfileSchema>;

export const CLAUDE_PROFILE_LIMIT = 32;

export const claudeCodeProfilesListSchema = z
  .array(claudeCodeProfileSchema)
  .max(CLAUDE_PROFILE_LIMIT)
  .refine((profiles) => new Set(profiles.map((p) => p.id)).size === profiles.length, {
    message: "Profile IDs must be unique within the profiles file",
  });

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

function claudeCodeProfileEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).profiles)
  ) {
    return (value as Record<string, unknown>).profiles as unknown[];
  }
  return null;
}

/**
 * Tolerant read used by discovery and Adapter construction alike: one malformed or
 * duplicated entry must not hide the other declared Profiles, and both layers must reach
 * the same conclusion about which Profiles exist.
 */
export function collectClaudeCodeProfiles(value: unknown): ClaudeCodeProfile[] {
  const entries = claudeCodeProfileEntries(value);
  if (!entries) return [];
  const seenIds = new Set<string>();
  const profiles: ClaudeCodeProfile[] = [];
  for (const entry of entries.slice(0, CLAUDE_PROFILE_LIMIT)) {
    const parsed = claudeCodeProfileSchema.safeParse(entry);
    if (!parsed.success || seenIds.has(parsed.data.id)) continue;
    seenIds.add(parsed.data.id);
    profiles.push(parsed.data);
  }
  return profiles;
}
