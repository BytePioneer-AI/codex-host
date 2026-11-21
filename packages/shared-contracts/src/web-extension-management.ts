import { z } from "zod";
import {
  desktopExtensionBackendMethodSchema,
  desktopExtensionCatalogEntrySchema,
  desktopExtensionHashSchema,
  desktopExtensionManifestSchema,
} from "./desktop-extensions.js";
import { desktopExtensionListItemSchema } from "./desktop-extension-management.js";
import { jsonObjectSchema, jsonValueSchema } from "./json-value.js";
import {
  codexHostExtensionManifestV2Schema,
  extensionManifestTargets,
  extensionTargetsSchema,
  webExtensionActivationIdSchema,
  webExtensionRuntimeSnapshotSchema,
  webNativeExtensionIdSchema,
} from "./web-native-extensions.js";
import { webUiExtensionInstallSchema, webUiExtensionSchema } from "./web-ui-extensions.js";

export const WEB_EXTENSION_CATALOG_URL =
  "https://raw.githubusercontent.com/BytePioneer-AI/codexhost-extensions-registry/main/catalog.v2.json";
const { downloadUrl, ...catalogMetadata } = desktopExtensionCatalogEntrySchema.shape;
export const extensionCatalogV2EntrySchema = z
  .object({
    ...catalogMetadata,
    id: webNativeExtensionIdSchema,
    format: z.literal("codexhost"),
    targets: extensionTargetsSchema,
    apis: z.object({
      desktop: z.int().positive().optional(),
      web: z.int().positive().optional(),
      backend: z.int().positive().optional(),
    }),
    downloadUrl: downloadUrl.refine((url) => new URL(url).protocol === "https:", "Expected HTTPS"),
  })
  .refine(
    ({ targets, apis }) =>
      targets.includes("desktop") === (apis.desktop !== undefined) &&
      targets.includes("web") === (apis.web !== undefined),
    "Expected one platform API version per target",
  );
export type ExtensionCatalogV2Entry = z.infer<typeof extensionCatalogV2EntrySchema>;
export const extensionCatalogV2Schema = z.looseObject({
  schemaVersion: z.literal(2),
  generatedAt: z.string(),
  extensions: z.array(z.unknown()).max(10_000),
});
export function parseExtensionCatalogV2(value: unknown) {
  const { generatedAt, extensions } = extensionCatalogV2Schema.parse(value);
  const accepted: ExtensionCatalogV2Entry[] = [];
  const skipped: { index: number; error: string }[] = [];
  const ids = new Set<string>();
  for (const [index, row] of extensions.entries()) {
    const parsed = extensionCatalogV2EntrySchema.safeParse(row);
    if (!parsed.success) skipped.push({ index, error: z.prettifyError(parsed.error) });
    else if (ids.has(parsed.data.id)) skipped.push({ index, error: "Duplicate extension ID" });
    else {
      ids.add(parsed.data.id);
      accepted.push(parsed.data);
    }
  }
  return { schemaVersion: 2 as const, generatedAt, extensions: accepted, skipped };
}

export const WEB_EXTENSION_UPLOAD_PATH = "/api/web-extensions/upload";
export const webExtensionZipUploadResultSchema = z.strictObject({ uploadId: z.uuid() });
export type WebExtensionZipUploadResult = z.infer<typeof webExtensionZipUploadResultSchema>;
const nativeIdentity = { format: z.literal("codexhost"), id: webNativeExtensionIdSchema };
const dshIdentity = webUiExtensionSchema.pick({ format: true, id: true }).shape;
export const webExtensionIdentitySchema = z.discriminatedUnion("format", [
  z.strictObject(nativeIdentity),
  z.strictObject(dshIdentity),
]);
export type WebExtensionIdentity = z.infer<typeof webExtensionIdentitySchema>;

const manifest = codexHostExtensionManifestV2Schema.refine((manifest) =>
  extensionManifestTargets(manifest).includes("web"),
);
const artwork = desktopExtensionListItemSchema.shape;
export const webNativeExtensionListItemSchema = z
  .strictObject({
    ...nativeIdentity,
    version: desktopExtensionManifestSchema.shape.version.optional(),
    digest: desktopExtensionHashSchema.optional(),
    enabled: z.boolean(),
    backendState: z.enum(["none", "inactive", "starting", "running", "failed"]),
    manifest: manifest.optional(),
    iconDataUrl: artwork.iconDataUrl,
    screenshotDataUrls: artwork.screenshotDataUrls,
    error: z.string().optional(),
  })
  .refine(
    (row) =>
      row.manifest === undefined
        ? Boolean(row.error)
        : row.id === row.manifest.id &&
          row.version === row.manifest.version &&
          row.digest !== undefined,
    "Expected an installation manifest with matching identity, or a discovery error",
  );
export const webExtensionListSchema = z.strictObject({
  safeMode: z.boolean(),
  extensions: z.array(
    z.discriminatedUnion("format", [webUiExtensionSchema, webNativeExtensionListItemSchema]),
  ),
  dshLoadedIds: z.array(dshIdentity.id),
  storeError: z.string().optional(),
});
export type WebNativeExtensionListItem = z.infer<typeof webNativeExtensionListItemSchema>;
export type WebExtensionList = z.infer<typeof webExtensionListSchema>;

