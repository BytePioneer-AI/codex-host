import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  harnessModelCatalogSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";

import {
  buildModelCatalogFromAcp,
  buildModelCatalogFromConfig,
  decodeKimiModelRefId,
  encodeKimiModelRef,
  formatThinkingLabel,
  isKimiModeId,
  kimiPermissionModeCatalog,
  parseKimiConfigToml,
  readKimiThinkingOptions,
  resolveKimiContextWindow,
  type KimiNativeConfig,
} from "../src/models.js";

describe("Kimi Code Models & Config", () => {
  describe("ModelRef Encoding & Decoding", () => {
    it("encodes and decodes standard model aliases", () => {
      const alias = "claude-sonnet-5";
      const ref = encodeKimiModelRef(alias);
      expect(ref.id).toMatch(/^kimi\.[A-Za-z0-9_-]+$/);
      const decoded = decodeKimiModelRefId(ref.id);
      expect(decoded).toBe(alias);
    });

    it("encodes and decodes aliases with slashes and special characters without collision", () => {
      const aliasWithSlash = "moonshot/kimi-k2.5-preview";
      const ref = encodeKimiModelRef(aliasWithSlash);
      expect(decodeKimiModelRefId(ref.id)).toBe(aliasWithSlash);

      const aliasWithDash = "moonshot-kimi-k2.5-preview";
      const ref2 = encodeKimiModelRef(aliasWithDash);
      expect(decodeKimiModelRefId(ref2.id)).toBe(aliasWithDash);

      // Slashes and dashes must not produce the same ref
      expect(ref.id).not.toBe(ref2.id);
    });

    it("throws on invalid model ref id", () => {
      expect(() => decodeKimiModelRefId("other.invalid")).toThrow(/Invalid Kimi model ref ID/);
    });
  });

  describe("Permission Modes", () => {
    it("recognizes valid Kimi modes", () => {
      expect(isKimiModeId("default")).toBe(true);
      expect(isKimiModeId("plan")).toBe(true);
      expect(isKimiModeId("auto")).toBe(true);
      expect(isKimiModeId("yolo")).toBe(true);
      expect(isKimiModeId("superuser")).toBe(false);
      expect(isKimiModeId(null)).toBe(false);
    });

    it("validates permission mode catalog against schema", () => {
      const parsed = harnessPermissionModeCatalogSchema.parse(kimiPermissionModeCatalog);
      expect(parsed.defaultModeId).toBe("default");
      expect(parsed.modes.map((m) => m.id)).toEqual(["default", "plan", "auto", "yolo"]);
      const yoloMode = parsed.modes.find((m) => m.id === "yolo");
      expect(yoloMode?.dangerous).toBe(true);
    });
  });

  describe("parseKimiConfigToml", () => {
    it("parses valid config.toml with models and thinking", () => {
      const toml = `
default_model = "relay"

[models.relay]
model = "claude-sonnet-5"
provider = "bedrock"
max_context_size = 200000
capabilities = ["thinking"]
support_efforts = ["low", "high"]
default_effort = "high"

[models.kimi]
model = "kimi-k2"
provider = "moonshot"

[thinking]
enabled = true
effort = "high"
`;
      const config = parseKimiConfigToml(toml);
      expect(config.defaultModel).toBe("relay");
      expect(config.models).toHaveLength(2);
      expect(config.models[0]).toEqual({
        alias: "relay",
        model: "claude-sonnet-5",
        provider: "bedrock",
        maxContextSize: 200000,
        capabilities: ["thinking"],
        supportEfforts: ["low", "high"],
        defaultEffort: "high",
      });
      expect(config.models[1]).toEqual({
        alias: "kimi",
        model: "kimi-k2",
        provider: "moonshot",
      });
      expect(config.thinking).toEqual({
        enabled: true,
        effort: "high",
      });
    });

    it("parses minimal config.toml without models", () => {
      const toml = `
default_model = "test"
`;
      const config = parseKimiConfigToml(toml);
      expect(config.defaultModel).toBe("test");
      expect(config.models).toEqual([]);
    });

    it("throws on invalid toml syntax", () => {
      expect(() => parseKimiConfigToml("invalid = [toml")).toThrow(
        /Failed to parse Kimi config.toml/,
      );
    });
  });

  describe("buildModelCatalogFromConfig", () => {
    it("builds valid schema-conforming catalog", () => {
      const config: KimiNativeConfig = {
        defaultModel: "relay",
        models: [
          { alias: "relay", model: "claude-sonnet-5" },
          { alias: "deepseek", model: "deepseek-r1" },
        ],
        thinking: { enabled: true, effort: "high" },
      };

      const catalog = buildModelCatalogFromConfig(config);
      const validated = harnessModelCatalogSchema.parse(catalog);

      expect(validated.models).toHaveLength(2);
      const firstModel = validated.models[0];
      expect(firstModel).toBeDefined();
      if (!firstModel) return;
      expect(decodeKimiModelRefId(firstModel.ref.id)).toBe("relay");
      expect(firstModel.label).toBe("relay (claude-sonnet-5)");
      expect(firstModel.resolvedModelLabel).toBe("claude-sonnet-5");
      expect(validated.defaultModel?.id).toBe(firstModel.ref.id);
      expect(validated.defaultThinkingOptionId).toBeUndefined();
      expect(validated.thinkingOptions).toEqual([]);
      expect(firstModel.supportedThinkingOptionIds).toEqual([]);
    });

    it("maps declared Thinking per model without sharing options with undeclared models", () => {
      const config = parseKimiConfigToml(`
default_model = "effort"
[models.effort]
capabilities = ["thinking"]
support_efforts = ["low", "high", "high"]
default_effort = "high"
[models.toggle]
capabilities = ["thinking"]
[models.always]
capabilities = ["always_thinking"]
support_efforts = ["low", "high"]
[models.always_toggle]
capabilities = ["thinking", "always_thinking"]
[models.unknown]
[models.efforts_only]
support_efforts = ["max"]
`);
      const catalog = harnessModelCatalogSchema.parse(buildModelCatalogFromConfig(config));
      expect(catalog.models.map((model) => model.supportedThinkingOptionIds)).toEqual([
        ["off", "low", "high"],
        ["off", "on"],
        ["low", "high"],
        ["on"],
        [],
        [],
      ]);
      expect(catalog.thinkingOptions).toEqual([
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "on", label: "On" },
      ]);
      expect(catalog.defaultThinkingOptionId).toBe("high");
    });

    it.each([
      { thinking: { enabled: false, effort: "high" }, expected: "off" },
      { thinking: { enabled: true, effort: "low" }, expected: "low" },
      { thinking: { effort: "max" }, expected: undefined },
    ])("uses only the selected model's declared default: $thinking", ({ thinking, expected }) => {
      const catalog = buildModelCatalogFromConfig({
        defaultModel: "selected",
        models: [
          { alias: "selected", capabilities: ["thinking"], supportEfforts: ["low", "high"] },
          { alias: "other", capabilities: ["thinking"], supportEfforts: ["max"] },
        ],
        thinking,
      });
      expect(catalog.defaultThinkingOptionId).toBe(expected);
    });

    it("does not infer selectable options from a disabled config setting", () => {
      const config: KimiNativeConfig = {
        models: [{ alias: "base" }],
        thinking: { enabled: false },
      };

      const catalog = buildModelCatalogFromConfig(config);
      const validated = harnessModelCatalogSchema.parse(catalog);
      expect(validated.defaultThinkingOptionId).toBeUndefined();
      expect(validated.thinkingOptions).toEqual([]);
    });

    it("falls back to default model when config has no models or defaults", () => {
      const catalog = buildModelCatalogFromConfig({ models: [] });
      expect(catalog.models).toHaveLength(1);
      const fallbackModel = catalog.models[0];
      expect(fallbackModel).toBeDefined();
      if (fallbackModel) {
        expect(decodeKimiModelRefId(fallbackModel.ref.id)).toBe("default");
      }
    });
  });

  describe("buildModelCatalogFromAcp", () => {
    it("does not invent options or select the first option without a native current value", () => {
      expect(readKimiThinkingOptions([])).toEqual([]);
      expect(buildModelCatalogFromAcp([]).thinkingOptions).toEqual([]);
      expect(
        buildModelCatalogFromAcp([{ id: "thinking", options: [{ value: "on", name: "On" }] }])
          .defaultThinkingOptionId,
      ).toBeUndefined();
    });

    it("reads grouped native options without assuming effort names", () => {
      expect(
        readKimiThinkingOptions([
          {
            id: "thinking",
            options: [
              {
                name: "Native",
                options: [
                  { value: "off", name: "Thinking Off" },
                  { value: "on", name: "Thinking On" },
                ],
              },
            ],
          },
        ]),
      ).toEqual([
        { id: "off", label: "Off" },
        { id: "on", label: "On" },
      ]);
    });
    it("builds catalog from ACP session config options", () => {
      const acpOptions: SessionConfigOption[] = [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "relay",
          options: [
            { value: "relay", name: "Claude Sonnet 5 (Relay)" },
            { value: "direct", name: "Kimi Direct" },
          ],
        },
        {
          id: "thinking",
          name: "Thinking Effort",
          type: "select",
          currentValue: "high",
          options: [
            { value: "off", name: "Thinking Off" },
            { value: "high", name: "Thinking High" },
          ],
        },
      ];

      const catalog = buildModelCatalogFromAcp(acpOptions);
      const validated = harnessModelCatalogSchema.parse(catalog);

      expect(validated.models).toHaveLength(2);
      const firstModel = validated.models[0];
      expect(firstModel).toBeDefined();
      if (!firstModel) return;
      expect(decodeKimiModelRefId(firstModel.ref.id)).toBe("relay");
      expect(firstModel.label).toBe("Claude Sonnet 5 (Relay)");
      expect(validated.defaultModel?.id).toBe(firstModel.ref.id);
      expect(validated.defaultThinkingOptionId).toBe("high");
      expect(firstModel.supportedThinkingOptionIds).toEqual(["off", "high"]);
      expect(validated.models[1]?.supportedThinkingOptionIds).toBeUndefined();
      expect(validated.thinkingOptions).toEqual([
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ]);
    });

    it("strips 'Thinking ' prefix and capitalizes tier names", () => {
      expect(formatThinkingLabel("Thinking Off")).toBe("Off");
      expect(formatThinkingLabel("Thinking Low")).toBe("Low");
      expect(formatThinkingLabel("Thinking Medium")).toBe("Medium");
      expect(formatThinkingLabel("Thinking High")).toBe("High");
      expect(formatThinkingLabel("Thinking Xhigh")).toBe("Xhigh");
      expect(formatThinkingLabel("Thinking Max")).toBe("Max");
      expect(formatThinkingLabel("off")).toBe("Off");
      expect(formatThinkingLabel("low")).toBe("Low");
    });

    it("falls back to config if ACP models are empty", () => {
      const fallbackConfig: KimiNativeConfig = {
        defaultModel: "fallback-m",
        models: [{ alias: "fallback-m", capabilities: ["thinking"], supportEfforts: ["high"] }],
      };

      const catalog = buildModelCatalogFromAcp([], fallbackConfig);
      expect(catalog.thinkingOptions).toEqual([]);
      expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual([]);
      expect(catalog.models).toHaveLength(1);
      const fallbackModel = catalog.models[0];
      expect(fallbackModel).toBeDefined();
      if (fallbackModel) {
        expect(decodeKimiModelRefId(fallbackModel.ref.id)).toBe("fallback-m");
      }
    });
  });

  describe("resolveKimiContextWindow", () => {
    it("resolves context window from config model", () => {
      const config: KimiNativeConfig = {
        defaultModel: "relay",
        models: [
          { alias: "relay", model: "claude-sonnet-5", maxContextSize: 200000 },
          { alias: "small", maxContextSize: 32000 },
        ],
      };
      expect(resolveKimiContextWindow("relay", config)).toBe(200000);
      expect(resolveKimiContextWindow("small", config)).toBe(32000);
      expect(resolveKimiContextWindow("unknown", config)).toBe(200000);
      expect(resolveKimiContextWindow(undefined, null)).toBe(200000);
    });
  });
});
