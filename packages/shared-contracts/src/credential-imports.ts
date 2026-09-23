import { z } from "zod";

// Display-only metadata. Credentials never cross the Renderer bridge.
export const credentialSourceSchema = z
  .object({
    id: z.string().min(1).max(256),
    harnessId: z.string().min(1),
    label: z.string().min(1).max(512),
    provider: z.enum(["openai-codex", "xai"]),
  })
  .strict();
export type CredentialSource = z.infer<typeof credentialSourceSchema>;
export const credentialImportNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const credentialImportRecordSchema = z
  .object({
    name: credentialImportNameSchema,
    source: credentialSourceSchema,
    importedAt: z.string(),
  })
  .strict();
export type CredentialImportRecord = z.infer<typeof credentialImportRecordSchema>;
export const credentialImportsRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("import"),
      sourceId: z.string().min(1).max(256),
      name: credentialImportNameSchema,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("reimport"),
      sourceId: z.string().min(1).max(256),
      name: credentialImportNameSchema,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      name: credentialImportNameSchema,
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type CredentialImportsRequest = z.infer<typeof credentialImportsRequestSchema>;
/**
 * Display-only summary of a login that already exists in the target Harness but was not created by
 * codexhost: which Provider it belongs to and how it authenticates, plus an account label when one
 * can be read locally. Never carries a credential value or an expiry.
 */
export const credentialOtherLoginSchema = z
  .object({
    provider: z.string().min(1).max(128),
    type: z.enum(["oauth", "api_key", "unknown"]),
    /** Best-effort account label (e.g. the email in a Codex token), derived locally when present. */
    label: z.string().min(1).max(512).optional(),
    /** Recognized credential vendor, derived from the OAuth token issuer. Absent when unknown. */
    vendor: z.enum(["openai-codex", "xai"]).optional(),
  })
  .strict();
export type CredentialOtherLogin = z.infer<typeof credentialOtherLoginSchema>;
export const credentialImportsResultSchema = z
  .object({
    sources: z.array(credentialSourceSchema),
    targets: z.array(
      z
        .object({
          harnessId: z.string(),
          providers: z.array(z.enum(["openai-codex", "xai"])),
          imports: z.array(credentialImportRecordSchema),
          others: z.array(credentialOtherLoginSchema).default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type CredentialImportsResult = z.infer<typeof credentialImportsResultSchema>;
export const credentialImportsParamsSchema = z
  .object({
    targetHarnessId: z.string().min(1).max(128).optional(),
    request: credentialImportsRequestSchema,
  })
  .strict();
export const CREDENTIAL_IMPORTS_METHOD = "codexhost/harness/credential-imports";
