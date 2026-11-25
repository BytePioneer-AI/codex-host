import {
  compareExtensionVersions,
  hostExtensionCapabilities,
  hostExtensionGitHubSourceSchema,
  hostExtensionTargets,
  resolveLocalizedExtensionText,
  type DesktopExtensionCategory,
  type DesktopExtensionSlot,
  type DesktopExtensionStatus,
  type DesktopExtensionTrustTier,
  type HostExtensionCapabilities,
  type HostExtensionCatalogEntry,
  type HostExtensionInstallSource,
  type HostExtensionListItem,
  type HostExtensionTarget,
} from "@codexhost/shared-contracts";
import {
  desktopExtensionsChinese,
  desktopExtensionsEnglish,
  type DesktopExtensionsMessages,
} from "./desktop-extensions-messages.js";
import { createRendererSettingsIcon, type RendererSettingsIconName } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export type HostExtensionValidItem = Extract<HostExtensionListItem, { state: "valid" }>;
export type DesktopExtensionItem = HostExtensionListItem;
export type DesktopExtensionBannerTone = "info" | "success" | "warning" | "danger";
export type DesktopExtensionMutationAction = "toggle" | "install" | "update" | "uninstall";
export type DesktopExtensionContentLocale = RendererSettingsMessages["locale"];
export type DesktopExtensionContentLocalePreference = "system" | DesktopExtensionContentLocale;

export const CONTENT_LOCALE_STORAGE_KEY = "codexhost.desktopExtensions.contentLocale";

