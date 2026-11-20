import { describe, expect, it } from "vitest";

import {
  codexLocaleOverrideForSettingsSelection,
  rendererSettingsLanguageSelection,
  resolveRendererSettingsLocale,
} from "../../src/settings/localization.js";

describe("Renderer settings localization", () => {
  it("negotiates English and Chinese language tags with an English fallback", () => {
    expect(resolveRendererSettingsLocale(["zh-CN"])).toBe("zh-CN");
    expect(resolveRendererSettingsLocale(["zh-TW"])).toBe("zh-CN");
    expect(resolveRendererSettingsLocale(["en-GB"])).toBe("en");
    expect(resolveRendererSettingsLocale(["fr-FR", "zh-CN"])).toBe("zh-CN");
    expect(resolveRendererSettingsLocale(["fr-FR"])).toBe("en");
  });

  it("maps the bounded selector to Codex locale override values", () => {
    expect(rendererSettingsLanguageSelection(null)).toBe("automatic");
    expect(rendererSettingsLanguageSelection("en-GB")).toBe("en");
    expect(rendererSettingsLanguageSelection("zh-TW")).toBe("zh-CN");
    expect(rendererSettingsLanguageSelection("ja-JP")).toBe("other");
    expect(codexLocaleOverrideForSettingsSelection("automatic")).toBeNull();
    expect(codexLocaleOverrideForSettingsSelection("en")).toBe("en-US");
    expect(codexLocaleOverrideForSettingsSelection("zh-CN")).toBe("zh-CN");
  });
});
