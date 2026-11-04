import { z } from "zod";

/** DSH package identity, distinct from a Harness ID. */
export const webUiExtensionIdSchema = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);

export const webUiExtensionSchema = z.object({
  id: webUiExtensionIdSchema,
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128),
  format: z.literal("dsh"),
  supportedTargets: z.tuple([z.literal("web")]),
  enabledTargets: z.array(z.literal("web")).max(1),
  source: z.string().min(1).max(4096),
  installedAt: z.string(),
  loadError: z.string().optional(),
});

/** loadedIds records server composition, not successful browser activation. */
export const webUiExtensionsStateSchema = z.object({
  extensions: z.array(webUiExtensionSchema),
  loadedIds: z.array(webUiExtensionIdSchema),
  safeMode: z.boolean(),
  storeError: z.string().optional(),
});

export type WebUiExtension = z.infer<typeof webUiExtensionSchema>;
export type WebUiExtensionsState = z.infer<typeof webUiExtensionsStateSchema>;

/** Registry URLs never carry credentials; npm reads authentication from its local configuration. */
export const webUiExtensionRegistrySchema = z
  .string()
  .trim()
  .max(2048)
  .url({ protocol: /^https?$/u, normalize: true })
  .refine(
    (value) => !/[\s\\?#]/u.test(value) && !value.split("/")[2]?.includes("@"),
    "Use an HTTP(S) registry URL without credentials, a query, or a fragment.",
  )
  .transform((value) => (value.endsWith("/") ? value : `${value}/`));

export const webUiExtensionInstallSchema = z
  .object({
    spec: z.string().trim().min(1).max(4096),
    registry: webUiExtensionRegistrySchema.optional(),
  })
  .strict();
export const webUiExtensionEnabledSchema = z
  .object({ id: webUiExtensionIdSchema, enabled: z.boolean() })
  .strict();
export const webUiExtensionRemoveSchema = z.object({ id: webUiExtensionIdSchema }).strict();
