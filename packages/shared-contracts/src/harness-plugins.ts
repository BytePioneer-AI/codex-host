import { z } from "zod";

import { harnessIdSchema } from "./ids.js";

export const HARNESS_PLUGIN_API_VERSION = 1;
export const HARNESS_PLUGIN_MANIFEST_MAX_BYTES = 32 * 1024;
export const HARNESS_PLUGIN_ICON_MAX_BYTES = 128 * 1024;
export const HARNESS_PLUGIN_LIMIT = 128;

/** Where the Host may present a plugin; never an execution, storage or trust scope. */
export const HARNESS_PLUGIN_SURFACES = ["desktop", "web"] as const;
export const harnessPluginSurfaceSchema = z.enum(HARNESS_PLUGIN_SURFACES);
export type HarnessPluginSurface = z.infer<typeof harnessPluginSurfaceSchema>;

/** Installed plugin identities are portable directory keys, not Native Session IDs. */
export const installedHarnessPluginIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
  .pipe(harnessIdSchema);

/** External Harness routes must never take over the official Desktop Codex identity. */
export const harnessPluginIdSchema = installedHarnessPluginIdSchema.refine(
  (id) => id !== "codex",
  "The official Codex identity is reserved",
);

/** Execution ownership of a loaded plugin; the official Codex identity is never external. */
export type HarnessPluginScope = "external";

export function isHarnessPluginInScope(id: string, scope: HarnessPluginScope): boolean {
  return scope === "external" && id !== "codex";
}

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

const localizedTextSchema = z
  .object({ en: z.string().max(4096), "zh-CN": z.string().max(4096).optional() })
  .strict();

/** Display-only instructions. Commands are copied by users, never executed from metadata. */
export const harnessInstallationGuideSchema = z
  .object({
    commands: z
      .array(z.object({ terminal: z.string().max(256), command: z.string().max(4096) }).strict())
      .max(8),
    before: localizedTextSchema.optional(),
    after: localizedTextSchema.optional(),
    downloads: z
      .array(z.object({ label: z.string().max(128), url: documentationUrlSchema }).strict())
      .max(8)
      .optional(),
  })
  .strict();
export type HarnessInstallationGuide = z.infer<typeof harnessInstallationGuideSchema>;

const pluginPresentationShape = {
  id: installedHarnessPluginIdSchema,
  name: z.string().trim().min(1).max(128),
  version: z.string().min(1).max(128),
  /** Capability-only plugin; omitted for existing session-capable plugins. */
  kind: z.literal("usage").optional(),
  /** Original image styling or bounded vector paths; never arbitrary CSS/SVG markup. */
  iconStyle: z
    .object({
      vector: z
        .object({
          viewBox: z
            .string()
            .max(128)
            .regex(/^-?\d+(?:\.\d+)?(?: +-?\d+(?:\.\d+)?){3}$/u),
          color: z.string().regex(/^(?:currentColor|#[a-f0-9]{6})$/iu),
          paths: z
            .array(
              z
                .object({
                  d: z
                    .string()
                    .min(1)
                    .max(32768)
                    .regex(/^[MmLlHhVvCcSsQqTtAaZz\d.,+eE\s-]+$/u),
                  fillRule: z.enum(["evenodd", "nonzero"]).optional(),
                  fill: z
                    .string()
                    .regex(/^(?:currentColor|#[a-f0-9]{6})$/iu)
                    .optional(),
                })
                .strict(),
            )
            .min(1)
            .max(32),
        })
        .strict()
        .optional(),
      background: z
        .string()
        .regex(/^#[a-f0-9]{6}$/iu)
        .optional(),
      borderRadius: z.number().min(0).max(50).optional(),
      paddingRatio: z.number().min(0).max(0.25).optional(),
    })
    .strict()
    .optional(),
  installation: harnessInstallationGuideSchema.optional(),
  notice: localizedTextSchema.optional(),
  /** The factory accepts a persisted local entrypoint through its construction context. */
  launchCommand: z.literal(true).optional(),
  links: z
    .object({
      website: documentationUrlSchema.optional(),
      documentation: documentationUrlSchema.optional(),
      installation: documentationUrlSchema.optional(),
    })
    .strict()
    .optional(),
};

/** A manifest is data only. It must be validated before importing any plugin code. */
export const harnessPluginSurfacesSchema = z
  .array(harnessPluginSurfaceSchema)
  .min(1)
  .max(HARNESS_PLUGIN_SURFACES.length)
  .refine((surfaces) => new Set(surfaces).size === surfaces.length, {
    message: "Plugin surfaces must be unique",
  });

export const harnessPluginManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    ...pluginPresentationShape,
    adapterApiVersion: z.number().int().positive(),
    entry: relativeResourceSchema,
    icon: relativeResourceSchema.optional(),
    /** Omitted means the plugin appears in every surface; never inferred from its identity. */
    surfaces: harnessPluginSurfacesSchema.optional(),
  })
  .strict();
export type HarnessPluginManifest = z.infer<typeof harnessPluginManifestSchema>;

/** Image resources are presentation data, never HTML/SVG markup to inject. */
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
/** This is the Desktop/CH external plugin directory, not a Web execution registry. */
export const harnessPluginListResultSchema = z
  .object({
    plugins: z
      .array(harnessPluginDescriptorSchema.extend({ id: harnessPluginIdSchema }))
      .max(HARNESS_PLUGIN_LIMIT),
  })
  .strict();
export type HarnessPluginListResult = z.infer<typeof harnessPluginListResultSchema>;

/** Entries are explicit trust grants. Discovery alone never enables a plugin. */
export const harnessPluginConfigurationSchema = z
  .object({
    version: z.literal(1),
    enabled: z.array(installedHarnessPluginIdSchema).max(HARNESS_PLUGIN_LIMIT),
  })
  .strict()
  .refine((value) => new Set(value.enabled).size === value.enabled.length, {
    message: "Enabled plugin IDs must be unique",
    path: ["enabled"],
  });
export type HarnessPluginConfiguration = z.infer<typeof harnessPluginConfigurationSchema>;
