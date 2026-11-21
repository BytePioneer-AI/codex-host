import { HARNESS_MODEL_REF_MAX_LENGTH, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { decodeGrokModelRef, encodeGrokModelRef, parseGrokModelState } from "../src/grok-models.js";

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
      expect(state.catalog.models.map(({ ref }) => decodeGrokModelRef(ref))).toEqual(nativeIds);
      expect(decodeGrokModelRef(state.currentModel)).toBe(currentModelId);
      expect(state.catalog.defaultModel).toEqual(state.currentModel);
      expect(state.contextWindowTokensByModel.get(encodeGrokModelRef(native500K).id)).toBe(500000);
      expect(state.contextWindowTokensByModel.get(encodeGrokModelRef(alias272K).id)).toBe(272000);
      expect(state.defaultContextWindowTokensByModel.get(encodeGrokModelRef(native500K).id)).toBe(
        500000,
      );
      expect(state.defaultContextWindowTokensByModel.has(encodeGrokModelRef(alias272K).id)).toBe(
        false,
      );
      for (const { ref } of state.catalog.models) {
        expect(harnessModelRefSchema.safeParse(ref).success).toBe(true);
      }
    },
  );

  it("keeps legacy plain IDs stable and encodes without slash/hyphen collisions", () => {
    const legacy = encodeGrokModelRef(alias272K);
    expect(legacy.id).toBe(alias272K);
    expect(decodeGrokModelRef(legacy)).toBe(alias272K);

    const slash = encodeGrokModelRef("a/b");
    const hyphen = encodeGrokModelRef("a-b");
    expect(slash.id).not.toBe(hyphen.id);
    expect(decodeGrokModelRef(slash)).toBe("a/b");
    expect(decodeGrokModelRef(hyphen)).toBe("a-b");

    const reserved = encodeGrokModelRef("grok-model-v1.plain-looking");
    expect(reserved.id).not.toBe("grok-model-v1.plain-looking");
    expect(decodeGrokModelRef(reserved)).toBe("grok-model-v1.plain-looking");
  });

  it("enforces the public Ref length limit after encoding", () => {
    const ref = encodeGrokModelRef(native500K);
    expect(ref.id.length).toBeLessThanOrEqual(HARNESS_MODEL_REF_MAX_LENGTH);
    expect(() => encodeGrokModelRef("/".repeat(512))).toThrow(/too long/);
    expect(() => decodeGrokModelRef(harnessModelRefSchema.parse({ id: "grok-model-v1." }))).toThrow(
      /empty/,
    );
  });
});
