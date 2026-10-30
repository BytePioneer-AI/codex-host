import { describe, expect, it } from "vitest";
import {
  accountCreditsWindowLabel,
  accountCreditsSnapshotSchema,
  harnessCommandDescriptorSchema,
  harnessInstallationStateSchema,
  harnessPermissionModeCatalogSchema,
  localizeHarnessPresentation,
  localizeHarnessText,
} from "../src/index.js";

describe("plugin-owned presentation", () => {
  it("round trips an unknown permission, with field fallback and unchanged semantics", () => {
    const catalog = harnessPermissionModeCatalogSchema.parse({
      defaultModeId: "future-policy",
      modes: [
        {
          id: "future-policy",
          label: "Native wording",
          description: "Native explanation",
          dangerous: true,
          localizations: {
            "zh-CN": { label: "插件策略", description: "插件说明" },
            fr: { label: "Politique", description: "Explication" },
            "fr-CA": { label: "Politique locale" },
          },
        },
      ],
    });
    const mode = catalog.modes[0];
    if (!mode) throw new Error("Missing permission fixture");
    const before = structuredClone(mode);
    expect(localizeHarnessPresentation(mode, "zh-CN")).toEqual({
      label: "插件策略",
      description: "插件说明",
    });
    expect(localizeHarnessPresentation(mode, "fr-CA")).toEqual({
      label: "Politique locale",
      description: "Explication",
    });
    expect(localizeHarnessPresentation(mode, "de")).toEqual({
      label: "Native wording",
      description: "Native explanation",
    });
    expect(mode).toEqual(before);
  });

  it("does not guess permission or command meaning from familiar IDs or words", () => {
    expect(localizeHarnessPresentation({ label: "Plan mode" }, "zh-CN").label).toBe("Plan mode");
    const command = harnessCommandDescriptorSchema.parse({
      id: "future.compact",
      invocation: "/compact",
      label: "Plugin meaning",
      argumentMode: "text",
    });
    expect(localizeHarnessPresentation(command, "zh-CN").label).toBe("Plugin meaning");
    expect(
      localizeHarnessPresentation({ label: "toString", localizations: {} }, "toString").label,
    ).toBe("toString");
  });

  it("bounds translation data and rejects behavior hidden in presentation fields", () => {
    const command = {
      id: "future.action",
      invocation: "/action",
      label: "Action",
      argumentMode: "none",
    };
    for (const localizations of [
      { "zh-CN": { dangerous: false } },
      { "zh-CN": { label: " " } },
      { "zh-CN": { description: "x".repeat(1_025) } },
      { "not a locale": { label: "Invalid" } },
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [
          `en-${String(i).padStart(2, "0")}`,
          { label: "Excess" },
        ]),
      ),
    ])
      expect(harnessCommandDescriptorSchema.safeParse({ ...command, localizations }).success).toBe(
        false,
      );
  });

  it("supports arbitrary plugin installation notices without a shared message-code registry", () => {
    const state = harnessInstallationStateSchema.parse({
      currentVersion: "1",
      latestVersion: "2",
      updateAvailable: true,
      canUpdate: false,
      messageCode: "future-custom-rule",
      notice: { en: "Use the native application", "zh-CN": "请使用原生应用" },
    });
    if (!state.notice) throw new Error("Missing notice fixture");
    expect(localizeHarnessText(state.notice, "zh-CN")).toBe("请使用原生应用");
    expect(localizeHarnessText(state.notice, "de")).toBe("Use the native application");
    expect(
      harnessInstallationStateSchema.safeParse({ ...state, notice: { "zh-CN": "没有回退" } })
        .success,
    ).toBe(false);
  });

  it("allows manual update downloads only through bounded credential-free HTTPS URLs", () => {
    const state = {
      currentVersion: "5.5.2",
      latestVersion: "5.8.4",
      updateAvailable: true,
      canUpdate: false,
    };
    expect(
      harnessInstallationStateSchema.parse({
        ...state,
        manualUpdateUrl: "https://download.codebuddy.ai/WorkBuddy.dmg",
      }).manualUpdateUrl,
    ).toBe("https://download.codebuddy.ai/WorkBuddy.dmg");
    for (const manualUpdateUrl of [
      "javascript:alert(1)",
      "file:///tmp/installer",
      "http://example.com/app.exe",
      "https://user:password@example.com/app.exe",
      "not a URL",
      `https://example.com/${"x".repeat(2048)}`,
    ])
      expect(harnessInstallationStateSchema.safeParse({ ...state, manualUpdateUrl }).success).toBe(
        false,
      );
  });

  it("preserves structured quota scope and never parses a translated product name", () => {
    const quota = accountCreditsSnapshotSchema.parse({
      usedPercent: 10,
      periodType: "five_hour",
      productUsage: [
        {
          product: "任何文案都可以",
          periodType: "seven_day",
          usagePercent: 20,
          scope: {
            id: "native-model-id",
            label: "Model group",
            localizations: { "zh-CN": { label: "模型组" } },
          },
        },
      ],
    });
    const product = quota.productUsage?.[0];
    if (!product) throw new Error("Missing quota fixture");
    expect(accountCreditsWindowLabel(product, "zh-CN", (period) => period)).toBe(
      "模型组 · seven_day",
    );
    expect(
      accountCreditsWindowLabel({ product: "Model · 7-day" }, "zh-CN", (period) => period),
    ).toBe("Model · 7-day");
  });
});
