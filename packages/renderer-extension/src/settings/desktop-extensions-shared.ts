import {
  compareExtensionVersions,
  resolveLocalizedExtensionText,
  type DesktopExtensionCatalogEntry,
  type DesktopExtensionCategory,
  type DesktopExtensionSlot,
  type DesktopExtensionStatus,
  type DesktopExtensionTrustTier,
  type DesktopExtensionsListResult,
} from "@codexhost/shared-contracts";
import {
  desktopExtensionsChinese,
  desktopExtensionsEnglish,
  type DesktopExtensionsMessages,
} from "./desktop-extensions-messages.js";
import { createRendererSettingsIcon, type RendererSettingsIconName } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export type DesktopExtensionItem = DesktopExtensionsListResult["extensions"][number];
export type DesktopExtensionBannerTone = "info" | "success" | "warning" | "danger";
export type DesktopExtensionGroupId = "attention" | "enabled" | "disabled";
export type DesktopExtensionMutationAction = "toggle" | "install" | "update" | "uninstall";
export type DesktopExtensionContentLocale = RendererSettingsMessages["locale"];
export type DesktopExtensionContentLocalePreference = "system" | DesktopExtensionContentLocale;

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
  installed: DesktopExtensionItem | undefined,
  catalogEntry: DesktopExtensionCatalogEntry | undefined,
): string | undefined {
  const localIcon = (installed as { readonly iconDataUrl?: string } | undefined)?.iconDataUrl;
  if (parseSafeExtensionIconUrl(localIcon)) return localIcon;
  const catalogIcon = (catalogEntry as { readonly icon?: string } | undefined)?.icon;
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

export function extensionGroupOf(state: DesktopExtensionStatus["state"]): DesktopExtensionGroupId {
  switch (state) {
    case "failed":
    case "conflict":
    case "invalid":
    case "incompatible":
      return "attention";
    case "running":
    case "waiting":
      return "enabled";
    case "disabled":
      return "disabled";
  }
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
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string {
  return item.manifest ? resolveLocalizedExtensionText(item.manifest.name, locale) : item.id;
}

export function extensionDescription(
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string | null {
  return resolveOptionalLocalizedText(item.manifest?.description, locale);
}

export function catalogDisplayName(
  entry: DesktopExtensionCatalogEntry,
  locale: RendererSettingsMessages["locale"],
): string {
  return resolveLocalizedExtensionText(entry.name, locale);
}

export function catalogDescription(
  entry: DesktopExtensionCatalogEntry,
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
  item: DesktopExtensionItem,
  locale: RendererSettingsMessages["locale"],
): string[] {
  const raw =
    resolveOptionalLocalizedText(item.manifest?.details, locale) ??
    extensionDescription(item, locale);
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
  installed: DesktopExtensionItem | undefined,
  catalogEntry: DesktopExtensionCatalogEntry | undefined,
): readonly string[] {
  const localUrls = (installed?.screenshotDataUrls ?? []).filter((url) =>
    SAFE_SCREENSHOT_DATA_URL_PATTERN.test(url),
  );
  if (localUrls.length > 0) return localUrls;
  const remoteUrls: string[] = [];
  for (const raw of catalogEntry?.screenshots ?? []) {
    const safe = parseSafeHttpUrl(raw);
    if (safe) remoteUrls.push(safe);
  }
  return remoteUrls;
}

export function hasCatalogUpdate(
  installed: DesktopExtensionItem | undefined,
  catalogEntry: DesktopExtensionCatalogEntry | undefined,
): boolean {
  const installedVersion = installed?.manifest?.version;
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
  extensions: readonly DesktopExtensionItem[],
  locale: RendererSettingsMessages["locale"],
): string {
  const other = extensions.find((item) => item.id === conflictWithId);
  const name = other?.manifest
    ? resolveLocalizedExtensionText(other.manifest.name, locale)
    : undefined;
  return name && name !== conflictWithId ? `${name} (${conflictWithId})` : conflictWithId;
}

export function overlappingSlots(
  target: DesktopExtensionItem,
  conflictWithId: string,
  extensions: readonly DesktopExtensionItem[],
): readonly DesktopExtensionSlot[] {
  const targetSlots = target.manifest?.slots ?? [];
  if (targetSlots.length === 0) return [];
  const otherSlots = extensions.find((item) => item.id === conflictWithId)?.manifest?.slots;
  if (!otherSlots || otherSlots.length === 0) return targetSlots;
  const shared = targetSlots.filter((slot) => otherSlots.includes(slot));
  return shared.length > 0 ? shared : targetSlots;
}

export function isToggleBlocked(item: DesktopExtensionItem): boolean {
  if (item.enabled) return false;
  return (
    item.status.state === "incompatible" ||
    item.status.state === "invalid" ||
    item.manifest === undefined
  );
}

export function blockedToggleReason(
  item: DesktopExtensionItem,
  copy: DesktopExtensionsMessages,
): string {
  if (item.status.error) return item.status.error;
  return item.status.state === "incompatible"
    ? copy.toggleDisabledIncompatible
    : copy.toggleDisabledInvalid;
}

export function resolveAttentionDetail(
  item: DesktopExtensionItem,
  allExtensions: readonly DesktopExtensionItem[],
  locale: RendererSettingsMessages["locale"],
  copy: DesktopExtensionsMessages,
): DesktopExtensionAttentionDetail | null {
  if (extensionGroupOf(item.status.state) !== "attention") return null;
  if (item.status.conflictWith) {
    const other = describeOtherExtension(item.status.conflictWith, allExtensions, locale);
    const shared = overlappingSlots(item, item.status.conflictWith, allExtensions);
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
  if (item.status.error) {
    return {
      tone: item.status.state === "incompatible" ? "warning" : "danger",
      text: item.status.error,
    };
  }
  if (isToggleBlocked(item)) {
    return {
      tone: item.status.state === "incompatible" ? "warning" : "danger",
      text: blockedToggleReason(item, copy),
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
  item: DesktopExtensionItem,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  const fields: string[] = [item.id];
  const manifest = item.manifest;
  if (manifest) {
    if (typeof manifest.name === "string") {
      fields.push(manifest.name);
    } else {
      fields.push(manifest.name.en, manifest.name["zh-CN"]);
    }
    if (manifest.author) fields.push(manifest.author);
    if (manifest.description) {
      fields.push(manifest.description.en);
      if (manifest.description["zh-CN"]) fields.push(manifest.description["zh-CN"]);
    }
    if (manifest.details) {
      fields.push(manifest.details.en);
      if (manifest.details["zh-CN"]) fields.push(manifest.details["zh-CN"]);
    }
    appendCategorySearchFields(fields, manifest.categories);
  }
  return matchesTokens(fields, normalizedQuery);
}

export function matchesCatalogSearchQuery(
  entry: DesktopExtensionCatalogEntry,
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
