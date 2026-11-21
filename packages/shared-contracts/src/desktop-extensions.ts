import { z } from "zod";
import { installedPluginIdSchema, pluginRelativeResourceSchema } from "./harness-plugins.js";
import { jsonObjectSchema, jsonValueSchema } from "./json-value.js";
import type { ThreadTreeSnapshot } from "./thread-tree-watch.js";

export const DESKTOP_EXTENSION_API_VERSION = 1;
export const DESKTOP_EXTENSION_LIMIT = 64;
// Memory guard for buffered ZIP downloads and uploads, not a package size target.
export const DESKTOP_EXTENSION_ZIP_MAX_BYTES = 64 * 1024 * 1024;
export const DESKTOP_EXTENSION_ZIP_MAX_BASE64_LENGTH =
  4 * Math.ceil(DESKTOP_EXTENSION_ZIP_MAX_BYTES / 3);
export const DESKTOP_EXTENSION_MANIFEST_MAX_BYTES = 128 * 1024;
export const DESKTOP_EXTENSION_SCRIPT_MAX_BYTES = 2 * 1024 * 1024;
export const DESKTOP_EXTENSION_STYLE_MAX_BYTES = 256 * 1024;
export const DESKTOP_EXTENSION_ICON_MAX_BYTES = 128 * 1024;
export const DESKTOP_EXTENSION_SCREENSHOT_LIMIT = 4;
export const DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES = 512 * 1024;
/** Raw image bytes before base64 encoding, across one management list. */
export const DESKTOP_EXTENSION_LIST_SCREENSHOTS_MAX_BYTES = 8 * 1024 * 1024;
export const DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export const DESKTOP_EXTENSION_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const DESKTOP_EXTENSION_SETTINGS_MAX_BYTES = 1024 * 1024;

export const desktopExtensionIdSchema = installedPluginIdSchema;
export const desktopExtensionSlotSchema = z.enum([
  "sidebar.thread-layout",
  "sidebar.thread-badge",
  "appearance.theme",
]);
export type DesktopExtensionSlot = z.infer<typeof desktopExtensionSlotSchema>;

export const desktopExtensionCategorySchema = z.enum([
  "appearance",
  "interface",
  "workflow",
  "analytics",
  "integrations",
  "tools",
]);
export type DesktopExtensionCategory = z.infer<typeof desktopExtensionCategorySchema>;

const extensionName = z.string().trim().min(1).max(128);

export function desktopExtensionScreenshotMimeType(resource: string) {
  switch (resource.match(/\.([^./]+)$/u)?.[1]?.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

export function desktopExtensionAssetMimeType(resource: string) {
  switch (resource.match(/\.([^./]+)$/u)?.[1]?.toLowerCase()) {
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "woff2":
      return "font/woff2";
    case "json":
      return "application/json";
    case "css":
      return "text/css";
    default:
      return desktopExtensionScreenshotMimeType(resource);
  }
}

const hasPortableSegments = (resource: string) =>
  resource.split("/").every((segment) => !/[. ]$/u.test(segment));

export const desktopExtensionAssetPathSchema = pluginRelativeResourceSchema.refine(
  (resource) =>
    hasPortableSegments(resource) && desktopExtensionAssetMimeType(resource) !== undefined,
  "Expected a relative Desktop extension asset path with a supported suffix",
);

const imagePathSchema = pluginRelativeResourceSchema.refine(
  (resource) =>
    desktopExtensionScreenshotMimeType(resource) !== undefined && hasPortableSegments(resource),
  "Images must be relative .png, .jpg, .jpeg, or .webp paths with no segments ending in a dot or space",
);

export const desktopExtensionHttpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\/[^/?#\\\s]+/iu, "Expected an HTTP(S) URL")
  .pipe(z.url({ protocol: /^https?$/u }))
  .refine((value) => {
    const { username, password } = new URL(value);
    return !username && !password && !/[\\\s]/u.test(value);
  }, "URL must not contain credentials, backslashes, or whitespace");

function localizedText(text: z.ZodString) {
  return z.strictObject({ en: text, "zh-CN": text });
}

export const desktopExtensionLocalizedTextSchema = localizedText(z.string().trim().min(1));

const categoriesSchema = z
  .array(desktopExtensionCategorySchema)
  .max(desktopExtensionCategorySchema.options.length)
  .refine((categories) => new Set(categories).size === categories.length, "Duplicate categories");
const slotsSchema = z
  .array(desktopExtensionSlotSchema)
  .max(desktopExtensionSlotSchema.options.length)
  .refine((slots) => new Set(slots).size === slots.length, "Duplicate slots");

const settingField = {
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  label: desktopExtensionLocalizedTextSchema,
  description: desktopExtensionLocalizedTextSchema.optional(),
};
const numericSetting = {
  ...settingField,
  step: z.number().positive().optional(),
  default: z.number().optional(),
};
const settingOption = z.strictObject({
  value: z.string(),
  label: desktopExtensionLocalizedTextSchema,
});
export const desktopExtensionSettingFieldSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...settingField,
      type: z.literal("boolean"),
      default: z.boolean().optional(),
    }),
    z.strictObject({
      ...settingField,
      type: z.literal("string"),
      placeholder: desktopExtensionLocalizedTextSchema.optional(),
      default: z.string().optional(),
    }),
    z.strictObject({
      ...numericSetting,
      type: z.literal("number"),
      min: z.number().optional(),
      max: z.number().optional(),
    }),
    z.strictObject({
      ...numericSetting,
      type: z.literal("range"),
      min: z.number(),
      max: z.number(),
    }),
    z.strictObject({
      ...settingField,
      type: z.literal("select"),
      options: z.array(settingOption).min(1),
      default: z.string().optional(),
    }),
  ])
  .superRefine((field, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (field.type === "number" || field.type === "range") {
      const { min = -Infinity, max = Infinity, default: value } = field;
      if (min > max) issue("max", "Must be at least min");
      if (value !== undefined && (value < min || value > max))
        issue("default", "Must be within min and max");
    } else if (field.type === "select") {
      const values = new Set(field.options.map(({ value }) => value));
      if (values.size !== field.options.length) issue("options", "Duplicate option values");
      if (field.default !== undefined && !values.has(field.default))
        issue("default", "Must match an option value");
    }
  });
