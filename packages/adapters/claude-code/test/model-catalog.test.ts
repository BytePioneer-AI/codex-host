import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_DEFAULT_MODEL_REF,
  decodeClaudeModelRef,
  encodeClaudeModelRef,
  mergeClaudeModelPickerOptions,
  normalizeClaudeModelCatalog,
  readClaudeUserModelPicker,
  resolveClaudeConfigDirectory,
} from "../src/model-catalog.js";

function snapshot(models: unknown) {
  return { models, canSelectModel: true, canSelectPermissionMode: true };
}

describe("Claude Code runtime Model catalog", () => {
  it("round-trips canonical private Refs and reserves default for no override", () => {
    const alias = encodeClaudeModelRef("sonnet");
    expect(decodeClaudeModelRef(alias)).toBe("sonnet");
    expect(decodeClaudeModelRef(CLAUDE_DEFAULT_MODEL_REF)).toBeUndefined();
    expect(() => decodeClaudeModelRef({ id: "pi-model-v1.private" } as never)).toThrow(
      "another Adapter",
    );
    expect(() => decodeClaudeModelRef({ id: `${alias.id}=` } as never)).toThrow();
  });

  it("preserves default, aliases, and custom rows that resolve to one actual Model", () => {
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
          description: "ignored",
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
    ]);
    expect(normalized.catalog.defaultThinkingOptionId).toBe("auto");
    expect(
      normalized.catalog.models.find(({ label }) => label.startsWith("Family (sonnet"))
        ?.supportedThinkingOptionIds,
    ).toEqual(["off", "auto", "low", "medium", "high", "xhigh", "max"]);
    expect(JSON.stringify(normalized.catalog)).not.toMatch(/private|apiKey|price|supportsEffort/u);
  });

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

    expect(normalized.catalog.models.map(({ ref }) => decodeClaudeModelRef(ref))).toEqual([
      undefined,
      "custom-model",
    ]);
    expect(normalized.catalog.models[0]).toMatchObject({ label: "Default" });
    expect(normalized.catalog.models[0]).not.toHaveProperty("resolvedModelLabel");
    expect(normalized.catalog.models[1]).not.toHaveProperty("resolvedModelLabel");
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
    expect(normalized.catalog.models.map(({ ref }) => decodeClaudeModelRef(ref))).toEqual([
      undefined,
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
        value: decodeClaudeModelRef(model.ref),
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
    for (const model of normalized.catalog.models) {
      expect(model.ref.id.startsWith("claude-model-v1.")).toBe(true);
    }
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
              { model: "  ", label: "ignored blank" },
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
