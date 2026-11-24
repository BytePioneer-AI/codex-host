/** Shared presentation, capability badge, filtering, version, and safety helpers for Host extensions UI. */
import {
  compareExtensionVersions,
  hostExtensionCapabilities,
  hostExtensionGitHubSourceSchema,
  hostExtensionTargets,
  resolveLocalizedExtensionText,
  type DesktopExtensionCategory,
  type DesktopExtensionSettingField,
  type HostExtensionCapabilities,
  type HostExtensionCatalogEntry,
  type HostExtensionInstallSource,
  type HostExtensionInstallation,
  type HostExtensionListItem,
  type HostExtensionManifestV2,
  type HostExtensionTarget,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  HostExtensionRpcError,
  isHostExtensionAuthDisabledError,
  isHostExtensionRevisionConflictError,
  isHostExtensionUnavailableError,
} from "./web-native-extension-management-api.ts";
import { resolveHostExtensionAssetUrl } from "./native-extensions/api.ts";

export type Translate = PropsLocale<"codexhostImport">["t"];
export type ExtensionLocale = "zh-CN" | "en";
export type HostExtensionValidItem = Extract<HostExtensionListItem, { state: "valid" }>;
export type ExtensionCapabilityFilter = "all" | "page" | "widget" | "web" | "desktop" | "backend";

export interface ExtensionPlatformBadge {
  readonly kind: "both" | HostExtensionTarget;
  readonly label: string;
}

export interface ExtensionCapabilityBadge {
  readonly kind: "page" | "widget" | "backend";
  readonly label: string;
}

export const CATEGORY_ORDER: readonly DesktopExtensionCategory[] = [
  "appearance",
  "interface",
  "workflow",
  "analytics",
  "integrations",
  "tools",
];

export const CAPABILITY_FILTER_ORDER: readonly ExtensionCapabilityFilter[] = [
  "all",
  "page",
  "widget",
  "web",
  "desktop",
  "backend",
];

export const MAX_CARD_CATEGORIES = 2;

const SAFE_SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
const SAFE_ICON_DATA_URL =
  /^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/u;

export function toExtensionLocale(rawLocale: string): ExtensionLocale {
  return rawLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function isValidHostItem(item: HostExtensionListItem): item is HostExtensionValidItem {
  return item.state === "valid";
}

export function isHostToggleBlocked(item: HostExtensionListItem): boolean {
  return !item.enabled && item.state !== "valid";
}

export function itemCapabilities(item: HostExtensionListItem): HostExtensionCapabilities | null {
  return item.state === "valid" ? hostExtensionCapabilities(item.manifest) : null;
}

export function itemTargets(item: HostExtensionListItem): HostExtensionTarget[] {
  return item.state === "valid" ? hostExtensionTargets(item.manifest) : [];
}

export function catalogCapabilities(entry: HostExtensionCatalogEntry): HostExtensionCapabilities {
  return {
    hasPage: Boolean(entry.apis.page),
    hasWidget: Boolean(entry.apis.widget),
    hasDesktop: Boolean(entry.apis.desktop),
    hasWeb: Boolean(entry.apis.web),
    hasBackend: Boolean(entry.apis.backend),
  };
}

export function derivePlatformBadge(
  targets: readonly HostExtensionTarget[],
  t: Translate,
): ExtensionPlatformBadge | null {
  const hasDesktop = targets.includes("desktop");
  const hasWeb = targets.includes("web");
  if (hasDesktop && hasWeb) return { kind: "both", label: t("extensions.platform.both") };
  if (hasDesktop) return { kind: "desktop", label: t("extensions.platform.desktopOnly") };
  if (hasWeb) return { kind: "web", label: t("extensions.platform.webOnly") };
  return null;
}

export function deriveHostCapabilityBadges(
  capabilities: HostExtensionCapabilities | null,
  t: Translate,
): readonly ExtensionCapabilityBadge[] {
  if (!capabilities) return [];
  const badges: ExtensionCapabilityBadge[] = [];
  if (capabilities.hasPage) {
    badges.push({ kind: "page", label: t("extensions.badge.page") });
  }
  if (capabilities.hasWidget) {
    badges.push({ kind: "widget", label: t("extensions.badge.widget") });
  }
  if (capabilities.hasBackend) {
    badges.push({ kind: "backend", label: t("extensions.badge.backend") });
  }
  return badges;
}

export function matchesCapabilityFilter(
  filter: ExtensionCapabilityFilter,
  capabilities: HostExtensionCapabilities | null,
  targets: readonly HostExtensionTarget[],
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "web":
    case "desktop":
      return targets.includes(filter);
    case "page":
      return capabilities?.hasPage ?? false;
    case "widget":
      return capabilities?.hasWidget ?? false;
    case "backend":
      return capabilities?.hasBackend ?? false;
  }
}

