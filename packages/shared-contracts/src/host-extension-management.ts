import { z } from "zod";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_LIMIT,
  DESKTOP_EXTENSION_SCREENSHOT_LIMIT,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionCatalogEntrySchema,
  desktopExtensionHttpUrlSchema,
} from "./desktop-extensions.js";
import {
  hostExtensionActivationIdSchema,
  hostExtensionBackendMethodSchema,
  hostExtensionDigestSchema,
  hostExtensionIdSchema,
  hostExtensionManifestV2Schema,
  hostExtensionResourcePathSchema,
  hostExtensionTargetSchema,
  targetsForCapabilities,
} from "./host-extensions.js";
import { jsonObjectSchema, jsonValueSchema } from "./json-value.js";

export const HOST_EXTENSION_ZIP_MAX_BYTES = DESKTOP_EXTENSION_ZIP_MAX_BYTES;
export const HOST_EXTENSION_CATALOG_URL =
  "https://raw.githubusercontent.com/BytePioneer-AI/codexhost-extensions-registry/main/catalog.v2.json";
export const HOST_EXTENSION_CATALOG_MIRROR_URL =
  "https://cdn.jsdelivr.net/gh/BytePioneer-AI/codexhost-extensions-registry@main/catalog.v2.json";
export const HOST_EXTENSION_UPLOAD_PATH = "/api/extensions/upload";

export const hostExtensionRevisionSchema = z.int().nonnegative();
export const hostExtensionConfigurationSchema = z.strictObject({
  revision: hostExtensionRevisionSchema,
  enabled: z
    .array(hostExtensionIdSchema)
    .max(DESKTOP_EXTENSION_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate extension IDs"),
});
export type HostExtensionConfiguration = z.infer<typeof hostExtensionConfigurationSchema>;

const { downloadUrl, ...catalogMetadata } = desktopExtensionCatalogEntrySchema.shape;
export const hostExtensionCatalogEntrySchema = z
  .object({
    ...catalogMetadata,
    id: hostExtensionIdSchema,
    format: z.literal("codexhost"),
    targets: z
      .array(hostExtensionTargetSchema)
      .min(1)
      .max(2)
      .refine((targets) => new Set(targets).size === targets.length, "Duplicate targets"),
    apis: z.strictObject({
      page: z.int().positive().optional(),
      widget: z.int().positive().optional(),
      desktop: z.int().positive().optional(),
      web: z.int().positive().optional(),
      backend: z.int().positive().optional(),
    }),
    downloadUrl: downloadUrl.refine((url) => url.startsWith("https://"), "Expected HTTPS"),
  })
  .refine(({ targets, apis }) => {
    const derived = targetsForCapabilities({
      hasPage: Boolean(apis.page),
      hasWidget: Boolean(apis.widget),
      hasDesktop: Boolean(apis.desktop),
      hasWeb: Boolean(apis.web),
      hasBackend: Boolean(apis.backend),
    });
    return targets.length === derived.length && derived.every((target) => targets.includes(target));
  }, "Catalog targets must match the declared APIs");
export const hostExtensionCatalogSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().min(1),
  extensions: z
    .array(hostExtensionCatalogEntrySchema)
    .max(10_000)
    .refine(
      (entries) => new Set(entries.map(({ id }) => id)).size === entries.length,
      "Duplicate extension IDs",
    ),
});
export const hostExtensionsCatalogResultSchema = hostExtensionCatalogSchema.extend({
  catalogUrl: desktopExtensionHttpUrlSchema,
  fetchedAt: z.iso.datetime(),
  cached: z.boolean(),
});
export type HostExtensionCatalog = z.infer<typeof hostExtensionCatalogSchema>;
export type HostExtensionCatalogEntry = z.infer<typeof hostExtensionCatalogEntrySchema>;
export type HostExtensionsCatalogResult = z.infer<typeof hostExtensionsCatalogResultSchema>;

const id = { id: hostExtensionIdSchema };
const active = {
  ...id,
  activationId: hostExtensionActivationIdSchema,
  digest: hostExtensionDigestSchema,
};
const optionalActivation = { ...id, activationId: active.activationId.optional() };
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      /^(?:\/|[a-z]:[/\\])/iu.test(path) &&
      !path.includes("\0") &&
      !path.split(/[/\\]/u).some((part) => part === "." || part === ".."),
    "Expected an absolute local path without dot segments",
  );
const gitRef = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (ref) =>
      ref
        .split("/")
        .every((part) => part && /^[a-z0-9_.-]+$/iu.test(part) && part !== "." && part !== ".."),
    "Invalid GitHub ref",
  );
