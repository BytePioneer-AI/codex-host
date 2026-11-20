import { z } from "zod";
import {
  desktopExtensionConfigurationSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  desktopExtensionStatusSchema,
} from "./desktop-extensions.js";

export const DESKTOP_EXTENSIONS_LIST_METHOD = "codexhost/desktop/extensions/list";
export const DESKTOP_EXTENSIONS_ENABLE_METHOD = "codexhost/desktop/extensions/enable";
export const DESKTOP_EXTENSIONS_DISABLE_METHOD = "codexhost/desktop/extensions/disable";
export const DESKTOP_EXTENSIONS_RECOVER_METHOD =
  "codexhost/desktop/extensions/disable-all-and-reload";

export const DESKTOP_EXTENSION_MANAGEMENT_METHODS = [
  DESKTOP_EXTENSIONS_LIST_METHOD,
  DESKTOP_EXTENSIONS_ENABLE_METHOD,
  DESKTOP_EXTENSIONS_DISABLE_METHOD,
  DESKTOP_EXTENSIONS_RECOVER_METHOD,
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

export const desktopExtensionsListResultSchema = z.strictObject({
  configuration: desktopExtensionConfigurationSchema,
  desktopConnected: z.boolean(),
  diagnostics: z.array(z.string()),
  extensions: z.array(
    z.strictObject({
      // An invalid discovery can have a directory name that isn't a valid extension ID.
      id: z.string().min(1),
      manifest: desktopExtensionManifestSchema.optional(),
      enabled: z.boolean(),
      status: desktopExtensionStatusSchema,
    }),
  ),
});

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
