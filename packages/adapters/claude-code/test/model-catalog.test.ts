import { describe, expect, it } from "vitest";

import {
  CLAUDE_DEFAULT_MODEL_REF,
  decodeClaudeModelRef,
  encodeClaudeModelRef,
  normalizeClaudeModelCatalog,
} from "../src/model-catalog.js";

function snapshot(models: unknown, currentModel = "runtime-custom") {
  return { models, currentModel, canSelectModel: true };
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
      { id: "adaptive-v2", label: "adaptive-v2" },
      { id: "high", label: "high" },
      { id: "low", label: "low" },
    ]);
    expect(
      normalized.catalog.models.find(({ label }) => label.startsWith("Family (sonnet"))
        ?.supportedThinkingOptionIds,
    ).toEqual(["low", "adaptive-v2", "high"]);
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
        },
      ]),
    );

    expect(normalized.catalog.models.map(({ ref }) => decodeClaudeModelRef(ref))).toEqual([
      undefined,
      "custom-model",
    ]);
    expect(normalized.catalog.models[0]).toMatchObject({
      label: "Default",
      resolvedModelLabel: "runtime-custom",
    });
    expect(normalized.catalog.models[1]).not.toHaveProperty("resolvedModelLabel");
  });

  it("rejects unavailable, empty, malformed, conflicting, and unbounded observations", () => {
    for (const value of [
      { models: [], currentModel: "runtime", canSelectModel: true },
      { models: "not-an-array", currentModel: "runtime", canSelectModel: true },
      snapshot([{ value: "", displayName: "Bad" }]),
      snapshot([{ value: "valid", displayName: "" }]),
      snapshot([
        { value: "same", displayName: "First" },
        { value: "same", displayName: "Second" },
      ]),
      snapshot([{ value: "valid", displayName: "Valid" }], " "),
      snapshot([{ value: "valid", displayName: "Valid" }], "x".repeat(257)),
      snapshot([{ value: "valid", displayName: "Valid", supportedEffortLevels: ["low", {}] }]),
    ]) {
      expect(() => normalizeClaudeModelCatalog(value)).toThrow();
    }
    expect(() =>
      normalizeClaudeModelCatalog({ models: [], currentModel: undefined, canSelectModel: false }),
    ).toThrow("unavailable");
  });
});