function base64(maxBytes: number) {
  return z
    .string()
    .max(4 * Math.ceil(maxBytes / 3))
    .refine((value) => {
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      // Validate without decoding (the ZIP may exceed 85 MiB in base64 form).
      return (
        value.length % 4 === 0 &&
        (value.length * 3) / 4 - padding <= maxBytes &&
        /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
      );
    }, "Expected bounded standard padded base64");
}
export const hostExtensionGitHubSourceSchema = z
  .strictObject({
    type: z.literal("github"),
    repository: z
      .string()
      .max(150)
      .regex(/^[a-z0-9-]+\/[a-z0-9_-][a-z0-9_.-]*$/iu),
    ref: gitRef.optional(),
    tag: gitRef.optional(),
    asset: z
      .string()
      .max(255)
      .regex(/^[a-z0-9_.-]+\.zip$/iu)
      .optional(),
    subpath: hostExtensionResourcePathSchema.optional(),
  })
  .refine(
    ({ ref, tag, asset }) => !ref || (!tag && !asset),
    "Use either a zipball ref or a release tag/asset",
  );
export const hostExtensionInstallSourceSchema = z.union([
  z.strictObject({ type: z.literal("catalog"), ...id }),
  hostExtensionGitHubSourceSchema,
  z.strictObject({ type: z.literal("zip"), base64: base64(HOST_EXTENSION_ZIP_MAX_BYTES).min(4) }),
  z.strictObject({ type: z.literal("zip"), localZipPath: filePath }),
  z.strictObject({ type: z.literal("localDir"), localDir: filePath }),
]);
export type HostExtensionInstallSource = z.infer<typeof hostExtensionInstallSourceSchema>;

/** Provenance is deliberately free of local paths and ZIP payloads. */
export const hostExtensionProvenanceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("catalog"), ...id }),
  hostExtensionGitHubSourceSchema,
  z.strictObject({ type: z.literal("zip") }),
  z.strictObject({ type: z.literal("localDir") }),
]);
export type HostExtensionProvenance = z.infer<typeof hostExtensionProvenanceSchema>;
export const hostExtensionInstallationSchema = z.strictObject({
  ...active,
  manifest: hostExtensionManifestV2Schema,
  installedAt: z.iso.datetime(),
  source: hostExtensionProvenanceSchema.optional(),
});
export type HostExtensionInstallation = z.infer<typeof hostExtensionInstallationSchema>;

const rasterDataUrlSchema = (maxBytes: number) =>
  z
    .string()
    .max("data:image/jpeg;base64,".length + 4 * Math.ceil(maxBytes / 3))
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u);
const desktopConflict = { desktopConflictWith: hostExtensionIdSchema.optional() };
const backendState = z.enum(["none", "inactive", "starting", "running", "failed"]);
export const hostExtensionListItemSchema = z.discriminatedUnion("state", [
  hostExtensionInstallationSchema.extend({
    state: z.literal("valid"),
    enabled: z.boolean(),
    ...desktopConflict,
    iconDataUrl: rasterDataUrlSchema(DESKTOP_EXTENSION_ICON_MAX_BYTES).optional(),
    screenshotDataUrls: z
      .array(rasterDataUrlSchema(DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES))
      .max(DESKTOP_EXTENSION_SCREENSHOT_LIMIT)
      .optional(),
    backendState: backendState.optional(),
    backendError: z.string().optional(),
  }),
  z.strictObject({
    state: z.enum(["invalid", "incompatible"]),
    id: z.string().min(1),
    enabled: z.boolean(),
    error: z.string(),
  }),
]);
export const hostExtensionsListResultSchema = z.strictObject({
  revision: hostExtensionRevisionSchema,
  configuration: hostExtensionConfigurationSchema,
  diagnostics: z.array(z.string()),
  extensions: z.array(hostExtensionListItemSchema),
});
export const hostExtensionRuntimeEntrySchema = hostExtensionInstallationSchema.extend({
  ...desktopConflict,
  settingsRevision: hostExtensionRevisionSchema,
});
export const hostExtensionsSnapshotResultSchema = z.strictObject({
  /** The Host publishes this revision in extensions-changed, independent of enabled.json's revision. */
  revision: hostExtensionRevisionSchema,
  // Enabled, valid activations only. A Desktop conflict does not hide other capabilities.
  extensions: z.array(hostExtensionRuntimeEntrySchema).max(DESKTOP_EXTENSION_LIMIT),
});
export type HostExtensionListItem = z.infer<typeof hostExtensionListItemSchema>;
export type HostExtensionsListResult = z.infer<typeof hostExtensionsListResultSchema>;
export type HostExtensionRuntimeEntry = z.infer<typeof hostExtensionRuntimeEntrySchema>;
export type HostExtensionsSnapshotResult = z.infer<typeof hostExtensionsSnapshotResultSchema>;

