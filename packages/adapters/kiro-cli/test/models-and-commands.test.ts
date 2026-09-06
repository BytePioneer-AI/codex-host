import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import { KIRO_COMMANDS, KIRO_COMMAND_CATALOG, formatKiroCommandResult } from "../src/commands.js";
import {
  KIRO_DEFAULT_MODELS,
  KIRO_DEFAULT_MODEL_CATALOG,
  parseKiroModelCatalog,
  parseKiroCliModels,
  kiroThinkingState,
} from "../src/models.js";
import {
  KIRO_DEFAULT_PERMISSION_MODE_ID,
  KIRO_PERMISSION_MODES,
  KIRO_PERMISSION_MODE_CATALOG,
  decodeKiroPermissionMode,
  encodeKiroPermissionMode,
} from "../src/permission-modes.js";

describe("kiro models catalog", () => {
  it("keeps effort model-specific and uses the current model's confirmed options", () => {
    const config = [
      {
        id: "model",
        currentValue: "adjustable",
        options: [
          {
            value: "adjustable",
            name: "Adjustable",
            _meta: {
              kiro: {
                hasEffort: true,
                effortLevels: ["low", "high", "max"],
                defaultEffortLevel: "high",
              },
            },
          },
          { value: "fixed-paid", name: "Fixed Paid", _meta: { kiro: { hasEffort: false } } },
          { value: "auto", name: "Auto" },
          { value: "other", name: "Other", _meta: { kiro: { effortLevels: ["low", "medium"] } } },
        ],
      },
      {
        id: "effortLevel",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const catalog = parseKiroModelCatalog(config);
    expect(catalog.models.map((model) => model.supportedThinkingOptionIds)).toEqual([
      ["low", "high"],
      [],
      [],
      ["low", "medium"],
    ]);
    expect(catalog.defaultThinkingOptionId).toBe("high");
    expect(kiroThinkingState(config)).toEqual({
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });
    expect(kiroThinkingState([config[0]])).toEqual({ availableThinkingOptions: [] });
    expect(kiroThinkingState([{ ...config[0], currentValue: "auto" }, config[1]])).toEqual({
      availableThinkingOptions: [],
    });
    expect(
      parseKiroCliModels({
        default_model: "adjustable",
        models: [
          {
            model_id: "adjustable",
            model_name: "Adjustable",
            effortLevels: ["low", "high"],
            defaultEffortLevel: "high",
          },
          { model_id: "fixed-paid", model_name: "Fixed Paid" },
        ],
      }).models[1]?.supportedThinkingOptionIds,
    ).toEqual([]);
  });

  it("provides default model catalog with empty thinking options", () => {
    expect(KIRO_DEFAULT_MODEL_CATALOG.models).toEqual(KIRO_DEFAULT_MODELS);
    expect(KIRO_DEFAULT_MODEL_CATALOG.thinkingOptions).toEqual([]);
    expect(KIRO_DEFAULT_MODEL_CATALOG.defaultModel).toBeUndefined();
    expect(KIRO_DEFAULT_MODELS).toEqual([]);
  });

  it("reads native CLI field names without inventing a catalog or a default", () => {
    const models = Array.from({ length: 9 }, (_, i) => ({
      model_id: `native-${i}`,
      model_name: `Native ${i}`,
      rate_multiplier: 1,
    }));
    const catalog = parseKiroCliModels({ models, default_model: "native-4" });
    expect(catalog.models).toHaveLength(9);
    expect(catalog.models[0]).toEqual({
      ref: { id: "native-0" },
      label: "Native 0",
      supportedThinkingOptionIds: [],
    });
    expect(catalog.defaultModel?.id).toBe("native-4");
    expect(parseKiroCliModels({ models }).defaultModel).toBeUndefined();
    expect(() => parseKiroCliModels({ models: [] })).toThrow();
  });

  it("parses model catalog dynamically from ACP config options", () => {
    const configOptions = [
      {
        id: "model",
        currentValue: "claude-sonnet-4.5",
        options: [
          { value: "claude-haiku-4.5", label: "Haiku" },
          { value: "claude-sonnet-4.5", label: "Sonnet" },
        ],
      },
    ];

    const catalog = parseKiroModelCatalog(configOptions);
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]?.ref.id).toBe("claude-haiku-4.5");
    expect(catalog.models[1]?.ref.id).toBe("claude-sonnet-4.5");
    expect(catalog.defaultModel?.id).toBe("claude-sonnet-4.5");
    expect(catalog.thinkingOptions).toEqual([]);
  });

  it("falls back to default catalog when config options are empty or missing model option", () => {
    expect(parseKiroModelCatalog(undefined)).toBe(KIRO_DEFAULT_MODEL_CATALOG);
    expect(parseKiroModelCatalog([])).toBe(KIRO_DEFAULT_MODEL_CATALOG);
    expect(parseKiroModelCatalog([{ id: "other-config" }])).toBe(KIRO_DEFAULT_MODEL_CATALOG);
  });
});