export type DesktopExtensionSettingField = z.infer<typeof desktopExtensionSettingFieldSchema>;

const manifestHeader = z
  .object({
    manifestVersion: z.int().positive(),
    id: desktopExtensionIdSchema,
    name: z.union([extensionName, localizedText(extensionName)]),
    version: z.string().min(1).max(128),
    desktopApi: z.int().positive(),
  })
  .passthrough();

export const desktopExtensionManifestSchema = manifestHeader
  .extend({
    manifestVersion: z.literal(1),
    desktopApi: z.literal(DESKTOP_EXTENSION_API_VERSION),
    description: z
      .strictObject({ en: z.string().max(4096), "zh-CN": z.string().max(4096).optional() })
      .optional(),
    author: z.string().trim().min(1).max(128).optional(),
    repository: desktopExtensionHttpUrlSchema.optional(),
    details: z
      .strictObject({ en: z.string().max(16384), "zh-CN": z.string().max(16384).optional() })
      .optional(),
    icon: imagePathSchema.optional(),
    screenshots: z
      .array(imagePathSchema)
      .max(DESKTOP_EXTENSION_SCREENSHOT_LIMIT)
      .refine(
        (screenshots) => new Set(screenshots).size === screenshots.length,
        "Duplicate screenshots",
      )
      .optional(),
    desktop: z
      .strictObject({
        script: pluginRelativeResourceSchema,
        style: pluginRelativeResourceSchema.optional(),
      })
      .optional(),
    backend: z
      .strictObject({ script: pluginRelativeResourceSchema.refine(hasPortableSegments) })
      .optional(),
    slots: slotsSchema.default(() => []),
    settingsSchema: z
      .array(desktopExtensionSettingFieldSchema)
      .max(32)
      .refine(
        (fields) => new Set(fields.map(({ key }) => key)).size === fields.length,
        "Duplicate setting keys",
      )
      .optional(),
    categories: categoriesSchema.optional(),
  })
  .strict()
  .refine(
    (manifest) => manifest.desktop !== undefined || manifest.backend !== undefined,
    "Expected at least one desktop or backend entry",
  );
export type DesktopExtensionManifest = z.infer<typeof desktopExtensionManifestSchema>;

export function resolveLocalizedExtensionText(
  value: string | { en: string; "zh-CN"?: string },
  locale: string,
): string {
  if (typeof value === "string") return value;
  return locale === "zh-CN" ? (value["zh-CN"] ?? value.en) : value.en;
}

export type DesktopExtensionManifestResult =
  | { state: "valid"; manifest: DesktopExtensionManifest }
  | { state: "invalid"; error: string }
  | { state: "incompatible"; error: string };

export function parseDesktopExtensionManifest(value: unknown): DesktopExtensionManifestResult {
  const header = manifestHeader.safeParse(value);
  if (!header.success) return { state: "invalid", error: z.prettifyError(header.error) };
  if (header.data.desktopApi > DESKTOP_EXTENSION_API_VERSION) {
    return {
      state: "incompatible",
      error: `Desktop API ${header.data.desktopApi} requires a newer codexhost`,
    };
  }
  const manifest = desktopExtensionManifestSchema.safeParse(value);
  return manifest.success
    ? { state: "valid", manifest: manifest.data }
    : { state: "invalid", error: z.prettifyError(manifest.error) };
}