export function readContentLocalePreference(
  ownerWindow: Window | null,
): DesktopExtensionContentLocalePreference {
  try {
    const storage =
      ownerWindow?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    const stored = storage?.getItem(CONTENT_LOCALE_STORAGE_KEY);
    if (stored === "system" || stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // Ignore restricted storage environments.
  }
  return "system";
}
export type ExtensionCapabilityFilter = "all" | "page" | "widget" | "web" | "desktop" | "backend";

export interface ExtensionPlatformBadge {
  readonly kind: "both" | HostExtensionTarget;
  readonly label: string;
}

export interface ExtensionCapabilityBadge {
  readonly kind: "page" | "widget" | "backend";
  readonly label: string;
}

export function contentLocaleMessages(
  locale: DesktopExtensionContentLocale,
): DesktopExtensionsMessages {
  return locale === "zh-CN" ? desktopExtensionsChinese : desktopExtensionsEnglish;
}

export interface DesktopExtensionFeedback {
  readonly tone: DesktopExtensionBannerTone;
  readonly text: string;
  readonly retryable?: boolean;
}

export interface DesktopExtensionAttentionDetail {
  readonly tone: "warning" | "danger";
  readonly text: string;
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

const SAFE_SCREENSHOT_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

const SAFE_ICON_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/u;

export type DesktopExtensionIconSize = "card" | "detail";

export interface CreateExtensionIconOptions {
  readonly document?: Document | undefined;
  readonly iconUrl?: string | null | undefined;
  readonly categories?: readonly DesktopExtensionCategory[] | undefined;
  readonly size: DesktopExtensionIconSize;
  readonly alt?: string | undefined;
}

export const EXTENSION_CATEGORY_ICON_MAP: Readonly<
  Record<DesktopExtensionCategory, RendererSettingsIconName>
> = Object.freeze({
  appearance: "palette",
  interface: "layout-grid",
  workflow: "zap",
  analytics: "chart-column",
  integrations: "plug",
  tools: "puzzle",
});

export function isValidHostExtensionItem(
  item: HostExtensionListItem,
): item is HostExtensionValidItem {
  return item.state === "valid";
}

export function itemCapabilities(item: HostExtensionListItem): HostExtensionCapabilities | null {
  if (item.state !== "valid") return null;
  return hostExtensionCapabilities(item.manifest);
}

export function itemTargets(item: HostExtensionListItem): HostExtensionTarget[] {
  if (item.state !== "valid") return [];
  return hostExtensionTargets(item.manifest);
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
  copy: DesktopExtensionsMessages,
): ExtensionPlatformBadge | null {
  const hasDesktop = targets.includes("desktop");
  const hasWeb = targets.includes("web");
  if (hasDesktop && hasWeb) return { kind: "both", label: copy.platformBoth };
  if (hasDesktop) return { kind: "desktop", label: copy.platformDesktopOnly };
  if (hasWeb) return { kind: "web", label: copy.platformWebOnly };
  return null;
}

export function deriveCapabilityBadges(
  capabilities: HostExtensionCapabilities | null,
  copy: DesktopExtensionsMessages,
): readonly ExtensionCapabilityBadge[] {
  if (!capabilities) return [];
  const badges: ExtensionCapabilityBadge[] = [];
  if (capabilities.hasPage) {
    badges.push({ kind: "page", label: copy.badgePage });
  }
  if (capabilities.hasWidget) {
    badges.push({ kind: "widget", label: copy.badgeWidget });
  }
  if (capabilities.hasBackend) {
    badges.push({ kind: "backend", label: copy.badgeBackend });
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

export function capabilityFilterLabel(
  filter: ExtensionCapabilityFilter,
  copy: DesktopExtensionsMessages,
): string {
  switch (filter) {
    case "all":
      return copy.filterAll;
    case "page":
      return copy.filterPage;
    case "widget":
      return copy.filterWidget;
    case "web":
      return copy.filterWeb;
    case "desktop":
      return copy.filterDesktop;
    case "backend":
      return copy.filterBackend;
  }
}

export function resolveExtensionIconCategory(
  categories: readonly DesktopExtensionCategory[] | undefined,
): DesktopExtensionCategory {
  const primary = categories?.[0];
  if (primary && Object.hasOwn(EXTENSION_CATEGORY_ICON_MAP, primary)) {
    return primary;
  }
  return "tools";
}

export function parseSafeExtensionIconUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (SAFE_ICON_DATA_URL_PATTERN.test(trimmed)) return trimmed;
  return parseSafeHttpUrl(trimmed);
}

export function resolveInstalledExtensionIconUrl(
  installed: HostExtensionListItem | undefined,
  catalogOrIconUrl: HostExtensionCatalogEntry | string | undefined,
): string | undefined {
  const localIcon = installed?.state === "valid" ? installed.iconDataUrl : undefined;
  if (parseSafeExtensionIconUrl(localIcon)) return localIcon;
  const catalogIcon =
    typeof catalogOrIconUrl === "string" ? catalogOrIconUrl : catalogOrIconUrl?.icon;
  if (parseSafeExtensionIconUrl(catalogIcon)) return catalogIcon;
  return undefined;
}

export function createExtensionIconElement(options: CreateExtensionIconOptions): HTMLSpanElement {
  const { document: targetDocument = document, iconUrl, categories, size, alt = "" } = options;
  const category = resolveExtensionIconCategory(categories);
  const iconName = EXTENSION_CATEGORY_ICON_MAP[category];
  const glyphSize = size === "detail" ? 22 : 16;

  const container = createEl(
    targetDocument,
    "span",
    `settings-extensions-icon settings-extensions-icon--${size}`,
  );
  container.dataset.iconSize = size;
  container.dataset.iconCategory = category;
  container.setAttribute("aria-hidden", "true");

  let renderedFallback = false;
  const renderFallback = (): void => {
    if (renderedFallback) return;
    renderedFallback = true;
    container.dataset.iconKind = "fallback";
    container.dataset.iconName = iconName;
    container.replaceChildren(createRendererSettingsIcon(iconName, glyphSize));
  };

  const safeUrl = parseSafeExtensionIconUrl(iconUrl);
  if (safeUrl) {
    container.dataset.iconKind = "image";
    const image = createEl(targetDocument, "img", "settings-extensions-icon__img");
    image.src = safeUrl;
    image.alt = alt;
    image.loading = "lazy";
    image.setAttribute("decoding", "async");
    image.addEventListener("error", renderFallback);
    container.append(image);
  } else {
    renderFallback();
  }

  return container;
}

export function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, key: string) => values[key] ?? match);
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWithinElement(target: EventTarget | null, container: HTMLElement): boolean {
  if (!target) return false;
  if (target === container) return true;
  if (typeof container.contains === "function") {
    try {
      return container.contains(target as Node);
    } catch {
      return false;
    }
  }
  return false;
}

export function itemStatusState(item: HostExtensionListItem): DesktopExtensionStatus["state"] {
  if (item.state !== "valid") {
    return item.state === "incompatible" ? "incompatible" : "invalid";
  }
  if (item.backendState === "failed") return "failed";
  if (item.desktopConflictWith) return "conflict";
  if (item.enabled && item.backendState === "starting") return "waiting";
  return item.enabled ? "running" : "disabled";
}

export function needsAttention(state: DesktopExtensionStatus["state"]): boolean {
  return (
    state === "failed" || state === "conflict" || state === "invalid" || state === "incompatible"
  );
}

export function statusTone(
  state: DesktopExtensionStatus["state"],
): DesktopExtensionBannerTone | "neutral" {
  if (state === "running") return "success";
  if (state === "waiting") return "info";
  if (state === "conflict" || state === "incompatible") return "warning";
  if (state === "failed" || state === "invalid") return "danger";
  return "neutral";
}

export function resolveOptionalLocalizedText(
  value: { en: string; "zh-CN"?: string | undefined } | undefined,
  locale: RendererSettingsMessages["locale"],
): string | null {
  if (!value) return null;
  const localized =
    value["zh-CN"] !== undefined ? { en: value.en, "zh-CN": value["zh-CN"] } : { en: value.en };
  const trimmed = resolveLocalizedExtensionText(localized, locale).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extensionDisplayName(
  item: HostExtensionListItem,
  locale: RendererSettingsMessages["locale"],
): string {
  return item.state === "valid"
    ? resolveLocalizedExtensionText(item.manifest.name, locale)
    : item.id;
}

export function extensionDescription(
  item: HostExtensionListItem,
  locale: RendererSettingsMessages["locale"],
): string | null {
  return item.state === "valid"
    ? resolveOptionalLocalizedText(item.manifest.description, locale)
    : null;
}

export function catalogDisplayName(
  entry: HostExtensionCatalogEntry,
  locale: RendererSettingsMessages["locale"],
): string {
  return resolveLocalizedExtensionText(entry.name, locale);
}

export function catalogDescription(
  entry: HostExtensionCatalogEntry,
  locale: RendererSettingsMessages["locale"],
): string | null {
  return resolveOptionalLocalizedText(entry.description, locale);
}

export function splitParagraphs(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n\s*\r?\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function extensionDetailsParagraphs(
  item: HostExtensionListItem,
  locale: RendererSettingsMessages["locale"],
): string[] {
  const raw =
    item.state === "valid"
      ? (resolveOptionalLocalizedText(item.manifest.details, locale) ??
        extensionDescription(item, locale))
      : null;
  return splitParagraphs(raw);
}

export function parseSafeHttpUrl(raw: string | undefined): string | null {
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

export const parseSafeRepositoryUrl = parseSafeHttpUrl;

export function safeScreenshotUrls(
  installed: HostExtensionListItem | undefined,
  catalogEntry: HostExtensionCatalogEntry | undefined,
): readonly string[] {
  const localUrls = (
    installed?.state === "valid" ? (installed.screenshotDataUrls ?? []) : []
  ).filter((url) => SAFE_SCREENSHOT_DATA_URL_PATTERN.test(url));
  if (localUrls.length > 0) return localUrls;
  const remoteUrls: string[] = [];
  for (const raw of catalogEntry?.screenshots ?? []) {
    const safe = parseSafeHttpUrl(raw);
    if (safe) remoteUrls.push(safe);
  }
  return remoteUrls;
}

export function hasCatalogUpdate(
  installed: HostExtensionListItem | undefined,
  catalogEntry: HostExtensionCatalogEntry | undefined,
): boolean {
  const installedVersion = installed?.state === "valid" ? installed.manifest.version : undefined;
  if (!installedVersion || !catalogEntry) return false;
  return compareExtensionVersions(catalogEntry.version, installedVersion) > 0;
}

export function formatSlotLabel(
  slot: DesktopExtensionSlot,
  copy: DesktopExtensionsMessages,
): string {
  const localized = copy.slots[slot];
  return localized ? `${localized} (${slot})` : slot;
}

export function describeOtherExtension(
  conflictWithId: string,
  extensions: readonly HostExtensionListItem[],
  locale: RendererSettingsMessages["locale"],
): string {
  const other = extensions.find((item) => item.id === conflictWithId);
  const name =
    other?.state === "valid"
      ? resolveLocalizedExtensionText(other.manifest.name, locale)
      : undefined;
  return name && name !== conflictWithId ? `${name} (${conflictWithId})` : conflictWithId;
}

export function overlappingSlots(
  target: HostExtensionListItem,
  conflictWithId: string,
  extensions: readonly HostExtensionListItem[],
): readonly DesktopExtensionSlot[] {
  const targetSlots = target.state === "valid" ? (target.manifest.slots ?? []) : [];
  if (targetSlots.length === 0) return [];
  const other = extensions.find((item) => item.id === conflictWithId);
  const otherSlots = other?.state === "valid" ? other.manifest.slots : undefined;
  if (!otherSlots || otherSlots.length === 0) return targetSlots;
  const shared = targetSlots.filter((slot) => otherSlots.includes(slot));
  return shared.length > 0 ? shared : targetSlots;
}

export function isToggleBlocked(item: HostExtensionListItem): boolean {
  if (item.enabled) return false;
  return item.state !== "valid";
}

export function blockedToggleReason(
  item: HostExtensionListItem,
  copy: DesktopExtensionsMessages,
): string {
  if (item.state !== "valid") {
    if (item.error) return item.error;
    return item.state === "incompatible"
      ? copy.toggleDisabledIncompatible
      : copy.toggleDisabledInvalid;
  }
  return copy.toggleDisabledInvalid;
}

export function resolveAttentionDetail(
  item: HostExtensionListItem,
  allExtensions: readonly HostExtensionListItem[],
  locale: RendererSettingsMessages["locale"],
  copy: DesktopExtensionsMessages,
): DesktopExtensionAttentionDetail | null {
  const state = itemStatusState(item);
  if (!needsAttention(state)) return null;
  if (item.state !== "valid") {
    return {
      tone: item.state === "incompatible" ? "warning" : "danger",
      text: item.error || blockedToggleReason(item, copy),
    };
  }
  if (item.backendState === "failed") {
    return {
      tone: "danger",
      text: item.backendError || copy.backendFailedNotice,
    };
  }
  if (item.desktopConflictWith) {
    const other = describeOtherExtension(item.desktopConflictWith, allExtensions, locale);
    const shared = overlappingSlots(item, item.desktopConflictWith, allExtensions);
    return {
      tone: "warning",
      text:
        shared.length > 0
          ? formatMessage(copy.conflictSlotDetails, {
              slots: shared.map((slot) => formatSlotLabel(slot, copy)).join(", "),
              other,
            })
          : formatMessage(copy.conflictOccupiedBy, { other }),
    };
  }
  return null;
}

function appendCategorySearchFields(
  fields: string[],
  categories: readonly DesktopExtensionCategory[] | undefined,
): void {
  if (!categories) return;
  for (const category of categories) {
    fields.push(
      category,
      desktopExtensionsEnglish.categories[category],
      desktopExtensionsChinese.categories[category],
    );
  }
}

function matchesTokens(fields: readonly string[], normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = fields.join("\n").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function matchesInstalledSearchQuery(
  item: HostExtensionListItem,
  normalizedQuery: string,
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
    appendCategorySearchFields(fields, manifest.categories);
  }
  return matchesTokens(fields, normalizedQuery);
}

export function matchesCatalogSearchQuery(
  entry: HostExtensionCatalogEntry,
  normalizedQuery: string,
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
  if (entry.details) {
    fields.push(entry.details.en, entry.details["zh-CN"]);
  }
  appendCategorySearchFields(fields, entry.categories);
  return matchesTokens(fields, normalizedQuery);
}

/**
 * Parse either `owner/repo` or a GitHub URL (repo, `/tree/<ref>/<subpath>`, or `/releases/download/<tag>/<asset>.zip`)
 * into a validated `HostExtensionInstallSource` of type `"github"`.
 */
export function parseGitHubInstallSource(input: {
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

export function formatShortDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isoDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (isoDate) return isoDate;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
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
  if (normalized < 1_000_000) {
    return `${Math.round(normalized / 1_000)}k`;
  }
  const roundedM = Math.round((normalized / 1_000_000) * 10) / 10;
  return `${Number.isInteger(roundedM) ? roundedM.toFixed(0) : roundedM.toFixed(1)}m`;
}

export function formatPositiveExtensionCount(count: unknown): string | null {
  return isValidExtensionCount(count) && count > 0 ? formatExtensionCount(count) : null;
}

export const isValidExtensionStarCount = isValidExtensionCount;
export const formatExtensionStarCount = formatExtensionCount;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let binary = "";
    for (const byte of chunk) {
      binary += String.fromCharCode(byte);
    }
    parts.push(binary);
  }
  return btoa(parts.join(""));
}

export function createTrustBadge(
  document: Document,
  tier: DesktopExtensionTrustTier,
  copy: DesktopExtensionsMessages,
): HTMLSpanElement {
  const badge = createEl(document, "span", "settings-extensions-trust-badge");
  badge.dataset.trustTier = tier;
  if (tier === "official") {
    badge.append(
      createRendererSettingsIcon("shield-check", 11),
      createEl(document, "span", "", copy.trustOfficial),
    );
  } else {
    badge.textContent = copy.trustCommunity;
  }
  return badge;
}
