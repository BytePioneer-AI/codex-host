import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import { KIRO_COMMANDS, KIRO_COMMAND_CATALOG } from "../src/commands.js";
import {
  KIRO_DEFAULT_MODELS,
  KIRO_DEFAULT_MODEL_CATALOG,
  parseKiroModelCatalog,
  parseKiroCliModels,
} from "../src/models.js";
import {
  KIRO_DEFAULT_PERMISSION_MODE_ID,
  KIRO_PERMISSION_MODES,
  KIRO_PERMISSION_MODE_CATALOG,
  decodeKiroPermissionMode,
  encodeKiroPermissionMode,
} from "../src/permission-modes.js";

describe("kiro models catalog", () => {
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
    expect(catalog.models[0]).toEqual({ ref: { id: "native-0" }, label: "Native 0" });
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
  it("defines native slash commands in catalog", () => {
    expect(KIRO_COMMAND_CATALOG.commands).toEqual(KIRO_COMMANDS);
    const invocations = KIRO_COMMANDS.map((c) => c.invocation);

    expect(invocations).toContain("/compact");
    expect(invocations).toContain("/kiro-context");
    expect(invocations).toContain("/kiro-usage");
    expect(invocations).toContain("/kiro-plan");
    expect(invocations).toContain("/kiro-spec");
    expect(invocations).toContain("/kiro-vibe");
  });
});