export const desktopExtensionConfigurationSchema = z.strictObject({
  version: z.literal(1),
  revision: z.int().nonnegative(),
  enabled: z
    .array(desktopExtensionIdSchema)
    .max(DESKTOP_EXTENSION_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate extension IDs"),
  reloadToken: z.uuid().optional(),
});
export type DesktopExtensionConfiguration = z.infer<typeof desktopExtensionConfigurationSchema>;

export const desktopExtensionHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const desktopExtensionStatusSchema = z.strictObject({
  state: z.enum([
    "running",
    "disabled",
    "invalid",
    "incompatible",
    "conflict",
    "failed",
    "waiting",
  ]),
  hash: desktopExtensionHashSchema.optional(),
  error: z.string().optional(),
  conflictWith: desktopExtensionIdSchema.optional(),
});
export type DesktopExtensionStatus = z.infer<typeof desktopExtensionStatusSchema>;

export const desktopExtensionsDiagnosticSchema = z.strictObject({
  controllerPid: z.int().positive(),
  targetId: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  handledReloadToken: z.uuid().optional(),
  extensions: z.record(z.string(), desktopExtensionStatusSchema),
});
export type DesktopExtensionsDiagnostic = z.infer<typeof desktopExtensionsDiagnosticSchema>;

export const desktopExtensionTrustTierSchema = z.enum(["official", "community"]);
export type DesktopExtensionTrustTier = z.infer<typeof desktopExtensionTrustTierSchema>;

export function isGitHubDesktopExtensionZipballUrl(url: URL): boolean {
  return (
    url.origin === "https://api.github.com" &&
    /^\/repos\/[\w-]+\/[\w.-]+\/zipball(?:\/[^/]+)?\/?$/u.test(url.pathname)
  );
}

export const desktopExtensionZipUrlSchema = desktopExtensionHttpUrlSchema.refine((input) => {
  const url = new URL(input);
  return (
    /\.zip$/iu.test(url.pathname) ||
    isGitHubDesktopExtensionZipballUrl(url) ||
    (url.origin === "https://github.com" &&
      /^\/[\w-]+\/[\w.-]+\/zipball(?:\/.+)?\/?$/u.test(url.pathname)) ||
    (url.origin === "https://codeload.github.com" &&
      /^\/[\w-]+\/[\w.-]+\/(?:zip|zipball|legacy\.zip)\/.+$/u.test(url.pathname))
  );
}, "Expected a .zip download URL or a GitHub zipball URL");

export const desktopExtensionCatalogEntrySchema = z.strictObject({
  id: desktopExtensionIdSchema,
  version: z.string().trim().min(1).max(128),
  name: desktopExtensionLocalizedTextSchema.extend({ en: extensionName, "zh-CN": extensionName }),
  description: localizedText(z.string().trim().min(1).max(4096)),
  details: localizedText(z.string().trim().min(1).max(16384)).optional(),
  author: z.string().trim().min(1).max(128),
  repository: desktopExtensionHttpUrlSchema,
  stars: z.number().int().min(0).optional(),
  downloads: z.number().int().min(0).optional(),
  categories: categoriesSchema.optional(),
  trustTier: desktopExtensionTrustTierSchema.default("community"),
  icon: desktopExtensionHttpUrlSchema.optional(),
  screenshots: z
    .array(desktopExtensionHttpUrlSchema)
    .max(DESKTOP_EXTENSION_SCREENSHOT_LIMIT)
    .optional(),
  downloadUrl: desktopExtensionZipUrlSchema,
  sha256: desktopExtensionHashSchema,
  slots: slotsSchema.optional(),
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  minCodexHostVersion: z.string().optional(),
});
export const desktopExtensionCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  extensions: z
    .array(desktopExtensionCatalogEntrySchema)
    .refine(
      (entries) => new Set(entries.map(({ id }) => id)).size === entries.length,
      "Duplicate extension IDs",
    ),
});
export type DesktopExtensionCatalogEntry = z.infer<typeof desktopExtensionCatalogEntrySchema>;
export type DesktopExtensionCatalog = z.infer<typeof desktopExtensionCatalogSchema>;

const semver =
  /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/iu;
const order = <T extends string | bigint>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** Compare numeric versions and SemVer prereleases; unknown formats don't signal an update. */
export function compareExtensionVersions(a: string, b: string): number {
  const left = semver.exec(a.trim());
  const right = semver.exec(b.trim());
  if (!left || !right) return 0;
  for (const index of [1, 2, 3]) {
    const result = order(BigInt(left[index] ?? "0"), BigInt(right[index] ?? "0"));
    if (result) return result;
  }
  const preA = left[4]?.split(".");
  const preB = right[4]?.split(".");
  if (!preA || !preB) return order(BigInt(!preA), BigInt(!preB));
  for (const [index, x] of preA.entries()) {
    const y = preB[index];
    if (y === undefined) return 1;
    const numX = /^\d+$/u.test(x);
    const numY = /^\d+$/u.test(y);
    const result =
      numX && numY ? order(BigInt(x), BigInt(y)) : numX !== numY ? (numX ? -1 : 1) : order(x, y);
    if (result) return result;
  }
  return order(BigInt(preA.length), BigInt(preB.length));
}

