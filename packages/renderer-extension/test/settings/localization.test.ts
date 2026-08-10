import { describe, expect, it } from "vitest";

import {
  codexLocaleOverrideForSettingsSelection,
  rendererSettingsLanguageSelection,
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
} from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";

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

  it("provides complete immutable English and Chinese settings catalogs", () => {
    const english = rendererSettingsMessages("en");
    const chinese = rendererSettingsMessages("zh-CN");

    expect(english.title).toBe("Settings");
    expect(chinese.title).toBe("设置");
    expect(chinese.interfaceLanguage).toBe("界面语言");
    expect(chinese.automaticLanguage).toBe("自动（跟随 Codex）");
    expect(chinese.openSettings).toBe("打开 codexhost 设置");
    expect(chinese.updateInstallation).toBe("安装方式");
    expect(chinese.updateInstallationWindowsInstaller).toBe("Windows 安装程序");
    expect(english.updateInstallationMacOsDmg).toBe("macOS DMG");
    expect(english.updateDownloadFromReleases).toBe("Download from GitHub Releases");
    expect(chinese.updateDownloadFromReleases).toBe("前往 GitHub Releases 下载");
    expect(Object.keys(chinese.pageLabels)).toEqual(Object.keys(english.pageLabels));
    expect(Object.isFrozen(english)).toBe(true);
    expect(Object.isFrozen(chinese.pageLabels)).toBe(true);
  });

  it("localizes every default page descriptor", () => {
    expect(
      createDefaultRendererSettingsPages(rendererSettingsMessages("zh-CN")).map(
        ({ label }) => label,
      ),
    ).toEqual(["连接", "模型池", "路由", "网关", "更新"]);
  });
});
