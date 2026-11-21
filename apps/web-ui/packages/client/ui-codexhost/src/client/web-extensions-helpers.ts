/** Shared presentation, filtering, version, and safety helpers for Web extensions UI. */
import {
  WEB_EXTENSION_RPC_ERRORS,
  WEB_NATIVE_EXTENSION_API_VERSION,
  compareExtensionVersions,
  extensionBackendTargets,
  resolveLocalizedExtensionText,
  type DesktopExtensionCategory,
  type DesktopExtensionSettingField,
  type ExtensionCatalogV2Entry,
  type JsonObject,
  type JsonValue,
  type WebExtensionList,
  type WebNativeExtensionListItem,
  type WebUiExtension,
  type WebUiExtensionMeta,
} from "@codexhost/shared-contracts";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { ApiError } from "./api.ts";
import { formatWebExtensionError } from "./web-extension-errors.ts";

export type Translate = PropsLocale<"codexhostImport">["t"];
export type ExtensionLocale = "zh-CN" | "en";
export type WebExtensionItem = WebExtensionList["extensions"][number];
export type ExtensionGroupId = "attention" | "enabled" | "disabled";

export const CATEGORY_ORDER: readonly DesktopExtensionCategory[] = [
  "appearance",
  "interface",
  "workflow",
  "analytics",
  "integrations",
  "tools",
];

export const MAX_CARD_CATEGORIES = 2;

const SAFE_SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
const SAFE_ICON_DATA_URL =
  /^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/u;

export function toExtensionLocale(rawLocale: string): ExtensionLocale {
  return rawLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Composite `(format, id)` key so `codexhost` and `dsh` tracks never collide on bare ID. */
export function extensionKey(format: "codexhost" | "dsh", id: string): string {
  return `${format}:${id}`;
}

export function isNativeExtension(item: WebExtensionItem): item is WebNativeExtensionListItem {
  return item.format === "codexhost";
}

export function isDshExtension(item: WebExtensionItem): item is WebUiExtension {
  return item.format === "dsh";
}

export function isItemEnabled(item: WebExtensionItem): boolean {
  return isNativeExtension(item) ? item.enabled : item.enabledTargets.includes("web");
}

export function isNativeToggleBlocked(item: WebNativeExtensionListItem): boolean {
  return !item.enabled && item.manifest === undefined;
}

export function hasWebBackend(item: WebNativeExtensionListItem): boolean {
  return item.manifest !== undefined && extensionBackendTargets(item.manifest).includes("web");
}

export function parseSafeHttpUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function parseSafeIconUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (SAFE_ICON_DATA_URL.test(trimmed)) return trimmed;
  return parseSafeHttpUrl(trimmed);
}

