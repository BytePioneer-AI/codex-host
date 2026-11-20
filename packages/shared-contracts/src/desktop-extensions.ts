import { z } from "zod";
import { installedPluginIdSchema, pluginRelativeResourceSchema } from "./harness-plugins.js";
import type { ThreadTreeSnapshot } from "./thread-tree-watch.js";

export const DESKTOP_EXTENSION_API_VERSION = 1;
export const DESKTOP_EXTENSION_LIMIT = 64;
export const DESKTOP_EXTENSION_MANIFEST_MAX_BYTES = 32 * 1024;
export const DESKTOP_EXTENSION_SCRIPT_MAX_BYTES = 2 * 1024 * 1024;
export const DESKTOP_EXTENSION_STYLE_MAX_BYTES = 256 * 1024;
export const DESKTOP_EXTENSION_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export const desktopExtensionIdSchema = installedPluginIdSchema;
export const desktopExtensionSlotSchema = z.enum(["sidebar.thread-layout", "sidebar.thread-badge"]);
export type DesktopExtensionSlot = z.infer<typeof desktopExtensionSlotSchema>;

export const desktopExtensionCategorySchema = z.enum([
  "sidebar",
  "composer",
  "conversation",
  "appearance",
  "tools",
  "workflow",
]);
export type DesktopExtensionCategory = z.infer<typeof desktopExtensionCategorySchema>;

const extensionName = z.string().trim().min(1).max(128);

const manifestHeader = z
  .object({
    manifestVersion: z.int().positive(),
    id: desktopExtensionIdSchema,
    name: z.union([extensionName, z.strictObject({ en: extensionName, "zh-CN": extensionName })]),
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
    desktop: z.strictObject({
      script: pluginRelativeResourceSchema,
      style: pluginRelativeResourceSchema.optional(),
    }),
    slots: z
      .array(desktopExtensionSlotSchema)
      .max(desktopExtensionSlotSchema.options.length)
      .refine((slots) => new Set(slots).size === slots.length, "Duplicate slots"),
    categories: z
      .array(desktopExtensionCategorySchema)
      .max(desktopExtensionCategorySchema.options.length)
      .refine(
        (categories) => new Set(categories).size === categories.length,
        "Duplicate categories",
      )
      .optional(),
  })
  .strict();
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
  if (Object.hasOwn(header.data, "backend")) {
    return {
      state: "incompatible",
      error: "This version only supports Desktop UI extensions (no backend)",
    };
  }
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

export function resolveDesktopExtensionSlots(
  enabledOrder: readonly string[],
  manifests: Iterable<Pick<DesktopExtensionManifest, "id" | "slots">>,
): { active: string[]; conflicts: Map<string, string> } {
  const byId = new Map(Array.from(manifests, ({ id, slots }) => [id, slots]));
  const owners = new Map<DesktopExtensionSlot, string>();
  const conflicts = new Map<string, string>();
  const active: string[] = [];
  for (const id of new Set(enabledOrder)) {
    const slots = byId.get(id);
    if (!slots) continue;
    const occupied = slots.find((slot) => owners.has(slot));
    if (occupied) {
      conflicts.set(id, owners.get(occupied)!);
      continue;
    }
    for (const slot of slots) owners.set(slot, id);
    active.push(id);
  }
  return { active, conflicts };
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
  activate(
    api: DesktopExtensionApiV1,
  ): void | DesktopExtensionDispose | Promise<void | DesktopExtensionDispose>;
}
export type DesktopExtensionDefine = (definition: DesktopExtensionDefinitionV1) => void;
