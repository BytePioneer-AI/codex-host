import type { DefaultRendererSettingsPageId } from "./pages.js";

export const RENDERER_SETTINGS_LOCALES = ["en", "zh-CN"] as const;
export type RendererSettingsLocale = (typeof RENDERER_SETTINGS_LOCALES)[number];

export const RENDERER_SETTINGS_LANGUAGE_SELECTIONS = ["automatic", "en", "zh-CN", "other"] as const;
export type RendererSettingsLanguageSelection =
  (typeof RENDERER_SETTINGS_LANGUAGE_SELECTIONS)[number];
export type RendererSettingsWritableLanguageSelection = Exclude<
  RendererSettingsLanguageSelection,
  "other"
>;

export interface RendererSettingsLanguageControl {
  readonly available: boolean;
  readonly selection: RendererSettingsLanguageSelection;
  setSelection(selection: RendererSettingsWritableLanguageSelection): Promise<void>;
}

export interface RendererSettingsMessages {
  readonly locale: RendererSettingsLocale;
  readonly title: string;
  readonly close: string;
  readonly interfaceLanguage: string;
  readonly automaticLanguage: string;
  readonly englishLanguage: string;
  readonly simplifiedChineseLanguage: string;
  readonly otherCodexLanguage: string;
  readonly languageUpdateFailed: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly sectionsLabel: string;
  readonly noResults: string;
  readonly pageUnavailable: string;
  readonly availability: string;
  readonly notAvailable: string;
  readonly runtimeCapabilityNotInstalled: string;
  readonly runtimeStatus: string;
  readonly unavailable: string;
  readonly openSettings: string;
  readonly settingsButtonTitle: string;
  readonly settingsUnavailableTitle: string;
  readonly pageLabels: Readonly<Record<DefaultRendererSettingsPageId, string>>;
}

const ENGLISH_MESSAGES: RendererSettingsMessages = Object.freeze({
  locale: "en",
  title: "Settings",
  close: "Close settings",
  interfaceLanguage: "Interface language",
  automaticLanguage: "Automatic (follow Codex)",
  englishLanguage: "English",
  simplifiedChineseLanguage: "Simplified Chinese",
  otherCodexLanguage: "Other Codex language",
  languageUpdateFailed: "Could not update the language setting.",
  searchLabel: "Search settings",
  searchPlaceholder: "Search settings...",
  sectionsLabel: "Settings sections",
  noResults: "No results found",
  pageUnavailable: "Page unavailable",
  availability: "Availability",
  notAvailable: "Not available",
  runtimeCapabilityNotInstalled: "This runtime capability is not installed yet.",
  runtimeStatus: "Runtime status",
  unavailable: "Unavailable",
  openSettings: "Open codexhost settings",
  settingsButtonTitle: "codexhost settings",
  settingsUnavailableTitle: "codexhost settings unavailable",
  pageLabels: Object.freeze({
    overview: "Overview",
    routes: "Routes",
    providers: "Providers",
    credentials: "Credentials",
    "local-models": "Local Models",
    gateway: "Gateway",
  }),
});

const CHINESE_MESSAGES: RendererSettingsMessages = Object.freeze({
  locale: "zh-CN",
  title: "设置",
  close: "关闭设置",
  interfaceLanguage: "界面语言",
  automaticLanguage: "自动（跟随 Codex）",
  englishLanguage: "English",
  simplifiedChineseLanguage: "简体中文",
  otherCodexLanguage: "其他 Codex 语言",
  languageUpdateFailed: "无法更新语言设置。",
  searchLabel: "搜索设置",
  searchPlaceholder: "搜索设置...",
  sectionsLabel: "设置分类",
  noResults: "未找到结果",
  pageUnavailable: "页面不可用",
  availability: "可用性",
  notAvailable: "暂不可用",
  runtimeCapabilityNotInstalled: "运行时尚未安装该项能力，因此暂不可用。",
  runtimeStatus: "运行时状态",
  unavailable: "暂不可用",
  openSettings: "打开 codexhost 设置",
  settingsButtonTitle: "codexhost 设置",
  settingsUnavailableTitle: "codexhost 设置不可用",
  pageLabels: Object.freeze({
    overview: "概览",
    routes: "路由",
    providers: "提供商",
    credentials: "凭据",
    "local-models": "本地模型",
    gateway: "网关",
  }),
});

export const DEFAULT_RENDERER_SETTINGS_MESSAGES = ENGLISH_MESSAGES;

function languageFromTag(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag).language.toLowerCase();
  } catch {
    return undefined;
  }
}

export function resolveRendererSettingsLocale(
  languageTags: readonly string[],
): RendererSettingsLocale {
  for (const tag of languageTags) {
    const language = languageFromTag(tag);
    if (language === "zh") return "zh-CN";
    if (language === "en") return "en";
  }
  return "en";
}

export function rendererSettingsMessages(locale: RendererSettingsLocale): RendererSettingsMessages {
  return locale === "zh-CN" ? CHINESE_MESSAGES : ENGLISH_MESSAGES;
}

export function rendererSettingsLanguageSelection(
  localeOverride: string | null | undefined,
): RendererSettingsLanguageSelection {
  if (localeOverride == null) return "automatic";
  const language = languageFromTag(localeOverride);
  if (language === "zh") return "zh-CN";
  if (language === "en") return "en";
  return "other";
}

export function codexLocaleOverrideForSettingsSelection(
  selection: RendererSettingsWritableLanguageSelection,
): "en-US" | "zh-CN" | null {
  if (selection === "automatic") return null;
  return selection === "en" ? "en-US" : "zh-CN";
}
