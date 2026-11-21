import { z } from "zod";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_LIMIT,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BASE64_LENGTH,
  desktopExtensionCatalogSchema,
  desktopExtensionConfigurationSchema,
  desktopExtensionHashSchema,
  desktopExtensionHttpUrlSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  desktopExtensionStatusSchema,
  DESKTOP_EXTENSIONS_ASSET_METHOD,
  DESKTOP_EXTENSIONS_BACKEND_INVOKE_METHOD,
  DESKTOP_EXTENSIONS_SETTINGS_GET_METHOD,
  DESKTOP_EXTENSIONS_SETTINGS_SET_METHOD,
} from "./desktop-extensions.js";

export const DESKTOP_EXTENSIONS_LIST_METHOD = "codexhost/desktop/extensions/list";
export const DESKTOP_EXTENSIONS_ENABLE_METHOD = "codexhost/desktop/extensions/enable";
export const DESKTOP_EXTENSIONS_DISABLE_METHOD = "codexhost/desktop/extensions/disable";
export const DESKTOP_EXTENSIONS_CATALOG_METHOD = "codexhost/desktop/extensions/catalog";
export const DESKTOP_EXTENSIONS_INSTALL_METHOD = "codexhost/desktop/extensions/install";
export const DESKTOP_EXTENSIONS_UNINSTALL_METHOD = "codexhost/desktop/extensions/uninstall";
export const DESKTOP_EXTENSIONS_RECOVER_METHOD =
  "codexhost/desktop/extensions/disable-all-and-reload";

export const DESKTOP_EXTENSION_MANAGEMENT_METHODS = [
  DESKTOP_EXTENSIONS_LIST_METHOD,
  DESKTOP_EXTENSIONS_ENABLE_METHOD,
  DESKTOP_EXTENSIONS_DISABLE_METHOD,
  DESKTOP_EXTENSIONS_RECOVER_METHOD,
  DESKTOP_EXTENSIONS_CATALOG_METHOD,
  DESKTOP_EXTENSIONS_INSTALL_METHOD,
  DESKTOP_EXTENSIONS_UNINSTALL_METHOD,
  DESKTOP_EXTENSIONS_ASSET_METHOD,
  DESKTOP_EXTENSIONS_SETTINGS_GET_METHOD,
  DESKTOP_EXTENSIONS_SETTINGS_SET_METHOD,
  DESKTOP_EXTENSIONS_BACKEND_INVOKE_METHOD,
] as const;

export type DesktopExtensionManagementMethod =
  (typeof DESKTOP_EXTENSION_MANAGEMENT_METHODS)[number];

export function isDesktopExtensionManagementMethod(
  method: string,
): method is DesktopExtensionManagementMethod {
  return (DESKTOP_EXTENSION_MANAGEMENT_METHODS as readonly string[]).includes(method);
}

const revisionSchema = z.int().nonnegative();
export const desktopExtensionsListParamsSchema = z.strictObject({});
export const desktopExtensionSelectionParamsSchema = z.strictObject({
  id: desktopExtensionIdSchema,
  expectedRevision: revisionSchema,
});
export const desktopExtensionsRecoveryParamsSchema = z.strictObject({
  expectedRevision: revisionSchema.optional(),
});

const rasterDataUrlSchema = (maxBytes: number) =>
  z
    .string()
    .max("data:image/jpeg;base64,".length + 4 * Math.ceil(maxBytes / 3))
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u);

export const desktopExtensionListItemSchema = z.strictObject({
  // An invalid discovery can have a directory name that isn't a valid extension ID.
  id: z.string().min(1),
  manifest: desktopExtensionManifestSchema.optional(),
  iconDataUrl: rasterDataUrlSchema(DESKTOP_EXTENSION_ICON_MAX_BYTES).optional(),
  screenshotDataUrls: z
    .array(rasterDataUrlSchema(DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES))
    .max(DESKTOP_EXTENSION_SCREENSHOT_LIMIT)
    .optional(),
  enabled: z.boolean(),
  status: desktopExtensionStatusSchema,
});
export type DesktopExtensionListItem = z.infer<typeof desktopExtensionListItemSchema>;

export const desktopExtensionsListResultSchema = z.strictObject({
  configuration: desktopExtensionConfigurationSchema,
  desktopConnected: z.boolean(),
  diagnostics: z.array(z.string()),
  extensions: z.array(desktopExtensionListItemSchema),
});

export const desktopExtensionsCatalogParamsSchema = z.strictObject({
  forceRefresh: z.boolean().optional(),
});
export const desktopExtensionsCatalogResultSchema = z.strictObject({
  catalogUrl: z.string(),
  source: z.enum(["remote", "fallback"]),
  fetchedAt: z.string(),
  cached: z.boolean(),
  extensions: desktopExtensionCatalogSchema.shape.extensions,
  error: z.string().optional(),
});
export const desktopExtensionsInstallParamsSchema = z.strictObject({
  source: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("catalog"), id: desktopExtensionIdSchema }),
    z.strictObject({
      type: z.literal("url"),
      url: desktopExtensionHttpUrlSchema,
      expectedSha256: desktopExtensionHashSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("zip-base64"),
      fileName: z.string().trim().min(1).max(255),
      contentBase64: z
        .string()
        .min(4)
        .max(DESKTOP_EXTENSION_ZIP_MAX_BASE64_LENGTH)
        .refine(
          (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value),
          "Expected standard padded base64",
        ),
    }),
  ]),
});
export const desktopExtensionsInstallResultSchema = z.strictObject({
  extensionId: desktopExtensionIdSchema,
  version: z.string().min(1),
  replaced: z.boolean(),
  installedPath: z.string(),
  list: desktopExtensionsListResultSchema,
});
export const desktopExtensionsUninstallParamsSchema = z.strictObject({
  id: desktopExtensionIdSchema,
});
export const desktopExtensionsUninstallResultSchema = z.strictObject({
  removedId: desktopExtensionIdSchema,
  list: desktopExtensionsListResultSchema,
});

export type DesktopExtensionsCatalogParams = z.infer<typeof desktopExtensionsCatalogParamsSchema>;
export type DesktopExtensionsCatalogResult = z.infer<typeof desktopExtensionsCatalogResultSchema>;
export type DesktopExtensionsInstallParams = z.infer<typeof desktopExtensionsInstallParamsSchema>;
export type DesktopExtensionsInstallResult = z.infer<typeof desktopExtensionsInstallResultSchema>;
export type DesktopExtensionsUninstallParams = z.infer<
  typeof desktopExtensionsUninstallParamsSchema
>;
export type DesktopExtensionsUninstallResult = z.infer<
  typeof desktopExtensionsUninstallResultSchema
>;

export const desktopExtensionMutationResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("saved"), configuration: desktopExtensionConfigurationSchema }),
  z.strictObject({ state: z.literal("slot-conflict"), conflictWith: desktopExtensionIdSchema }),
  z.strictObject({ state: z.literal("revision-conflict"), revision: revisionSchema }),
]);

export type DesktopExtensionsListParams = z.infer<typeof desktopExtensionsListParamsSchema>;
export type DesktopExtensionSelectionParams = z.infer<typeof desktopExtensionSelectionParamsSchema>;
export type DesktopExtensionsRecoveryParams = z.infer<typeof desktopExtensionsRecoveryParamsSchema>;
export type DesktopExtensionsListResult = z.infer<typeof desktopExtensionsListResultSchema>;
export type DesktopExtensionMutationResult = z.infer<typeof desktopExtensionMutationResultSchema>;
