import { z } from "zod";
import {
  desktopExtensionBackendMethodSchema,
  desktopExtensionHashSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  parseDesktopExtensionManifest,
  type DesktopExtensionBackendContext,
  type DesktopExtensionDefinitionV1,
} from "./desktop-extensions.js";
import { pluginRelativeResourceSchema } from "./harness-plugins.js";
import type { JsonObject, JsonValue } from "./json-value.js";

const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu;
export const HOST_EXTENSION_PAGE_API_VERSION = 1;
export const hostExtensionIdSchema = desktopExtensionIdSchema.refine(
  (id) => !reservedName.test(id),
  "Reserved extension ID",
);
export const hostExtensionTargetSchema = z.enum(["desktop", "web"]);
export const hostExtensionDigestSchema = desktopExtensionHashSchema;
export const hostExtensionActivationIdSchema = z.uuid();
export const hostExtensionResourcePathSchema = pluginRelativeResourceSchema
  .refine(
    (resource) =>
      !/[\x00-\x1f\x7f<>"|*]/u.test(resource) &&
      resource.split("/").every((part) => !/[. ]$/u.test(part) && !reservedName.test(part)),
    "Expected a portable relative resource path",
  )
  .refine(
    (path) => path.split("/").length <= 32,
    "Extension resources may be at most 32 segments deep",
  );

export type HostExtensionTarget = z.infer<typeof hostExtensionTargetSchema>;
export type HostExtensionBackendContext = DesktopExtensionBackendContext;

const legacy = desktopExtensionManifestSchema.shape;
const localized = (max: number, min = 0) =>
  z.strictObject({
    en: z.string().trim().min(min).max(max),
    "zh-CN": z.string().trim().min(min).max(max),
  });
const resourceWithSuffix = (suffix: string) =>
  hostExtensionResourcePathSchema.refine(
    (path) => path.endsWith(suffix),
    `Expected a ${suffix} file`,
  );
const moduleEntry = resourceWithSuffix(".mjs");
const style = resourceWithSuffix(".css").optional();
export const hostExtensionCanonicalPath = (path: string) => path.normalize("NFC").toLowerCase();

/** Public static resources are data, never executable modules or active markup. */
export function hostExtensionStaticAssetMimeType(path: string): string | undefined {
  switch (/\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "woff2":
      return "font/woff2";
    case "json":
      return "application/json";
    default:
      return undefined;
  }
}

export const hostExtensionManifestV2Schema = z
  .strictObject({
    manifestVersion: z.literal(2),
    id: hostExtensionIdSchema,
    name: localized(128, 1),
    version: z.string().trim().min(1).max(128),
    description: localized(4096),
    details: localized(16384).optional(),
    author: legacy.author,
    repository: legacy.repository,
    icon: legacy.icon.refine(
      (path) => path === undefined || hostExtensionResourcePathSchema.safeParse(path).success,
    ),
    screenshots: legacy.screenshots.refine(
      (paths) =>
        paths === undefined ||
        paths.every((path) => hostExtensionResourcePathSchema.safeParse(path).success),
    ),
    categories: legacy.categories,
    settingsSchema: legacy.settingsSchema,
    slots: legacy.slots.removeDefault().optional(),
    page: z
      .strictObject({
        apiVersion: z.literal(HOST_EXTENSION_PAGE_API_VERSION),
        entry: moduleEntry,
        style,
        title: localized(128, 1).optional(),
      })
      .optional(),
    widget: z
      .strictObject({
        apiVersion: z.literal(HOST_EXTENSION_PAGE_API_VERSION),
        entry: moduleEntry,
        style,
      })
      .optional(),
    desktop: z
      .strictObject({ apiVersion: z.literal(1), script: resourceWithSuffix(".js"), style })
      .optional(),
    web: z
      .strictObject({ apiVersion: z.literal(1), entry: moduleEntry.optional(), style })
      .refine(
        ({ entry, style }) => entry !== undefined || style !== undefined,
        "Expected a Web entry or style",
      )
      .optional(),
    backend: z.strictObject({ apiVersion: z.literal(1), entry: moduleEntry }).optional(),
  })
  .refine(
    ({ page, widget, desktop, web, backend }) =>
      Boolean(page || widget || desktop || web || backend),
    "Expected at least one page, widget, desktop, web, or backend entry",
  )
  .refine(
    ({ page, widget, web, backend }) =>
      !backend ||
      [page?.entry, widget?.entry, web?.entry].every(
        (entry) =>
          entry === undefined ||
          hostExtensionCanonicalPath(entry) !== hostExtensionCanonicalPath(backend.entry),
      ),
    { path: ["backend", "entry"], message: "A backend entry cannot also be a frontend entry" },
  );

export type HostExtensionManifestV2 = z.infer<typeof hostExtensionManifestV2Schema>;
/** Both on-disk versions are exposed to consumers in canonical v2 form. */
export type HostExtensionManifest = HostExtensionManifestV2;
export type HostExtensionLocalizedText = HostExtensionManifest["name"];
export type HostExtensionCategory = NonNullable<HostExtensionManifest["categories"]>[number];
export type HostExtensionSettingField = NonNullable<
  HostExtensionManifest["settingsSchema"]
>[number];
export type HostExtensionManifestResult =
  | { state: "valid"; manifest: HostExtensionManifest }
  | { state: "invalid" | "incompatible"; error: string };

function normalizeText(
  value: string | { en: string; "zh-CN"?: string | undefined },
): HostExtensionLocalizedText {
  return typeof value === "string"
    ? { en: value, "zh-CN": value }
    : { en: value.en, "zh-CN": value["zh-CN"] ?? value.en };
}

export function parseHostExtensionManifest(value: unknown): HostExtensionManifestResult {
  const header = z.object({ manifestVersion: z.int().positive() }).safeParse(value);
  if (!header.success) return { state: "invalid", error: z.prettifyError(header.error) };
  if (header.data.manifestVersion > 2)
    return {
      state: "incompatible",
      error: `Manifest version ${header.data.manifestVersion} requires a newer codexhost`,
    };
  if (header.data.manifestVersion === 1) {
    const legacy = parseDesktopExtensionManifest(value);
    if (legacy.state !== "valid") return legacy;
    const { desktopApi, name, description, details, desktop, backend, ...metadata } =
      legacy.manifest;
    value = {
      ...metadata,
      manifestVersion: 2,
      name: normalizeText(name),
      description: normalizeText(description ?? ""),
      ...(details ? { details: normalizeText(details) } : {}),
      ...(desktop ? { desktop: { apiVersion: desktopApi, ...desktop } } : {}),
      ...(backend ? { backend: { apiVersion: 1, entry: backend.script } } : {}),
    };
  }
  const manifest = hostExtensionManifestV2Schema.safeParse(value);
  return manifest.success
    ? { state: "valid", manifest: manifest.data }
    : { state: "invalid", error: z.prettifyError(manifest.error) };
}

type Entries = Pick<HostExtensionManifest, "page" | "widget" | "desktop" | "web" | "backend">;
export interface HostExtensionCapabilities {
  hasPage: boolean;
  hasWidget: boolean;
  hasDesktop: boolean;
  hasWeb: boolean;
  hasBackend: boolean;
}
export function hostExtensionCapabilities(manifest: Entries): HostExtensionCapabilities {
  return {
    hasPage: Boolean(manifest.page),
    hasWidget: Boolean(manifest.widget),
    hasDesktop: Boolean(manifest.desktop),
    hasWeb: Boolean(manifest.web),
    hasBackend: Boolean(manifest.backend),
  };
}
export function hostExtensionTargets(manifest: Entries): HostExtensionTarget[] {
  return targetsForCapabilities(hostExtensionCapabilities(manifest));
}
export function targetsForCapabilities({
  hasPage,
  hasWidget,
  hasDesktop,
  hasWeb,
  hasBackend,
}: HostExtensionCapabilities): HostExtensionTarget[] {
  if (hasPage || hasWidget || (hasBackend && !hasDesktop && !hasWeb)) return ["desktop", "web"];
  const targets: HostExtensionTarget[] = [];
  if (hasDesktop) targets.push("desktop");
  if (hasWeb) targets.push("web");
  return targets;
}

export const HOST_EXTENSION_PAGE_CSS_VARIABLES = {
  background: "--cx-page-bg",
  surface: "--cx-page-surface",
  text: "--cx-page-text",
  mutedText: "--cx-page-text-muted",
  border: "--cx-page-border",
  accent: "--cx-page-accent",
  danger: "--cx-page-danger",
  radius: "--cx-page-radius",
} as const;

export type HostExtensionPageColorScheme = "light" | "dark";
export interface HostExtensionPageApi {
  readonly id: string;
  readonly apiVersion: typeof HOST_EXTENSION_PAGE_API_VERSION;
  readonly hostTarget: HostExtensionTarget;
  readonly locale: string;
  onLocaleChange(listener: (locale: string) => void): () => void;
  readonly colorScheme: HostExtensionPageColorScheme;
  onColorSchemeChange(listener: (scheme: HostExtensionPageColorScheme) => void): () => void;
  readonly signal: AbortSignal;
  assets: { url(relativePath: string): Promise<string> };
  storage: {
    get(): Promise<JsonObject>;
    set(values: JsonObject): Promise<JsonObject>;
    onChange(listener: (values: JsonObject) => void): () => void;
  };
  backend: { invoke(method: string, params?: JsonValue): Promise<JsonValue> };
}
export interface HostExtensionPageModule {
  mount(
    root: HTMLElement,
    api: HostExtensionPageApi,
  ): ReturnType<DesktopExtensionDefinitionV1["activate"]>;
}

export const hostExtensionBackendMethodSchema = desktopExtensionBackendMethodSchema;
export const HOST_EXTENSION_ASSETS_PREFIX = "/api/extensions/assets/";
type AssetIdentity = { id: string; activationId: string; digest: string };
export function hostExtensionAssetBaseUrl({ id, activationId, digest }: AssetIdentity): string {
  return `${HOST_EXTENSION_ASSETS_PREFIX}${hostExtensionIdSchema.parse(id)}/${hostExtensionActivationIdSchema.parse(activationId)}/${hostExtensionDigestSchema.parse(digest)}/`;
}
export function hostExtensionAssetUrl({
  path,
  ...identity
}: AssetIdentity & { path: string }): string {
  const resource = hostExtensionResourcePathSchema.parse(path);
  return (
    hostExtensionAssetBaseUrl(identity) + resource.split("/").map(encodeURIComponent).join("/")
  );
}