export function capabilityFilterLabel(filter: ExtensionCapabilityFilter, t: Translate): string {
  switch (filter) {
    case "all":
      return t("extensions.filter.all");
    case "page":
      return t("extensions.filter.page");
    case "widget":
      return t("extensions.filter.widget");
    case "web":
      return t("extensions.filter.web");
    case "desktop":
      return t("extensions.filter.desktop");
    case "backend":
      return t("extensions.filter.backend");
  }
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

export function hostDisplayName(
  item: HostExtensionListItem,
  locale: ExtensionLocale,
  catalogEntry?: HostExtensionCatalogEntry,
): string {
  if (item.state === "valid") return resolveLocalizedExtensionText(item.manifest.name, locale);
  if (catalogEntry) return resolveLocalizedExtensionText(catalogEntry.name, locale);
  return item.id;
}

export function hostDescription(
  item: HostExtensionListItem,
  locale: ExtensionLocale,
  catalogEntry?: HostExtensionCatalogEntry,
): string | null {
  return (
    (item.state === "valid"
      ? resolveOptionalLocalizedText(item.manifest.description, locale)
      : null) ??
    (catalogEntry ? resolveOptionalLocalizedText(catalogEntry.description, locale) : null)
  );
}

export function extensionPageTitle(
  manifest: HostExtensionManifestV2,
  locale: ExtensionLocale,
): string {
  return resolveLocalizedExtensionText(manifest.page?.title ?? manifest.name, locale);
}

export function extensionPageIconUrl({
  id,
  activationId,
  digest,
  manifest,
}: HostExtensionInstallation): string | undefined {
  return manifest.icon === undefined
    ? undefined
    : resolveHostExtensionAssetUrl({ id, activationId, digest, path: manifest.icon }, document);
}

export function resolveHostIconUrl(
  item: HostExtensionListItem | undefined,
  catalogOrIconUrl: HostExtensionCatalogEntry | string | undefined,
): string | undefined {
  const localIcon = item?.state === "valid" ? parseSafeIconUrl(item.iconDataUrl) : null;
  if (localIcon) return localIcon;
  const remoteRaw =
    typeof catalogOrIconUrl === "string" ? catalogOrIconUrl : catalogOrIconUrl?.icon;
  const remoteIcon = parseSafeIconUrl(remoteRaw);
  return remoteIcon ?? undefined;
}

export function resolveScreenshotUrls(
  item: HostExtensionListItem | undefined,
  catalogEntry: HostExtensionCatalogEntry | undefined,
): readonly string[] {
  const local = (item?.state === "valid" ? (item.screenshotDataUrls ?? []) : []).filter((url) =>
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

export function hasHostCatalogUpdate(
  installed: HostExtensionListItem | undefined,
  catalogEntry: HostExtensionCatalogEntry | undefined,
): boolean {
  if (!installed || installed.state !== "valid" || !catalogEntry) return false;
  return compareExtensionVersions(catalogEntry.version, installed.manifest.version) > 0;
}

export function needsAttention(item: HostExtensionListItem): boolean {
  return (
    item.state !== "valid" || item.backendState === "failed" || Boolean(item.desktopConflictWith)
  );
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
  state: HostExtensionValidItem["backendState"],
  t: Translate,
): string {
  switch (state) {
    case "none":
    case undefined:
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

export function formatPositiveExtensionCount(count: unknown): string | null {
  return isValidExtensionCount(count) && count > 0 ? formatExtensionCount(count) : null;
}

function matchesTokens(fields: readonly string[], normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = fields.join("\n").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function matchesInstalledSearch(
  item: HostExtensionListItem,
  normalizedQuery: string,
  t: Translate,
): boolean {
  if (!normalizedQuery) return true;
  const fields: string[] = [item.id];
  if (item.state === "valid") {
    const manifest = item.manifest;
    fields.push(manifest.name.en, manifest.name["zh-CN"]);
    if (manifest.author) fields.push(manifest.author);
    fields.push(manifest.description.en, manifest.description["zh-CN"]);
    if (manifest.details) {
      fields.push(manifest.details.en, manifest.details["zh-CN"]);
    }
    for (const category of manifest.categories ?? []) {
      fields.push(category, categoryLabel(category, t));
    }
  }
  return matchesTokens(fields, normalizedQuery);
}

export function matchesCatalogSearch(
  entry: HostExtensionCatalogEntry,
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

/**
 * Parse `owner/repo` or a GitHub URL into a validated `HostExtensionInstallSource` (`type: "github"`).
 */
export function parseHostGitHubSource(input: {
  readonly repoOrUrl: string;
  readonly ref?: string;
  readonly tag?: string;
  readonly asset?: string;
  readonly subpath?: string;
}): Extract<HostExtensionInstallSource, { type: "github" }> | null {
  const raw = input.repoOrUrl.trim();
  if (!raw) return null;
  let repository = raw;
  let ref = input.ref?.trim() || undefined;
  let tag = input.tag?.trim() || undefined;
  let asset = input.asset?.trim() || undefined;
  let subpath = input.subpath?.trim() || undefined;

  if (/^https?:\/\//iu.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
        return null;
      }
      const segments = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
      const owner = segments[0];
      const repo = segments[1]?.replace(/\.git$/iu, "");
      if (!owner || !repo) return null;
      repository = `${owner}/${repo}`;
      if (segments[2] === "tree" && segments[3]) {
        ref ??= decodeURIComponent(segments[3]);
        if (segments.length > 4) {
          subpath ??= segments.slice(4).map(decodeURIComponent).join("/");
        }
      } else if (
        segments[2] === "releases" &&
        segments[3] === "download" &&
        segments[4] &&
        segments[5]
      ) {
        tag ??= decodeURIComponent(segments[4]);
        asset ??= decodeURIComponent(segments[5]);
      } else if (segments[2] === "releases" && segments[3] === "tag" && segments[4]) {
        tag ??= decodeURIComponent(segments[4]);
      }
    } catch {
      return null;
    }
  } else {
    repository = raw.replace(/\.git$/iu, "").replace(/^\/+|\/+$/gu, "");
  }

  const candidate = {
    type: "github" as const,
    repository,
    ...(ref ? { ref } : {}),
    ...(tag ? { tag } : {}),
    ...(asset ? { asset } : {}),
    ...(subpath ? { subpath } : {}),
  };
  const checked = hostExtensionGitHubSourceSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

export function formatManagementError(error: unknown, t: Translate): string {
  if (isHostExtensionAuthDisabledError(error)) {
    return t("extensions.authDisabled");
  }
  if (isHostExtensionUnavailableError(error)) {
    return t("extensions.unavailable");
  }
  if (isHostExtensionRevisionConflictError(error)) {
    return t("extensions.error.stale");
  }
  if (error instanceof HostExtensionRpcError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
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
