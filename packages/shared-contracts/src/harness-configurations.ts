import { z } from "zod";

import { harnessIdSchema } from "./ids.js";

const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be empty or whitespace",
});
const profileIdSchema = nonBlankTextSchema
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/u, "Profile ID must use transport-safe characters");
const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Invalid environment variable name");

export const harnessAuthenticationTypeSchema = z.enum([
  "none",
  "oauth",
  "official-api-key",
  "third-party-gateway",
  "environment",
]);

export const harnessConfigurationProfileSummarySchema = z
  .object({
    id: profileIdSchema,
    label: nonBlankTextSchema.max(128),
    authType: harnessAuthenticationTypeSchema,
    baseUrl: z.string().url().optional(),
    apiKeyConfigured: z.boolean(),
    apiKeyHint: z.string().max(32).optional(),
    apiKeyEnv: environmentNameSchema.optional(),
    model: nonBlankTextSchema.max(512).optional(),
    models: z.array(nonBlankTextSchema.max(512)).max(200).optional(),
    command: nonBlankTextSchema.max(2048).optional(),
    environmentKeys: z.array(environmentNameSchema).max(200),
  })
  .strict();

export const harnessConfigurationEntrySummarySchema = z
  .object({
    harnessId: harnessIdSchema,
    enabled: z.boolean(),
    activeProfileId: profileIdSchema,
    profiles: z.array(harnessConfigurationProfileSummarySchema).min(1).max(50),
  })
  .strict();

export const harnessConfigurationSnapshotSchema = z
  .object({
    path: nonBlankTextSchema,
    source: z.enum(["managed", "environment"]),
    writable: z.boolean(),
    restartRequired: z.boolean(),
    harnesses: z.array(harnessConfigurationEntrySummarySchema).max(100),
  })
  .strict();

export const harnessConfigurationInspectParamsSchema = z.object({}).strict();

export const harnessConfigurationProfileInputSchema = z
  .object({
    id: profileIdSchema,
    label: nonBlankTextSchema.max(128),
    authType: harnessAuthenticationTypeSchema,
    baseUrl: z.string().url().optional(),
    apiKey: nonBlankTextSchema.max(16_384).optional(),
    clearApiKey: z.boolean().optional(),
    apiKeyEnv: environmentNameSchema.optional(),
    model: nonBlankTextSchema.max(512).optional(),
    models: z.array(nonBlankTextSchema.max(512)).max(200).optional(),
    command: nonBlankTextSchema.max(2048).optional(),
    environment: z.record(environmentNameSchema, z.string().max(65_536)).optional(),
    removeEnvironmentKeys: z.array(environmentNameSchema).max(200).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.apiKey !== undefined && profile.clearApiKey === true) {
      context.addIssue({
        code: "custom",
        message: "apiKey and clearApiKey cannot be supplied together",
        path: ["clearApiKey"],
      });
    }
    if (profile.authType === "third-party-gateway" && !profile.baseUrl) {
      context.addIssue({
        code: "custom",
        message: "A third-party gateway profile requires baseUrl",
        path: ["baseUrl"],
      });
    }
  });

export const harnessConfigurationSaveParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    enabled: z.boolean(),
    activeProfileId: profileIdSchema,
    profiles: z.array(harnessConfigurationProfileInputSchema).min(1).max(50),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = new Set<string>();
    for (const [index, profile] of input.profiles.entries()) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: "custom",
          message: "Profile IDs must be unique",
          path: ["profiles", index, "id"],
        });
      }
      ids.add(profile.id);
    }
    if (!ids.has(input.activeProfileId)) {
      context.addIssue({
        code: "custom",
        message: "activeProfileId must reference a supplied profile",
        path: ["activeProfileId"],
      });
    }
  });

export const harnessConfigurationSaveResultSchema = z
  .object({
    snapshot: harnessConfigurationSnapshotSchema,
  })
  .strict();

export type HarnessAuthenticationType = z.infer<typeof harnessAuthenticationTypeSchema>;
export type HarnessConfigurationProfileSummary = z.infer<
  typeof harnessConfigurationProfileSummarySchema
>;
export type HarnessConfigurationEntrySummary = z.infer<
  typeof harnessConfigurationEntrySummarySchema
>;
export type HarnessConfigurationSnapshot = z.infer<typeof harnessConfigurationSnapshotSchema>;
export type HarnessConfigurationInspectParams = z.infer<
  typeof harnessConfigurationInspectParamsSchema
>;
export type HarnessConfigurationProfileInput = z.infer<
  typeof harnessConfigurationProfileInputSchema
>;
export type HarnessConfigurationSaveParams = z.infer<typeof harnessConfigurationSaveParamsSchema>;
export type HarnessConfigurationSaveResult = z.infer<typeof harnessConfigurationSaveResultSchema>;