export function resolveOptionalLocalizedText(
  value: { en: string; "zh-CN"?: string | undefined } | undefined,
  locale: ExtensionLocale,
): string | null {
  if (!value) return null;
  const localized =
    value["zh-CN"] !== undefined ? { en: value.en, "zh-CN": value["zh-CN"] } : { en: value.en };
  const trimmed = resolveLocalizedExtensionText(localized, locale).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function nativeDisplayName(
  item: WebNativeExtensionListItem,
  locale: ExtensionLocale,
  catalogEntry?: ExtensionCatalogV2Entry,
): string {
  if (item.manifest) return resolveLocalizedExtensionText(item.manifest.name, locale);
  if (catalogEntry) return resolveLocalizedExtensionText(catalogEntry.name, locale);
  return item.id;
}

export function nativeDescription(
  item: WebNativeExtensionListItem,
  locale: ExtensionLocale,
  catalogEntry?: ExtensionCatalogV2Entry,
): string | null {
  return (
    resolveOptionalLocalizedText(item.manifest?.description, locale) ??
    (catalogEntry ? resolveOptionalLocalizedText(catalogEntry.description, locale) : null)
  );
}

export function dshText(
  item: WebUiExtension,
  resolveText: (text: NonNullable<WebUiExtensionMeta["title"]>) => string,
): { title: string; description: string | null } {
  const title = item.meta?.title === undefined ? item.name : resolveText(item.meta.title);
  const description =
    item.meta?.description === undefined ? null : resolveText(item.meta.description).trim() || null;
  return { title, description };
}

export function resolveNativeIconUrl(
  item: WebNativeExtensionListItem | undefined,
  catalogEntry: ExtensionCatalogV2Entry | undefined,
): string | undefined {
  const localIcon = parseSafeIconUrl(item?.iconDataUrl);
  if (localIcon) return localIcon;
  const remoteIcon = parseSafeIconUrl(catalogEntry?.icon);
  return remoteIcon ?? undefined;
}

export function resolveScreenshotUrls(
  item: WebNativeExtensionListItem | undefined,
  catalogEntry: ExtensionCatalogV2Entry | undefined,
): readonly string[] {
  const local = (item?.screenshotDataUrls ?? []).filter((url) =>
    SAFE_SCREENSHOT_DATA_URL.test(url),
  );
  if (local.length > 0) return local;
  const remote: string[] = [];
  for (const raw of catalogEntry?.screenshots ?? []) {
    const safe = parseSafeHttpUrl(raw);
    if (safe) remote.push(safe);
  }
  return remote;
}

export function isCatalogEntryWebCompatible(entry: ExtensionCatalogV2Entry): boolean {
  if (!entry.targets.includes("web")) return false;
  if (entry.apis.web === undefined || entry.apis.web > WEB_NATIVE_EXTENSION_API_VERSION) {
    return false;
  }
  if (entry.apis.backend !== undefined && entry.apis.backend > 1) {
    return false;
  }
  return true;
}

export function hasNativeCatalogUpdate(
  installed: WebNativeExtensionListItem | undefined,
  catalogEntry: ExtensionCatalogV2Entry | undefined,
): boolean {
  if (!installed || !catalogEntry || !isCatalogEntryWebCompatible(catalogEntry)) return false;
  const installedVersion = installed.version ?? installed.manifest?.version;
  if (!installedVersion || !installed.digest) return false;
  return compareExtensionVersions(catalogEntry.version, installedVersion) > 0;
}

export function itemGroupOf(
  item: WebExtensionItem,
  dshLoadedIds: readonly string[],
  safeMode: boolean,
): ExtensionGroupId {
  if (isNativeExtension(item)) {
    if (item.error !== undefined || item.manifest === undefined || item.backendState === "failed") {
      return "attention";
    }
    return item.enabled ? "enabled" : "disabled";
  }
  if (item.loadError !== undefined || item.meta?.error !== undefined) {
    return "attention";
  }
  const enabled = item.enabledTargets.includes("web");
  if (enabled && !safeMode && !dshLoadedIds.includes(item.id)) {
    return "attention";
  }
  return enabled ? "enabled" : "disabled";
}

export function categoryLabelForLocale(
  category: DesktopExtensionCategory,
  locale: ExtensionLocale,
): string {
  if (locale === "zh-CN") {
    switch (category) {
      case "appearance":
        return "外观主题";
      case "interface":
        return "界面增强";
      case "workflow":
        return "效率与协作";
      case "analytics":
        return "数据与统计";
      case "integrations":
        return "外部集成";
      case "tools":
        return "实用工具";
    }
  }
  switch (category) {
    case "appearance":
      return "Appearance";
    case "interface":
      return "Interface";
    case "workflow":
      return "Workflow";
    case "analytics":
      return "Analytics";
    case "integrations":
      return "Integrations";
    case "tools":
      return "Tools";
  }
}

export function categoryLabel(category: DesktopExtensionCategory, t: Translate): string {
  switch (category) {
    case "appearance":
      return t("extensions.category.appearance");
    case "interface":
      return t("extensions.category.interface");
    case "workflow":
      return t("extensions.category.workflow");
    case "analytics":
      return t("extensions.category.analytics");
    case "integrations":
      return t("extensions.category.integrations");
    case "tools":
      return t("extensions.category.tools");
  }
}

export function backendStateLabel(
  state: WebNativeExtensionListItem["backendState"],
  t: Translate,
): string {
  switch (state) {
    case "none":
      return t("extensions.backend.none");
    case "inactive":
      return t("extensions.backend.inactive");
    case "starting":
      return t("extensions.backend.starting");
    case "running":
      return t("extensions.backend.running");
    case "failed":
      return t("extensions.backend.failed");
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${String(bytes)} B`;
}

export function isValidExtensionCount(count: unknown): count is number {
  return typeof count === "number" && Number.isInteger(count) && count >= 0;
}

export function formatExtensionCount(count: number): string {
  const normalized = Math.max(0, Math.floor(count));
  if (normalized < 1_000) return String(normalized);
  if (normalized < 10_000) {
    const rounded = Math.round((normalized / 1_000) * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  if (normalized < 1_000_000) return `${String(Math.round(normalized / 1_000))}k`;
  const roundedM = Math.round((normalized / 1_000_000) * 10) / 10;
  return `${Number.isInteger(roundedM) ? roundedM.toFixed(0) : roundedM.toFixed(1)}m`;
}

function matchesTokens(fields: readonly string[], normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = fields.join("\n").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function matchesInstalledSearch(
  item: WebExtensionItem,
  normalizedQuery: string,
  resolveText: (text: NonNullable<WebUiExtensionMeta["title"]>) => string,
  t: Translate,
): boolean {
  if (!normalizedQuery) return true;
  if (isNativeExtension(item)) {
    const fields: string[] = [item.id, "codexhost", "native"];
    const manifest = item.manifest;
    if (manifest) {
      if (typeof manifest.name === "string") fields.push(manifest.name);
      else fields.push(manifest.name.en, manifest.name["zh-CN"]);
      if (manifest.author) fields.push(manifest.author);
      if (manifest.description) {
        fields.push(manifest.description.en);
        if (manifest.description["zh-CN"]) fields.push(manifest.description["zh-CN"]);
      }
      if (manifest.details) {
        fields.push(manifest.details.en);
        if (manifest.details["zh-CN"]) fields.push(manifest.details["zh-CN"]);
      }
      for (const category of manifest.categories ?? []) {
        fields.push(category, categoryLabel(category, t));
      }
    }
    return matchesTokens(fields, normalizedQuery);
  }
  const { title, description } = dshText(item, resolveText);
  const fields = [item.id, item.name, title, "dsh", item.source];
  if (description) fields.push(description);
  return matchesTokens(fields, normalizedQuery);
}

export function matchesCatalogSearch(
  entry: ExtensionCatalogV2Entry,
  normalizedQuery: string,
  t: Translate,
): boolean {
  if (!normalizedQuery) return true;
  const fields: string[] = [
    entry.id,
    entry.name.en,
    entry.name["zh-CN"],
    entry.author,
    entry.description.en,
    entry.description["zh-CN"],
  ];
  if (entry.details) fields.push(entry.details.en, entry.details["zh-CN"]);
  for (const category of entry.categories ?? []) {
    fields.push(category, categoryLabel(category, t));
  }
  return matchesTokens(fields, normalizedQuery);
}

export function formatManagementError(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case WEB_EXTENSION_RPC_ERRORS.authDisabled:
        return t("extensions.authDisabled");
      case WEB_EXTENSION_RPC_ERRORS.stale:
        return t("extensions.error.stale");
      case WEB_EXTENSION_RPC_ERRORS.notFound:
        return t("extensions.error.notFound");
      case WEB_EXTENSION_RPC_ERRORS.inactive:
        return t("extensions.error.inactive");
      case WEB_EXTENSION_RPC_ERRORS.marketUnavailable:
        return t("extensions.error.marketUnavailable");
      case WEB_EXTENSION_RPC_ERRORS.invalidParams:
        return error.message || t("extensions.error.invalidParams");
      default:
        return formatWebExtensionError(error.message, t);
    }
  }
  const raw = error instanceof Error ? error.message : String(error);
  return formatWebExtensionError(raw, t);
}

export function fieldDefaultValue(field: DesktopExtensionSettingField): JsonValue {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "string":
      return "";
    case "number":
      return field.min ?? 0;
    case "range":
      return field.min;
    case "select":
      return field.options[0]?.value ?? "";
  }
}

export function coerceFieldValue(
  field: DesktopExtensionSettingField,
  raw: JsonValue | undefined,
): JsonValue {
  switch (field.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : fieldDefaultValue(field);
    case "string":
      return typeof raw === "string" ? raw : fieldDefaultValue(field);
    case "number":
    case "range":
      if (typeof raw === "number" && Number.isFinite(raw)) {
        if (field.min !== undefined && raw < field.min) return field.min;
        if (field.max !== undefined && raw > field.max) return field.max;
        return raw;
      }
      return fieldDefaultValue(field);
    case "select":
      if (typeof raw === "string" && field.options.some((opt) => opt.value === raw)) {
        return raw;
      }
      return fieldDefaultValue(field);
  }
}

/** Merge persisted settings with schema defaults in memory without mutating persisted keys. */
export function mergeSettingsWithDefaults(
  schema: readonly DesktopExtensionSettingField[],
  stored: JsonObject,
): JsonObject {
  const merged: JsonObject = { ...stored };
  for (const field of schema) {
    merged[field.key] = coerceFieldValue(field, stored[field.key]);
  }
  return merged;
}

export function buildDefaultSettings(
  schema: readonly DesktopExtensionSettingField[],
  existing: JsonObject,
): JsonObject {
  const next: JsonObject = { ...existing };
  for (const field of schema) {
    next[field.key] = fieldDefaultValue(field);
  }
  return next;
}