export const HOST_EXTENSIONS_RPC = {
  list: "codexhost/extensions/list",
  snapshot: "codexhost/extensions/snapshot",
  catalog: "codexhost/extensions/catalog",
  install: "codexhost/extensions/install",
  update: "codexhost/extensions/update",
  enable: "codexhost/extensions/enable",
  disable: "codexhost/extensions/disable",
  uninstall: "codexhost/extensions/uninstall",
  recover: "codexhost/extensions/recover",
  asset: "codexhost/extensions/asset",
  settingsGet: "codexhost/extensions/settings/get",
  settingsSet: "codexhost/extensions/settings/set",
  backendInvoke: "codexhost/extensions/backend/invoke",
} as const;
export const HOST_EXTENSION_MANAGEMENT_METHODS = Object.freeze(Object.values(HOST_EXTENSIONS_RPC));
export type HostExtensionManagementMethod = (typeof HOST_EXTENSION_MANAGEMENT_METHODS)[number];
const methods: ReadonlySet<string> = new Set(HOST_EXTENSION_MANAGEMENT_METHODS);
export function isHostExtensionManagementMethod(
  method: string,
): method is HostExtensionManagementMethod {
  return methods.has(method);
}

const noParams = z.strictObject({});
const expectedRevision = { expectedRevision: hostExtensionRevisionSchema };
const selection = z.strictObject({ ...id, ...expectedRevision });
const installationResult = hostExtensionInstallationSchema.extend({ replaced: z.boolean() });
const mutationResult = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("saved"), configuration: hostExtensionConfigurationSchema }),
  z.strictObject({ state: z.literal("revision-conflict"), revision: hostExtensionRevisionSchema }),
]);
export const hostExtensionsAssetParamsSchema = z.strictObject({
  ...optionalActivation,
  digest: active.digest.optional(),
  path: hostExtensionResourcePathSchema,
});
export const hostExtensionsAssetResultSchema = z.strictObject({
  mimeType: z.string().min(1),
  base64: base64(DESKTOP_EXTENSION_ASSET_MAX_BYTES),
  digest: active.digest,
});
export const hostExtensionSettingsSchema = z.strictObject({
  settingsRevision: hostExtensionRevisionSchema,
  values: jsonObjectSchema,
});
export type HostExtensionSettings = z.infer<typeof hostExtensionSettingsSchema>;

export const hostExtensionsRpcSchemas = {
  [HOST_EXTENSIONS_RPC.list]: { params: noParams, result: hostExtensionsListResultSchema },
  [HOST_EXTENSIONS_RPC.snapshot]: { params: noParams, result: hostExtensionsSnapshotResultSchema },
  [HOST_EXTENSIONS_RPC.catalog]: {
    params: z.strictObject({ forceRefresh: z.boolean().optional() }),
    result: hostExtensionsCatalogResultSchema,
  },
  [HOST_EXTENSIONS_RPC.install]: {
    params: z.strictObject({ source: hostExtensionInstallSourceSchema }),
    result: installationResult,
  },
  [HOST_EXTENSIONS_RPC.update]: {
    params: z.strictObject({
      ...id,
      expectedDigest: active.digest,
      expectedActivationId: active.activationId.optional(),
      source: hostExtensionInstallSourceSchema.optional(),
    }),
    result: installationResult,
  },
  [HOST_EXTENSIONS_RPC.enable]: { params: selection, result: mutationResult },
  [HOST_EXTENSIONS_RPC.disable]: { params: selection, result: mutationResult },
  [HOST_EXTENSIONS_RPC.uninstall]: {
    params: z.strictObject({
      ...id,
      removeData: z.boolean().optional(),
      expectedDigest: active.digest.optional(),
    }),
    result: z.strictObject({ ...id, removed: z.boolean() }),
  },
  [HOST_EXTENSIONS_RPC.recover]: {
    params: z.strictObject({ expectedRevision: expectedRevision.expectedRevision.optional() }),
    result: mutationResult,
  },
  [HOST_EXTENSIONS_RPC.asset]: {
    params: hostExtensionsAssetParamsSchema,
    result: hostExtensionsAssetResultSchema,
  },
  [HOST_EXTENSIONS_RPC.settingsGet]: {
    params: z.strictObject(optionalActivation),
    result: hostExtensionSettingsSchema,
  },
  [HOST_EXTENSIONS_RPC.settingsSet]: {
    params: z.strictObject({
      ...optionalActivation,
      expectedSettingsRevision: hostExtensionRevisionSchema,
      values: jsonObjectSchema,
    }),
    result: hostExtensionSettingsSchema,
  },
  [HOST_EXTENSIONS_RPC.backendInvoke]: {
    params: z.strictObject({
      ...optionalActivation,
      method: hostExtensionBackendMethodSchema,
      params: jsonValueSchema.optional(),
    }),
    result: z.strictObject({ result: jsonValueSchema }),
  },
} as const satisfies Record<
  HostExtensionManagementMethod,
  { params: z.ZodType; result: z.ZodType }
>;

type RpcSchemas = typeof hostExtensionsRpcSchemas;
export type HostExtensionsRpcParams<M extends HostExtensionManagementMethod> = z.infer<
  RpcSchemas[M]["params"]
>;
export type HostExtensionsRpcResult<M extends HostExtensionManagementMethod> = z.infer<
  RpcSchemas[M]["result"]
>;
