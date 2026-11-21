import { z } from "zod";
import {
  DESKTOP_EXTENSION_LIMIT,
  desktopExtensionHashSchema,
  desktopExtensionIdSchema,
  type desktopExtensionLocalizedTextSchema,
  desktopExtensionManifestSchema,
  parseDesktopExtensionManifest,
  type DesktopExtensionManifest,
  type DesktopExtensionDispose,
  type DesktopExtensionBackendContext,
} from "./desktop-extensions.js";
import { pluginRelativeResourceSchema } from "./harness-plugins.js";
import type { JsonObject, JsonValue } from "./json-value.js";

export const WEB_NATIVE_EXTENSION_API_VERSION = 1;
export const extensionTargetSchema = z.enum(["desktop", "web"]);
export const extensionTargetsSchema = z
  .array(extensionTargetSchema)
  .min(1)
  .max(2)
  .refine((targets) => new Set(targets).size === targets.length, "Duplicate targets");
export type ExtensionTarget = z.infer<typeof extensionTargetSchema>;

const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu;
export const webNativeExtensionIdSchema = desktopExtensionIdSchema.refine(
  (id) => !reservedName.test(id),
  "Reserved extension ID",
);
export const webExtensionResourcePathSchema = pluginRelativeResourceSchema.refine(
  (resource) =>
    !/[\x00-\x1f\x7f<>"|*]/u.test(resource) &&
    resource.split("/").every((part) => !/[. ]$/u.test(part) && !reservedName.test(part)),
  "Expected a portable relative resource path",
);

const v1 = desktopExtensionManifestSchema.shape;
const backendTargets = (manifest: {
  desktop?: unknown;
  web?: unknown;
  backend?: { targets?: ExtensionTarget[] | undefined } | undefined;
}): ExtensionTarget[] => {
  if (!manifest.backend) return [];
  return (
    manifest.backend.targets ?? [
      ...(manifest.desktop ? (["desktop"] as const) : []),
      ...(manifest.web ? (["web"] as const) : []),
    ]
  );
};

export const codexHostExtensionManifestV2Schema = z
  .strictObject({
    manifestVersion: z.literal(2),
    id: webNativeExtensionIdSchema,
    name: v1.name,
    version: z.string().trim().min(1).max(128),
    description: v1.description,
    details: v1.details,
    author: v1.author,
    repository: v1.repository,
    icon: v1.icon,
    screenshots: v1.screenshots,
    categories: v1.categories,
    settingsSchema: v1.settingsSchema,
    slots: v1.slots,
    desktop: z
      .strictObject({
        apiVersion: z.literal(1),
        script: webExtensionResourcePathSchema,
        style: webExtensionResourcePathSchema.optional(),
      })
      .optional(),
    web: z
      .strictObject({
        apiVersion: z.literal(WEB_NATIVE_EXTENSION_API_VERSION),
        entry: webExtensionResourcePathSchema
          .refine((path) => path.endsWith(".mjs"), "Expected a .mjs entry")
          .optional(),
        style: webExtensionResourcePathSchema
          .refine((path) => path.endsWith(".css"), "Expected a .css style")
          .optional(),
      })
      .refine(
        ({ entry, style }) => entry !== undefined || style !== undefined,
        "Expected a Web script or style",
      )
      .optional(),
    backend: z
      .strictObject({
        apiVersion: z.literal(1),
        entry: webExtensionResourcePathSchema.refine(
          (path) => path.endsWith(".mjs"),
          "Expected a .mjs entry",
        ),
        targets: extensionTargetsSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (manifest) => Boolean(manifest.desktop || manifest.web || backendTargets(manifest).length),
    "Expected a desktop, Web, or explicitly targeted backend entry",
  );
export type CodexHostExtensionManifestV2 = z.infer<typeof codexHostExtensionManifestV2Schema>;
export type CodexHostExtensionManifest = DesktopExtensionManifest | CodexHostExtensionManifestV2;
export const codexHostExtensionManifestSchema = z.discriminatedUnion("manifestVersion", [
  desktopExtensionManifestSchema,
  codexHostExtensionManifestV2Schema,
]);

export function extensionBackendTargets(manifest: CodexHostExtensionManifest): ExtensionTarget[] {
  return manifest.manifestVersion === 1
    ? manifest.backend
      ? ["desktop"]
      : []
    : backendTargets(manifest);
}

export function extensionManifestTargets(manifest: CodexHostExtensionManifest): ExtensionTarget[] {
  const backend = extensionBackendTargets(manifest);
  return [
    ...(manifest.desktop || backend.includes("desktop") ? (["desktop"] as const) : []),
    ...((manifest.manifestVersion === 2 && manifest.web) || backend.includes("web")
      ? (["web"] as const)
      : []),
  ];
}

export function parseCodexHostExtensionManifest(
  value: unknown,
):
  | { state: "valid"; manifest: CodexHostExtensionManifest }
  | { state: "invalid" | "incompatible"; error: string } {
  const header = z.object({ manifestVersion: z.int().positive() }).safeParse(value);
  if (!header.success) return { state: "invalid", error: z.prettifyError(header.error) };
  if (header.data.manifestVersion === 1) return parseDesktopExtensionManifest(value);
  if (header.data.manifestVersion > 2)
    return {
      state: "incompatible",
      error: `Manifest version ${header.data.manifestVersion} requires a newer codexhost`,
    };
  const parsed = codexHostExtensionManifestV2Schema.safeParse(value);
  return parsed.success
    ? { state: "valid", manifest: parsed.data }
    : { state: "invalid", error: z.prettifyError(parsed.error) };
}

export const webExtensionActivationIdSchema = z.uuid();
export const WEB_EXTENSION_ASSETS_PREFIX = "/api/web-extensions/assets/";
export function webExtensionAssetBaseUrl({
  id,
  activationId,
  digest,
}: {
  id: string;
  activationId: string;
  digest: string;
}): string {
  return `${WEB_EXTENSION_ASSETS_PREFIX}${webNativeExtensionIdSchema.parse(id)}/${webExtensionActivationIdSchema.parse(activationId)}/${desktopExtensionHashSchema.parse(digest)}/`;
}

/** Encode individual portable path segments; never accept an absolute URL. */
export function encodeWebExtensionResourcePath(path: string): string {
  return webExtensionResourcePathSchema.parse(path).split("/").map(encodeURIComponent).join("/");
}

function isEntryUrl(url: string, base: string, suffix: string): boolean {
  if (!url.startsWith(base) || !url.endsWith(suffix)) return false;
  const relative = url.slice(base.length);
  try {
    return encodeWebExtensionResourcePath(decodeURIComponent(relative)) === relative;
  } catch {
    return false;
  }
}

export const webExtensionRuntimeEntrySchema = z
  .strictObject({
    id: webNativeExtensionIdSchema,
    version: v1.version,
    digest: desktopExtensionHashSchema,
    activationId: webExtensionActivationIdSchema,
    entryUrl: z.string().max(4096).optional(),
    styleUrl: z.string().max(4096).optional(),
    assetBaseUrl: z.string().max(4096),
    hasBackend: z.boolean(),
    settingsSchema: v1.settingsSchema,
    settingsRevision: z.uuid(),
  })
  .refine((entry) => {
    const { entryUrl, styleUrl, assetBaseUrl } = entry;
    // Refinements may run after field refinements have failed. Do not throw on bad input.
    try {
      return (
        assetBaseUrl === webExtensionAssetBaseUrl(entry) &&
        (entryUrl === undefined || isEntryUrl(entryUrl, assetBaseUrl, ".mjs")) &&
        (styleUrl === undefined || isEntryUrl(styleUrl, assetBaseUrl, ".css"))
      );
    } catch {
      return false;
    }
  }, "Expected versioned same-origin asset URLs for the active generation");
export const webExtensionRuntimeSnapshotSchema = z.strictObject({
  /** Opaque equality token; changes across restarts and when any runtime field changes. */
  revision: z.uuid(),
  extensions: z
    .array(webExtensionRuntimeEntrySchema)
    .max(DESKTOP_EXTENSION_LIMIT)
    .refine(
      (entries) => new Set(entries.map(({ id }) => id)).size === entries.length,
      "Duplicate runtime extension IDs",
    ),
});
export type WebExtensionRuntimeEntry = z.infer<typeof webExtensionRuntimeEntrySchema>;
export type WebExtensionRuntimeSnapshot = z.infer<typeof webExtensionRuntimeSnapshotSchema>;

export type ExtensionBackendContext = DesktopExtensionBackendContext;
export const WEB_EXTENSION_REGIONS = ["app", "topbar", "sidebar", "conversation"] as const;
export type WebExtensionRegion = (typeof WEB_EXTENSION_REGIONS)[number];
export type WebExtensionDispose = DesktopExtensionDispose;
export type WebExtensionMount = {
  container: HTMLElement;
  dispose: () => void;
};
export type WebExtensionRender = (
  container: HTMLElement,
  signal: AbortSignal,
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Render may not need a disposer. */
) => void | WebExtensionDispose | Promise<void | WebExtensionDispose>;
export type WebExtensionContribution = {
  id: string;
  title: z.infer<typeof desktopExtensionLocalizedTextSchema>;
  render: WebExtensionRender;
};

export interface WebExtensionApi {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly apiVersion: 1;
  dom: {
    /** HTMLElement parent or a stable data-cx-region value. Returns undefined if absent. */
    mount(
      target: HTMLElement | WebExtensionRegion,
      position?: "append" | "prepend",
    ): WebExtensionMount | undefined;
    mark(target: Element, name: string): void;
    unmark(target: Element, name: string): void;
  };
  track(dispose: WebExtensionDispose): void;
  assets: { url(path: string): string };
  storage: {
    get(): Promise<JsonObject>;
    set(values: JsonObject): Promise<JsonObject>;
    onChange(listener: (values: JsonObject) => void): () => void;
  };
  backend: { invoke(method: string, params?: JsonValue): Promise<JsonValue> };
  settings: { registerPage(page: WebExtensionContribution): () => void };
  panels: {
    register(panel: WebExtensionContribution & { placement: "main" | "sidebar" }): () => void;
  };
}
export interface WebExtensionModule {
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- A CSS/DOM-only extension may not need a disposer. */
  activate(api: WebExtensionApi): void | WebExtensionDispose | Promise<void | WebExtensionDispose>;
}