const marketSource = z.strictObject({
  type: z.literal("market"),
  id: webNativeExtensionIdSchema,
  version: desktopExtensionCatalogEntrySchema.shape.version,
  sha256: desktopExtensionHashSchema,
});
export const webNativeExtensionSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("zip"), ...webExtensionZipUploadResultSchema.shape }),
  z.strictObject({
    type: z.literal("github"),
    repository: z
      .string()
      .max(150)
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u)
      .refine((repo) => !/\/(?:\.|\.\.)$/u.test(repo)),
    tag: z.string().min(1).max(256).optional(),
    asset: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9_.-]+\.zip$/iu),
  }),
  marketSource,
]);
export type WebNativeExtensionSource = z.infer<typeof webNativeExtensionSourceSchema>;

const settingsIdentity = {
  id: webNativeExtensionIdSchema,
  activationId: webExtensionActivationIdSchema.optional(),
};
const settingsResult = z.strictObject({ values: jsonObjectSchema, revision: z.uuid() });
const noParams = z.strictObject({});
export const WEB_EXTENSIONS_RPC = {
  list: "codexhost/webExtensions/list",
  snapshot: "codexhost/webExtensions/snapshot",
  install: "codexhost/webExtensions/install",
  update: "codexhost/webExtensions/update",
  setEnabled: "codexhost/webExtensions/setEnabled",
  uninstall: "codexhost/webExtensions/uninstall",
  settingsGet: "codexhost/webExtensions/settings/get",
  settingsSet: "codexhost/webExtensions/settings/set",
  backendInvoke: "codexhost/webExtensions/backend/invoke",
  marketRefresh: "codexhost/webExtensions/market/refresh",
} as const;
export const WEB_EXTENSION_RPC_ERRORS = {
  authDisabled: "auth/disabled",
  invalidParams: "extensions/invalid-params",
  notFound: "extensions/not-found",
  stale: "extensions/stale",
  inactive: "extensions/inactive",
  changeFailed: "extensions/change-failed",
  backendFailed: "extensions/backend-failed",
  marketUnavailable: "extensions/market-unavailable",
} as const;

/** Same schema table for server validation and client RPC typing. Mutations return the current list. */
export const webExtensionsRpcSchemas = {
  [WEB_EXTENSIONS_RPC.list]: { params: noParams, result: webExtensionListSchema },
  [WEB_EXTENSIONS_RPC.snapshot]: { params: noParams, result: webExtensionRuntimeSnapshotSchema },
  [WEB_EXTENSIONS_RPC.install]: {
    params: z.discriminatedUnion("format", [
      z.strictObject({ format: nativeIdentity.format, source: webNativeExtensionSourceSchema }),
      z.strictObject({ format: dshIdentity.format, source: webUiExtensionInstallSchema }),
    ]),
    result: webExtensionListSchema,
  },
  [WEB_EXTENSIONS_RPC.update]: {
    params: z.strictObject({
      ...nativeIdentity,
      expectedDigest: desktopExtensionHashSchema,
      source: webNativeExtensionSourceSchema,
    }),
    result: webExtensionListSchema,
  },
  [WEB_EXTENSIONS_RPC.setEnabled]: {
    params: z.discriminatedUnion("format", [
      z.strictObject({ ...nativeIdentity, enabled: z.boolean() }),
      z.strictObject({ ...dshIdentity, enabled: z.boolean() }),
    ]),
    result: webExtensionListSchema,
  },
  [WEB_EXTENSIONS_RPC.uninstall]: {
    params: webExtensionIdentitySchema,
    result: webExtensionListSchema,
  },
  [WEB_EXTENSIONS_RPC.settingsGet]: {
    params: z.strictObject(settingsIdentity),
    result: settingsResult,
  },
  [WEB_EXTENSIONS_RPC.settingsSet]: {
    params: z.strictObject({ ...settingsIdentity, values: jsonObjectSchema }),
    result: settingsResult,
  },
  [WEB_EXTENSIONS_RPC.backendInvoke]: {
    params: z.strictObject({
      ...settingsIdentity,
      activationId: webExtensionActivationIdSchema,
      method: desktopExtensionBackendMethodSchema,
      params: jsonValueSchema.optional(),
    }),
    result: z.strictObject({ result: jsonValueSchema }),
  },
  [WEB_EXTENSIONS_RPC.marketRefresh]: {
    params: noParams,
    result: z.strictObject({
      generatedAt: z.string(),
      extensions: z.array(extensionCatalogV2EntrySchema),
      skippedCount: z.int().nonnegative(),
      stale: z.boolean(),
      error: z.string().optional(),
    }),
  },
} as const;

type RpcSchemas = typeof webExtensionsRpcSchemas;
export type WebExtensionsRpcMethod = keyof RpcSchemas;
export type WebExtensionsRpcParams<M extends WebExtensionsRpcMethod> = z.infer<
  RpcSchemas[M]["params"]
>;
export type WebExtensionsRpcResult<M extends WebExtensionsRpcMethod> = z.infer<
  RpcSchemas[M]["result"]
>;