export function resolveDesktopExtensionSlots(
  enabledOrder: readonly string[],
  manifests: Iterable<{ id: string; slots?: readonly DesktopExtensionSlot[] }>,
): { active: string[]; conflicts: Map<string, string> } {
  const byId = new Map(Array.from(manifests, ({ id, slots = [] }) => [id, slots]));
  const owners = new Map<DesktopExtensionSlot, string>();
  const conflicts = new Map<string, string>();
  const active: string[] = [];
  for (const id of new Set(enabledOrder)) {
    const slots = byId.get(id);
    if (!slots) continue;
    const conflictWith = slots.map((slot) => owners.get(slot)).find((owner) => owner !== undefined);
    if (conflictWith !== undefined) {
      conflicts.set(id, conflictWith);
      continue;
    }
    for (const slot of slots) owners.set(slot, id);
    active.push(id);
  }
  return { active, conflicts };
}

export const DESKTOP_EXTENSIONS_ASSET_METHOD = "codexhost/desktop/extensions/asset";
export const DESKTOP_EXTENSIONS_SETTINGS_GET_METHOD = "codexhost/desktop/extensions/settings/get";
export const DESKTOP_EXTENSIONS_SETTINGS_SET_METHOD = "codexhost/desktop/extensions/settings/set";
export const DESKTOP_EXTENSIONS_BACKEND_INVOKE_METHOD =
  "codexhost/desktop/extensions/backend/invoke";

const extensionIdParams = { id: desktopExtensionIdSchema };
export const desktopExtensionsAssetParamsSchema = z.strictObject({
  ...extensionIdParams,
  path: desktopExtensionAssetPathSchema,
});
export const desktopExtensionsAssetResultSchema = z.strictObject({
  mimeType: z.string(),
  dataUrl: z.string(),
});
export const desktopExtensionsSettingsGetParamsSchema = z.strictObject(extensionIdParams);
export const desktopExtensionsSettingsSetParamsSchema = z.strictObject({
  ...extensionIdParams,
  values: jsonObjectSchema,
});
export const desktopExtensionsSettingsResultSchema = z.strictObject({ values: jsonObjectSchema });
export const desktopExtensionBackendMethodSchema = z.string().trim().min(1).max(128);
export const desktopExtensionsBackendInvokeParamsSchema = z.strictObject({
  ...extensionIdParams,
  method: desktopExtensionBackendMethodSchema,
  params: jsonValueSchema.optional(),
});
export const desktopExtensionsBackendInvokeResultSchema = z.strictObject({
  result: jsonValueSchema,
});

export interface DesktopExtensionBackendContext {
  readonly extensionId: string;
  readonly extensionDir: string;
  readonly dataDir: string;
  readSettings(): Promise<Record<string, unknown>>;
  writeSettings(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  handle(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
}

export interface DesktopSidebarRow {
  readonly element: HTMLElement;
  readonly hostId: string | null;
  readonly isLocal: boolean;
  readonly threadId: string | null;
  readonly draftId: string | null;
  isConnected(): boolean;
}

export interface DesktopExtensionApiV1 {
  readonly id: string;
  readonly apiVersion: 1;
  readonly signal: AbortSignal;
  sidebar: { observeRows(cb: (rows: readonly DesktopSidebarRow[]) => void): () => void };
  threads: { watchTree(cb: (tree: ThreadTreeSnapshot) => void): () => void };
  navigate: { openThread(threadId: string): Promise<void> };
  harnesses: { describe(harnessId: string): { name: string; icon?: string } | undefined };
  dom: {
    mount(
      node: Element,
      parent: Element,
      position?: "append" | "prepend" | "before" | "after",
    ): void;
    mark(target: Element, name: string): void;
    unmark(target: Element, name: string): void;
  };
  track(teardown: () => void): void;
}

export type DesktopExtensionDispose = () => void | Promise<void>;
export interface DesktopExtensionDefinitionV1 {
  /* eslint-disable @typescript-eslint/no-invalid-void-type -- Preserve inferred void and Promise<void> for extensions without a disposer. */
  activate(
    api: DesktopExtensionApiV1,
  ): void | DesktopExtensionDispose | Promise<void | DesktopExtensionDispose>;
  /* eslint-enable @typescript-eslint/no-invalid-void-type */
}
export type DesktopExtensionDefine = (definition: DesktopExtensionDefinitionV1) => void;
