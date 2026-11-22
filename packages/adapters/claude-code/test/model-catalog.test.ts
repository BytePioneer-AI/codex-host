import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_DEFAULT_MODEL_REF,
  claudeModelValue,
  normalizeStoredClaudeModelRef,
  mergeClaudeModelPickerOptions,
  normalizeClaudeModelCatalog,
  parseClaudeModelPickerSettings,
  readClaudeUserModelPicker,
  resolveClaudeConfigDirectory,
} from "../src/model-catalog.js";
import { fitClaudeThinkingOptionId } from "../src/thinking-options.js";

function snapshot(models: unknown) {
  return { models, canSelectModel: true, canSelectPermissionMode: true };
}

describe("Claude Code runtime Model catalog", () => {
  it("keeps native IDs in the catalog and resolves a stored Ref to the same Model", () => {
    const id = "provider/模型 [1m]";
    const { catalog } = normalizeClaudeModelCatalog(
      snapshot([{ value: id, displayName: "Custom" }]),
    );
    const encoded = `claude-model-v1.${Buffer.from(id).toString("base64url")}`;
    const selected = normalizeStoredClaudeModelRef(
      harnessModelRefSchema.parse({ id: encoded }),
      catalog,
    );
    expect(catalog.models.map(({ ref }) => ref.id)).toEqual(["default", id]);
    expect(selected && claudeModelValue(selected)).toBe(id);
    expect(claudeModelValue(CLAUDE_DEFAULT_MODEL_REF)).toBeUndefined();
  });

  it.each([
    ["fable", ["sonnet", "claude-fable-5-2"], "claude-fable-5-2"],
    ["Claude-FABLE [1M]", ["claude-fable-5-1", "claude-fable-5-1[1m]"], "claude-fable-5-1[1m]"],
    ["fable", ["sonnet"], undefined],
    ["fable", ["claude-fable-5", "claude-fable-5-1"], undefined],
    ["fable[1m]", ["claude-fable-5-2"], undefined],
    ["fable[custom]", ["claude-fable-5-2"], undefined],
    ["provider/fable", ["claude-fable-5-2"], undefined],
    ["claude-fable-5-1", ["claude-fable-5-2"], undefined],
    ["fable", ["fable", "claude-fable-5-2"], "fable"],
    ["claude-fable-5-2", ["claude-fable-5-2"], "claude-fable-5-2"],
    ["sonnet", ["sonnet", "claude-fable-5-2"], "sonnet"],
  ] as const)("normalizes stored %s with catalog IDs %j", (id, values, expected) => {
    const { catalog } = normalizeClaudeModelCatalog(
      snapshot(values.map((value) => ({ value, displayName: value }))),
    );
    expect(normalizeStoredClaudeModelRef(harnessModelRefSchema.parse({ id }), catalog)).toEqual(
      expected === undefined ? undefined : { id: expected },
    );
  });

  it.each([undefined, "", " \t ", "ignored"])(
    "preserves default, aliases, and custom rows with description %j",
    (description) => {
      const normalized = normalizeClaudeModelCatalog(
        snapshot([
          {
            value: "default",
            displayName: "Default",
            description: "ignored",
            resolvedModel: "runtime-custom",
          },
          {
            value: "sonnet",
            displayName: "Family",
            description: "ignored",
            resolvedModel: "runtime-custom",
            supportsEffort: true,
            supportedEffortLevels: ["low", "adaptive-v2", "high", "adaptive-v2"],
          },
          {
            value: "custom-model",
            displayName: "Family",
            description,
            resolvedModel: "runtime-custom",
            provider: { baseUrl: "https://private.invalid", apiKey: "secret" },
            price: 42,
          },
        ]),
      );

      expect(normalized.catalog.models).toHaveLength(3);
      expect(new Set(normalized.catalog.models.map(({ ref }) => ref.id)).size).toBe(3);
      expect(new Set(normalized.catalog.models.map(({ label }) => label)).size).toBe(3);
      expect(
        normalized.catalog.models.filter(
          ({ resolvedModelLabel }) => resolvedModelLabel === "runtime-custom",
        ),
      ).toHaveLength(3);
      expect(normalized.catalog.defaultModel).toEqual(CLAUDE_DEFAULT_MODEL_REF);
      expect(normalized.catalog.thinkingOptions).toEqual([
        { id: "off", label: "Off" },
        { id: "auto", label: "Auto" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
        { id: "ultracode", label: "Ultracode" },
      ]);
      expect(normalized.catalog.defaultThinkingOptionId).toBe("auto");
      expect(
        normalized.catalog.models.find(({ label }) => label.startsWith("Family (sonnet"))
          ?.supportedThinkingOptionIds,
      ).toEqual(["off", "auto", "low", "high"]);
      expect(JSON.stringify(normalized.catalog)).not.toMatch(
        /private|apiKey|price|supportsEffort/u,
      );
    },
  );

  it("uses deterministic bounded labels for long duplicate display names", () => {
    const displayName = "D".repeat(250);
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        { value: `a-${"x".repeat(100)}`, displayName },
        { value: `b-${"x".repeat(100)}`, displayName },
      ]),
    );
    const duplicateLabels = normalized.catalog.models
      .filter(({ ref }) => ref.id !== CLAUDE_DEFAULT_MODEL_REF.id)
      .map(({ label }) => label);

    expect(duplicateLabels).toHaveLength(2);
    expect(new Set(duplicateLabels).size).toBe(2);
    expect(duplicateLabels.every((label) => label.length <= 256)).toBe(true);
    expect(duplicateLabels).toEqual([...duplicateLabels].sort());
  });

  it("synthesizes only the dynamic default control when runtime omitted that row", () => {
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        {
          value: "custom-model",
          displayName: "Custom",
          description: "ignored",
          supportedEffortLevels: [{ future: true }],
        },
      ]),
    );

    expect(normalized.catalog.models.map(({ ref }) => ref.id)).toEqual(["default", "custom-model"]);
    expect(normalized.catalog.models[0]).toMatchObject({ label: "Default" });
    expect(normalized.catalog.models[0]).not.toHaveProperty("resolvedModelLabel");
    expect(normalized.catalog.models[1]).not.toHaveProperty("resolvedModelLabel");
  });

  it("offers each Model only the Thinking options its native capabilities report", () => {
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        {
          value: "opus",
          displayName: "Opus",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          supportsAdaptiveThinking: true,
          supportsThinkingOff: true,
        },
        {
          value: "antigravity/gemini-4-argon",
          displayName: "Gemini Argon",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
          supportsThinkingOff: false,
        },
        {
          value: "antigravity/gemini-4-carbon",
          displayName: "Gemini Carbon",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          supportsThinkingOff: true,
        },
        { value: "haiku", displayName: "Haiku", supportsThinkingOff: true },
        {
          value: "no-effort",
          displayName: "No effort",
          supportsEffort: false,
          supportedEffortLevels: ["high"],
        },
        { value: "legacy", displayName: "Legacy", supportsFastMode: true },
      ]),
    );
    const options = (value: string) =>
      normalized.catalog.models.find(({ ref }) => ref.id === value)?.supportedThinkingOptionIds;
    const all = ["off", "auto", "low", "medium", "high", "xhigh", "max", "ultracode"];

    expect(options("opus")).toEqual(all);
    expect(options("antigravity/gemini-4-argon")).toEqual(["auto", "low", "medium", "high"]);
    expect(options("antigravity/gemini-4-carbon")).toEqual([
      "off",
      "auto",
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
    ]);
    expect(options("haiku")).toEqual(["off", "auto"]);
    expect(options("no-effort")).toEqual(["off", "auto"]);
    // Neither the synthesized default row nor an older CLI's row reports capabilities.
    expect(normalized.catalog.models[0]?.supportedThinkingOptionIds).toEqual(all);
    expect(options("legacy")).toEqual(all);
  });

  it("clamps a Thinking choice to the Model's highest effort not above it", () => {
    const ids = (...values: string[]) =>
      values.map((value) => harnessThinkingOptionIdSchema.parse(value));
    const fit = (requested: string, supported: string[] | undefined) =>
      fitClaudeThinkingOptionId(
        harnessThinkingOptionIdSchema.parse(requested),
        supported && ids(...supported),
      );
    const gemini = ["auto", "low", "medium", "high"];
    expect(fit("high", gemini)).toBe("high");
    expect(fit("xhigh", gemini)).toBe("high");
    expect(fit("max", gemini)).toBe("high");
    expect(fit("ultracode", gemini)).toBe("high");
    expect(fit("max", ["auto", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(fit("medium", ["auto", "low", "high"])).toBe("low");
    expect(fit("low", ["auto", "medium", "high"])).toBe("auto");
    expect(fit("off", ["auto", "low"])).toBe("auto");
    expect(fit("xhigh", ["off", "auto"])).toBe("auto");
    expect(fit("xhigh", undefined)).toBe("xhigh");
    // The supported levels are a set: the highest one at or below the requested
    // effort wins whatever order the caller lists them in.
    expect(fit("max", ["auto", "high", "low"])).toBe("high");
    expect(fit("max", ["low", "auto", "high"])).toBe("high");
    expect(fit("xhigh", ["xhigh", "auto", "medium"])).toBe("xhigh");
  });

  it("merges duplicate Model rows whose effort levels differ only in order", () => {
    const normalized = normalizeClaudeModelCatalog(
      snapshot([
        { value: "sonnet", displayName: "Sonnet", supportedEffortLevels: ["low", "high"] },
        {
          value: "sonnet",
          displayName: "Sonnet",
          supportedEffortLevels: ["high", "low", "low"],
        },
      ]),
    );
    expect(
      normalized.catalog.models.find(({ ref }) => ref.id === "sonnet")?.supportedThinkingOptionIds,
    ).toEqual(["off", "auto", "low", "high"]);
  });

  it("rejects unavailable, empty, malformed, conflicting, and unbounded observations", () => {
    for (const value of [
      {
        models: [],
        canSelectModel: true,
        canSelectPermissionMode: true,
      },
      {
        models: "not-an-array",
        canSelectModel: true,
        canSelectPermissionMode: true,
      },
      snapshot([{ value: "", displayName: "Bad" }]),
      snapshot([{ value: "valid", displayName: "" }]),
      ...[null, 1, {}, [], "x".repeat(257)].map((description) =>
        snapshot([{ value: "valid", displayName: "Valid", description }]),
      ),
      snapshot([
        { value: "same", displayName: "First" },
        { value: "same", displayName: "Second" },
      ]),
    ]) {
      expect(() => normalizeClaudeModelCatalog(value)).toThrow();
    }
    expect(() =>
      normalizeClaudeModelCatalog({
        models: [],
        canSelectModel: false,
        canSelectPermissionMode: false,
      }),
    ).toThrow("unavailable");
  });
});

describe("Claude Code modelPicker.settings merge", () => {
  const builtins = [
    { value: "default", displayName: "Default", supportsAutoMode: true },
    { value: "haiku", displayName: "Haiku" },
    { value: "sonnet", displayName: "Sonnet" },
    { value: "opus", displayName: "Opus" },
  ];

  it("appends custom gateway rows when replaceBuiltInOptions is false", () => {
    const merged = mergeClaudeModelPickerOptions(builtins, {
      replaceBuiltInOptions: false,
      options: [
        {
          model: "glm-glm-5.3-cp[1m]",
          label: "glm-glm-5.3-cp (1M)",
          description: "custom gateway",
        },
        {
          model: "gpt-5.6-sol[1m]",
          label: "gpt-5.6-sol (1M)",
          description: "custom gateway",
        },
        { model: "sonnet", label: "Ignored duplicate" },
      ],
    });

    expect(merged).toEqual([
      ...builtins,
      {
        value: "glm-glm-5.3-cp[1m]",
        displayName: "glm-glm-5.3-cp (1M)",
        description: "custom gateway",
      },
      {
        value: "gpt-5.6-sol[1m]",
        displayName: "gpt-5.6-sol (1M)",
        description: "custom gateway",
      },
    ]);

    const normalized = normalizeClaudeModelCatalog(snapshot(merged));
    expect(normalized.catalog.models.map(({ label }) => label)).toEqual([
      "Default",
      "glm-glm-5.3-cp (1M)",
      "gpt-5.6-sol (1M)",
      "Haiku",
      "Opus",
      "Sonnet",
    ]);
    expect(normalized.catalog.models.map(({ ref }) => ref.id)).toEqual([
      "default",
      "glm-glm-5.3-cp[1m]",
      "gpt-5.6-sol[1m]",
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  it("replaces builtins when replaceBuiltInOptions is true while keeping Default", () => {
    const merged = mergeClaudeModelPickerOptions(builtins, {
      replaceBuiltInOptions: true,
      options: [
        {
          model: "glm-glm-5.3-flash-cp[1m]",
          label: "glm flash",
          description: "flash gateway",
        },
        {
          model: "deepseek-v4-pro-saas[1m]",
          label: "deepseek pro",
          description: "deepseek gateway",
          behavesAs: "sonnet",
        },
      ],
    });

    expect(merged).toEqual([
      { value: "default", displayName: "Default", supportsAutoMode: true },
      {
        value: "glm-glm-5.3-flash-cp[1m]",
        displayName: "glm flash",
        description: "flash gateway",
      },
      {
        value: "deepseek-v4-pro-saas[1m]",
        displayName: "deepseek pro",
        description: "deepseek gateway",
        resolvedModel: "sonnet",
      },
    ]);

    const normalized = normalizeClaudeModelCatalog(snapshot(merged));
    expect(normalized.catalog.models.map(({ label }) => label)).toEqual([
      "Default",
      "deepseek pro",
      "glm flash",
    ]);
    expect(
      normalized.catalog.models.find(({ label }) => label === "deepseek pro")?.resolvedModelLabel,
    ).toBe("sonnet");
    expect(normalized.catalog.defaultModel).toEqual(CLAUDE_DEFAULT_MODEL_REF);
  });

  it("preserves custom label, description, and behavesAs for multi-gateway rows", () => {
    const merged = mergeClaudeModelPickerOptions([{ value: "default", displayName: "Default" }], {
      replaceBuiltInOptions: false,
      options: [
        {
          model: "minimax-m2[1m]",
          label: "MiniMax M2",
          description: "minimax gateway",
          behavesAs: "haiku",
        },
        {
          model: "provider-x/custom-opus",
          label: "Provider X Opus",
          description: "second gateway",
          behavesAs: "opus",
        },
      ],
    });

    expect(merged).toEqual([
      { value: "default", displayName: "Default" },
      {
        value: "minimax-m2[1m]",
        displayName: "MiniMax M2",
        description: "minimax gateway",
        resolvedModel: "haiku",
      },
      {
        value: "provider-x/custom-opus",
        displayName: "Provider X Opus",
        description: "second gateway",
        resolvedModel: "opus",
      },
    ]);

    const normalized = normalizeClaudeModelCatalog(snapshot(merged));
    expect(
      normalized.catalog.models.map((model) => ({
        value: claudeModelValue(model.ref),
        label: model.label,
        resolvedModelLabel: model.resolvedModelLabel,
      })),
    ).toEqual([
      { value: undefined, label: "Default", resolvedModelLabel: undefined },
      { value: "minimax-m2[1m]", label: "MiniMax M2", resolvedModelLabel: "haiku" },
      {
        value: "provider-x/custom-opus",
        label: "Provider X Opus",
        resolvedModelLabel: "opus",
      },
    ]);
  });

  it("returns undefined when a non-empty options array has no valid entries", () => {
    expect(
      parseClaudeModelPickerSettings({
        replaceBuiltInOptions: true,
        options: [{ label: "missing model" }, { model: "\n" }, null, "nope"],
      }),
    ).toBeUndefined();
    expect(parseClaudeModelPickerSettings({ options: [] })).toEqual({
      options: [],
      replaceBuiltInOptions: false,
    });
    expect(parseClaudeModelPickerSettings({ replaceBuiltInOptions: true })).toEqual({
      options: [],
      replaceBuiltInOptions: true,
    });
    expect(parseClaudeModelPickerSettings({})).toBeUndefined();
  });

  it("reads user settings through CLAUDE_CONFIG_DIR and ignores malformed files", async () => {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-settings-"));
    try {
      expect(
        await readClaudeUserModelPicker({ CLAUDE_CONFIG_DIR: configDirectory }),
      ).toBeUndefined();

      await writeFile(path.join(configDirectory, "settings.json"), "{not-json");
      expect(
        await readClaudeUserModelPicker({ CLAUDE_CONFIG_DIR: configDirectory }),
      ).toBeUndefined();

      await writeFile(
        path.join(configDirectory, "settings.json"),
        JSON.stringify({
          modelPicker: {
            replaceBuiltInOptions: true,
            options: [
              { model: "gateway/model-a", label: "A", description: "desc-a" },
              { model: "\n", label: "ignored invalid ID" },
              { label: "missing model" },
              { model: "gateway/model-a", label: "duplicate ignored" },
              { model: "gateway/model-b", behavesAs: "sonnet" },
            ],
          },
        }),
      );
      await expect(
        readClaudeUserModelPicker({ CLAUDE_CONFIG_DIR: configDirectory }),
      ).resolves.toEqual({
        replaceBuiltInOptions: true,
        options: [
          { model: "gateway/model-a", label: "A", description: "desc-a" },
          { model: "gateway/model-b", behavesAs: "sonnet" },
        ],
      });
      expect(resolveClaudeConfigDirectory({ CLAUDE_CONFIG_DIR: configDirectory })).toBe(
        path.resolve(configDirectory),
      );
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });
});
