import { z } from "zod";

export const SETTINGS_PLUGIN_LIST_METHOD = "codexhost/settings-plugins/list";
export const SETTINGS_PLUGIN_READ_METHOD = "codexhost/settings-plugins/read";
export const SETTINGS_PLUGIN_HTML_MAX_BYTES = 256 * 1024;
export const SETTINGS_PLUGIN_PAGE_LIMIT = 64;

const pageId = z
  .string()
  .max(48)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const pluginId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
  .refine((id) => id !== "codex");
const pagePresentation = {
  id: pageId,
  title: z.string().trim().min(1).max(64),
  icon: z.string().trim().min(1).max(16),
};
export const settingsPluginManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(1),
    id: pluginId,
    name: z.string().trim().min(1).max(64),
    version: z.string().min(1).max(64),
    pages: z
      .array(
        z.strictObject({
          ...pagePresentation,
          entry: z
            .string()
            .max(256)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.html$/u)
            .refine((value) => !value.split("/").some((part) => part === ".." || part === "")),
        }),
      )
      .min(1)
      .max(8),
  })
  .refine(
    (value) => new Set(value.pages.map((page) => page.id)).size === value.pages.length,
    "Duplicate page ID",
  );

export const settingsPluginPageSchema = z.strictObject({
  ...pagePresentation,
  pluginId,
});
export const settingsPluginListParamsSchema = z.strictObject({});
export const settingsPluginListResultSchema = z
  .strictObject({
    pages: z.array(settingsPluginPageSchema).max(SETTINGS_PLUGIN_PAGE_LIMIT),
    unavailable: z.array(pluginId).max(128),
  })
  .refine(
    (value) =>
      new Set(value.pages.map((page) => `${page.pluginId}/${page.id}`)).size === value.pages.length,
    "Duplicate registered page ID",
  );
export const settingsPluginReadParamsSchema = z.strictObject({ pluginId, pageId });
export const settingsPluginReadResultSchema = z.strictObject({
  html: z.string().max(SETTINGS_PLUGIN_HTML_MAX_BYTES),
});
export type SettingsPluginPage = z.infer<typeof settingsPluginPageSchema>;
export type SettingsPluginListResult = z.infer<typeof settingsPluginListResultSchema>;
export type SettingsPluginReadParams = z.infer<typeof settingsPluginReadParamsSchema>;
