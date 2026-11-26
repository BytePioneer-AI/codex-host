import { describe, expect, it } from "vitest";

import {
  harnessModelCatalogSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";

import {
  normalizeOmoModelCatalog,
  OmoModelCatalogProtocolError,
  OMO_THINKING_LEVELS,
  OMO_THINKING_OPTION_IDS,
  OMO_THINKING_OPTIONS,
} from "../src/omo-model-catalog.js";

/**
 * Synthetic `get_available_models` payload shaped like a live omo 5.1.83 response:
 * full native Model rows, including the fields the catalog does not publish.
 */
const availableModels = {
  models: [
    {
      id: "senpi-large",
      name: "Senpi Large",
      api: "openai-responses",
      provider: "omo-lab",
      baseUrl: "https://models.example.invalid/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 32_768,
      cost: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 },
      compat: {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: false,
        supportsDisabledThinking: true,
        forceAdaptiveThinking: false,
        supportsStrictTools: true,
        allowedFallbackModels: [],
      },
    },
    {
      id: "senpi-mini",
      name: "Senpi Mini",
      api: "anthropic-messages",
      provider: "omo-lab",
      baseUrl: "https://models.example.invalid/anthropic",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3 },
      compat: {
        supportsMidConvoSystemMessages: false,
        supportsMidConvoToolChanges: false,
        supportsDisabledThinking: true,
        forceAdaptiveThinking: false,
        supportsStrictTools: false,
        allowedFallbackModels: [],
      },
    },
    {
      id: "senpi-router",
      name: "Senpi Router",
      api: "openai-responses",
      provider: "omo-lab",
      baseUrl: "https://models.example.invalid/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 65_536,
      cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3 },
      compat: {
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
        supportsDisabledThinking: true,
        forceAdaptiveThinking: false,
        supportsStrictTools: true,
        allowedFallbackModels: ["omo-lab/senpi-large", "omo-lab/senpi-mini"],
      },
    },
  ],
};

describe("OmO Model Catalog normalization", () => {
  it("maps a live-shaped get_available_models payload to catalog rows", () => {
    const result = normalizeOmoModelCatalog(availableModels);

    expect(result.rejected).toEqual([]);
    expect(harnessModelCatalogSchema.parse(result.catalog)).toEqual(result.catalog);
    expect(result.catalog.models.map(({ ref }) => ref.id)).toEqual([
      "omo-lab/senpi-large",
      "omo-lab/senpi-mini",
      "omo-lab/senpi-router",
    ]);
    expect(result.catalog.models.map(({ label }) => label)).toEqual([
      "Senpi Large",
      "Senpi Mini",
      "Senpi Router",
    ]);
    expect(
      result.catalog.models.map(({ supportedThinkingOptionIds }) => supportedThinkingOptionIds),
    ).toEqual([
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      ["off"],
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    ]);
  });

  it("passes the native context window and output limit through numerically", () => {
    const result = normalizeOmoModelCatalog(availableModels);

    expect(
      result.models.map(({ id, contextWindow, maxTokens }) => ({ id, contextWindow, maxTokens })),
    ).toEqual([
      { id: "senpi-large", contextWindow: 200_000, maxTokens: 32_768 },
      { id: "senpi-mini", contextWindow: 128_000, maxTokens: 8_192 },
      { id: "senpi-router", contextWindow: 400_000, maxTokens: 65_536 },
    ]);
  });

  it("maps every native Thinking level to exactly one Harness option ID", () => {
    expect(Object.keys(OMO_THINKING_OPTION_IDS).sort()).toEqual([...OMO_THINKING_LEVELS].sort());
    for (const level of OMO_THINKING_LEVELS) {
      expect(OMO_THINKING_OPTION_IDS[level]).toBe(level);
      expect(harnessThinkingOptionIdSchema.parse(OMO_THINKING_OPTION_IDS[level])).toBe(level);
    }
    expect(OMO_THINKING_OPTIONS.map(({ id }) => id)).toEqual([...OMO_THINKING_LEVELS]);
    expect(OMO_THINKING_OPTIONS.map(({ label }) => label)).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra High",
      "Max",
    ]);

    const [first] = availableModels.models;
    const catalog = normalizeOmoModelCatalog({ models: [first] }).catalog;
    expect(catalog.thinkingOptions.map(({ id }) => id).sort()).toEqual(
      [...OMO_THINKING_LEVELS].sort(),
    );
  });

  it("rejects malformed rows as typed protocol errors and keeps the valid ones", () => {
    const result = normalizeOmoModelCatalog({
      models: [
        { id: "only-id", name: "Only Id", reasoning: true },
        { provider: "omo-lab", name: "Only Provider", reasoning: true },
        { provider: "   ", id: "blank-provider", reasoning: true },
        {
          provider: "omo-lab",
          id: "healthy",
          reasoning: false,
          contextWindow: 64_000,
          maxTokens: 4_096,
        },
        "not-an-object",
        { provider: "omo-lab", id: "no-reasoning" },
        {
          provider: "omo-lab",
          id: "zero-limits",
          reasoning: false,
          contextWindow: 0,
          maxTokens: -1,
        },
      ],
    });

    expect(result.catalog.models.map(({ ref }) => ref.id)).toEqual([
      "omo-lab/healthy",
      "omo-lab/zero-limits",
    ]);
    expect(result.rejected.map(({ index }) => index)).toEqual([0, 1, 2, 4, 5]);
    for (const { error } of result.rejected) {
      expect(error.code).toBe("protocolError");
      expect(error.retryable).toBe(false);
    }
    expect(result.rejected.map(({ error }) => error.message)).toEqual([
      "OmO Model catalog row 0 has no provider",
      "OmO Model catalog row 1 has no Model id",
      "OmO Model catalog row 2 has no provider",
      "OmO Model catalog row 4 is not an object",
      "OmO Model catalog row 5 has no reasoning capability",
    ]);
    const zeroLimits = result.models.find(({ id }) => id === "zero-limits");
    expect(zeroLimits).not.toHaveProperty("contextWindow");
    expect(zeroLimits).not.toHaveProperty("maxTokens");
  });

  it("collapses identical duplicate rows and rejects duplicates with different capabilities", () => {
    const row = { provider: "omo-lab", id: "deduped", name: "Deduped", reasoning: true };
    const result = normalizeOmoModelCatalog({
      models: [row, row, { ...row, reasoning: false }],
    });

    expect(result.catalog.models.map(({ ref }) => ref.id)).toEqual(["omo-lab/deduped"]);
    expect(result.models.map(({ id }) => id)).toEqual(["deduped"]);
    expect(result.rejected.map(({ index, error }) => ({ index, message: error.message }))).toEqual([
      {
        index: 2,
        message: "OmO Model catalog row 2 repeats omo-lab/deduped with different capabilities",
      },
    ]);
  });

  it("rejects a response without a models array as a protocol error", () => {
    for (const payload of [null, {}, { models: "none" }]) {
      try {
        normalizeOmoModelCatalog(payload);
        throw new Error("Expected the payload to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(OmoModelCatalogProtocolError);
        expect((error as OmoModelCatalogProtocolError).code).toBe("protocolError");
      }
    }
  });
});