describe("kiro permission modes", () => {
  it("defines autopilot and supervised modes with autopilot as default", () => {
    expect(KIRO_DEFAULT_PERMISSION_MODE_ID).toBe("autopilot");
    expect(KIRO_PERMISSION_MODE_CATALOG.defaultModeId).toBe("autopilot");

    const ids = KIRO_PERMISSION_MODES.map((m) => m.id);
    expect(ids).toContain("autopilot");
    expect(ids).toContain("supervised");
  });

  it("decodes permission mode to native autopilot on/off switch", () => {
    expect(decodeKiroPermissionMode(harnessPermissionModeIdSchema.parse("autopilot"))).toBe("on");
    expect(decodeKiroPermissionMode(harnessPermissionModeIdSchema.parse("supervised"))).toBe("off");
  });

  it("encodes native value to permission mode id", () => {
    expect(encodeKiroPermissionMode("off")).toBe("supervised");
    expect(encodeKiroPermissionMode(false)).toBe("supervised");
    expect(encodeKiroPermissionMode("on")).toBe("autopilot");
    expect(encodeKiroPermissionMode(true)).toBe("autopilot");
    expect(encodeKiroPermissionMode(undefined)).toBe("autopilot");
  });
});

describe("kiro slash commands", () => {
  it("renders native query results as sections and tables while preserving redaction", () => {
    expect(formatKiroCommandResult("kiro.spec", "spec")).toBe("**Kiro mode:** spec");
    const usage = formatKiroCommandResult("kiro.usage", {
      success: true,
      data: {
        planName: "KIRO FREE",
        billingCycleReset: "2026-10-01",
        overagesEnabled: false,
        usageBreakdowns: [{ displayName: "Credits", used: 0.59, limit: 50, percentage: 1 }],
      },
    });
    expect(usage).toContain("## Kiro Account Usage");
    expect(usage).toContain("| Plan | KIRO FREE |");
    expect(usage).toContain("| Credits | 0.59 | 50 | 1 |");
    const context = formatKiroCommandResult("kiro.context", {
      success: true,
      breakdown: {
        yourPrompts: { tokens: 31, percent: 3.9 },
        tools: { tokens: 5141, percent: 0.5 },
      },
    });
    expect(context).toContain("## Kiro Context Usage");
    expect(context).toContain("| Your prompts | 31 | 3.9 |");
    expect(context).toContain("| Tools | 5,141 | 0.5 |");
    const fallback = formatKiroCommandResult("kiro.context", {
      summary: "START" + "x".repeat(9000) + "END",
      inputTokens: 12,
      accessToken: "DO_NOT_EXPOSE",
      nested: { secret: "HIDDEN", text: "Bearer abc123" },
    });
    expect(fallback).toContain("START");
    expect(fallback).toContain("END");
    expect(fallback).toContain('"inputTokens": 12');
    expect(fallback).toContain("```json\n");
    expect(fallback).not.toMatch(/DO_NOT_EXPOSE|HIDDEN|abc123/u);
    expect(() => formatKiroCommandResult("kiro.usage", { success: false })).toThrow();
  });

  it("defines native slash commands in catalog", () => {
    expect(KIRO_COMMAND_CATALOG.commands).toEqual(KIRO_COMMANDS);
    const invocations = KIRO_COMMANDS.map((c) => c.invocation);

    expect(invocations).toContain("/compact");
    expect(invocations).toContain("/effort");
    expect(invocations).toContain("/kiro-context");
    expect(invocations).toContain("/kiro-usage");
    expect(invocations).toContain("/kiro-plan");
    expect(invocations).toContain("/kiro-spec");
    expect(invocations).toContain("/kiro-vibe");
  });
});
