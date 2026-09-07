import { z } from "zod";

import { harnessIdSchema } from "./ids.js";

export const HARNESS_PLUGIN_API_VERSION = 1;
export const HARNESS_PLUGIN_MANIFEST_MAX_BYTES = 32 * 1024;
export const HARNESS_PLUGIN_ICON_MAX_BYTES = 128 * 1024;
export const HARNESS_PLUGIN_LIMIT = 128;

/** Plugin identities are portable directory/route keys, not arbitrary Native Session IDs. */
export const harnessPluginIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
  .refine((id) => id !== "codex", "The official Codex identity is reserved")
  .pipe(harnessIdSchema);

const relativeResourceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\\\u0000:#?]/u.test(value) &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === ".." || part === ""),
    "Plugin resources must be relative paths inside the plugin",
  );

const documentationUrlSchema = z
  .url()
  .refine(
    (value) => /^https:\/\/[^/?#@]+(?:[/?#]|$)/iu.test(value),
    "Plugin documentation links must be credential-free HTTPS URLs",
  );

const pluginPresentationShape = {
  id: harnessPluginIdSchema,
  name: z.string().trim().min(1).max(128),
  version: z.string().min(1).max(128),
  links: z
    .object({
      documentation: documentationUrlSchema.optional(),
      installation: documentationUrlSchema.optional(),
    })
    .strict()
    .optional(),
};

/** A manifest is data only. It must be validated before importing any plugin code. */
export const harnessPluginManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    ...pluginPresentationShape,
    adapterApiVersion: z.number().int().positive(),
    entry: relativeResourceSchema,
    icon: relativeResourceSchema.optional(),
  })
  .strict();
export type HarnessPluginManifest = z.infer<typeof harnessPluginManifestSchema>;

/** Images are presentation data; consumers must use an img, never inline markup. */
export const harnessPluginIconSchema = z
  .string()
  .max(Math.ceil(HARNESS_PLUGIN_ICON_MAX_BYTES / 3) * 4 + 64)
  .regex(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u);

export const harnessPluginDescriptorSchema = z
  .object({
    ...pluginPresentationShape,
    icon: harnessPluginIconSchema.optional(),
  })
  .strict();
export type HarnessPluginDescriptor = z.infer<typeof harnessPluginDescriptorSchema>;

export const harnessPluginListParamsSchema = z.object({}).strict();
export const harnessPluginListResultSchema = z
  .object({
    plugins: z.array(harnessPluginDescriptorSchema).max(HARNESS_PLUGIN_LIMIT),
  })
  .strict();
export type HarnessPluginListResult = z.infer<typeof harnessPluginListResultSchema>;

/** Entries are explicit trust grants. Discovery alone never enables a plugin. */
export const harnessPluginConfigurationSchema = z
  .object({
    version: z.literal(1),
    enabled: z.array(harnessPluginIdSchema).max(HARNESS_PLUGIN_LIMIT),
  })
  .strict()
  .refine((value) => new Set(value.enabled).size === value.enabled.length, {
    message: "Enabled plugin IDs must be unique",
    path: ["enabled"],
  });
export type HarnessPluginConfiguration = z.infer<typeof harnessPluginConfigurationSchema>;
