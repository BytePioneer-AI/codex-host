import { HARNESS_MODEL_REF_MAX_LENGTH, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { normalizeStoredGrokModelRef, parseGrokModelState } from "../src/grok-models.js";

const native500K = "magpie/grok-2/grok-4.7";
const alias272K = "magpie-grok47";
const nativeIds = [native500K, alias272K, "grok-4.6", "grok-4.5"];
const availableModels = [
  {
    modelId: native500K,
    name: "Magpie Grok 4.7 (500K)",
    _meta: {
      totalContextTokens: 500000,
      contextWindows: [256000, 500000],
      reasoningEffort: "high",
      reasoningEfforts: [{ id: "high", label: "High" }],
    },
  },
  {
    modelId: alias272K,
    name: "Magpie Grok 4.7 (272K)",
    _meta: { totalContextTokens: 272000, contextWindows: [256000] },
  },
  {
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: { totalContextTokens: 256000 },
  },
  {
    modelId: "grok-4.5",
    name: "Grok 4.5",
    _meta: { totalContextTokens: 128000 },
  },
];

describe("Grok native Model Refs", () => {
  it.each([native500K, alias272K])(
    "retains the complete four-model catalog when %s is current",
    (currentModelId) => {
      const state = parseGrokModelState({ currentModelId, availableModels });
      expect(state).not.toBeNull();
      if (!state) throw new Error("Expected a Grok Model catalog");

      expect(state.catalog.models).toHaveLength(4);
      expect(state.catalog.models.map(({ ref }) => ref.id)).toEqual(nativeIds);
      expect(state.currentModel.id).toBe(currentModelId);
      expect(state.catalog.defaultModel).toEqual(state.currentModel);
      expect(state.contextWindowTokensByModel.get(native500K)).toBe(500000);
      expect(state.contextWindowTokensByModel.get(alias272K)).toBe(272000);
      expect(state.defaultContextWindowTokensByModel.get(native500K)).toBe(500000);
      expect(state.defaultContextWindowTokensByModel.has(alias272K)).toBe(false);
      for (const { ref } of state.catalog.models) {
        expect(harnessModelRefSchema.safeParse(ref).success).toBe(true);
      }
    },
  );

  it("resolves a stored encoded Ref to the same native Model", () => {
    const state = parseGrokModelState({ currentModelId: native500K, availableModels });
    if (!state) throw new Error("Expected a Grok Model catalog");
    const saved = harnessModelRefSchema.parse({
      id: `grok-model-v1.${Buffer.from(native500K).toString("base64url")}`,
    });
    expect(normalizeStoredGrokModelRef(saved, state.catalog)).toEqual({ id: native500K });
  });

  it("applies the Ref length budget to the native ID", () => {
    const id = "/".repeat(HARNESS_MODEL_REF_MAX_LENGTH);
    const state = parseGrokModelState({
      currentModelId: id,
      availableModels: [{ modelId: id, name: "Long" }],
    });
    expect(state?.currentModel).toEqual({ id });
  });
});
