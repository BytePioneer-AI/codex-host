import { describe, expect, it } from "vitest";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
} from "@codexhost/shared-contracts";
import { resolveDelegationConfiguration } from "../src/delegation-configuration.js";

const ref1 = harnessModelRefSchema.parse({ id: "prefix.encoded1" });
const ref2 = harnessModelRefSchema.parse({ id: "prefix.encoded2" });
const plainRef = harnessModelRefSchema.parse({ id: "gemini-3.8-flash" });

const thinkingHigh = harnessThinkingOptionIdSchema.parse("ocv.aGlnaA");
const thinkingLow = harnessThinkingOptionIdSchema.parse("low");

const testCatalog: HarnessModelCatalog = harnessModelCatalogSchema.parse({
  models: [
    {
      ref: ref1,
      nativeId: "provider1/model1",
      label: "Provider 1 / Model 1",
      supportedThinkingOptionIds: [thinkingHigh, thinkingLow],
    },
    {
      ref: ref2,
      nativeId: "provider2/model2",
      label: "Provider 2 / Model 2",
    },
    {
      ref: plainRef,
      label: "Gemini 3.8 Flash",
      supportedThinkingOptionIds: [thinkingLow],
    },
  ],
  defaultModel: ref1,
  thinkingOptions: [
    { id: thinkingHigh, nativeId: "high", label: "High" },
    { id: thinkingLow, label: "Low" },
  ],
  defaultThinkingOptionId: thinkingHigh,
});

describe("resolveDelegationConfiguration", () => {
  it("resolves model by catalog ref.id", () => {
    const result = resolveDelegationConfiguration(testCatalog, { model: ref1.id });
    expect(result.model).toEqual(ref1);
  });

  it("resolves model by nativeId", () => {
    const result = resolveDelegationConfiguration(testCatalog, { model: "provider1/model1" });
    expect(result.model).toEqual(ref1);
  });

  it("resolves model by plain id when no nativeId is set", () => {
    const result = resolveDelegationConfiguration(testCatalog, { model: "gemini-3.8-flash" });
    expect(result.model).toEqual(plainRef);
  });

  it("resolves model by fastModel id", () => {
    const catalogWithFast: HarnessModelCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: ref1,
          fastModel: { id: "prefix.fast1" },
          nativeId: "provider1/model1",
          label: "Provider 1 / Model 1",
          supportedThinkingOptionIds: [thinkingHigh],
        },
      ],
      thinkingOptions: [{ id: thinkingHigh, nativeId: "high", label: "High" }],
    });
    const result = resolveDelegationConfiguration(catalogWithFast, {
      model: "prefix.fast1",
      thinking: "high",
    });
    expect(result.model).toEqual({ id: "prefix.fast1" });
    expect(result.thinkingOptionId).toBe(thinkingHigh);
  });

  it("throws INVALID_ARGUMENT listing valid selectors on unknown model", () => {
    expect(() =>
      resolveDelegationConfiguration(testCatalog, { model: "unknown-model" }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: "Model is unavailable for the target Harness",
        details: {
          validModelIds: ["provider1/model1", "provider2/model2", "gemini-3.8-flash"],
        },
      }),
    );
  });

  it("resolves thinking by option id for selected model", () => {
    const result = resolveDelegationConfiguration(testCatalog, {
      model: "provider1/model1",
      thinking: thinkingHigh,
    });
    expect(result.model).toEqual(ref1);
    expect(result.thinkingOptionId).toBe(thinkingHigh);
  });

  it("resolves thinking by nativeId for selected model", () => {
    const result = resolveDelegationConfiguration(testCatalog, {
      model: "provider1/model1",
      thinking: "high",
    });
    expect(result.model).toEqual(ref1);
    expect(result.thinkingOptionId).toBe(thinkingHigh);
  });

  it("resolves thinking for default model when no model selector is passed", () => {
    const result = resolveDelegationConfiguration(testCatalog, {
      thinking: "high",
    });
    expect(result.model).toBeUndefined();
    expect(result.thinkingOptionId).toBe(thinkingHigh);
  });

  it("throws INVALID_ARGUMENT when thinking option is unavailable for the selected model", () => {
    expect(() =>
      resolveDelegationConfiguration(testCatalog, {
        model: "provider2/model2",
        thinking: "high",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: "Thinking option is unavailable for the selected Model",
        details: { validThinkingOptionIds: [] },
      }),
    );
  });

  it("throws INVALID_ARGUMENT listing valid thinking selectors when option is unknown", () => {
    expect(() =>
      resolveDelegationConfiguration(testCatalog, {
        model: "provider1/model1",
        thinking: "max",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: "Thinking option is unavailable for the selected Model",
        details: { validThinkingOptionIds: ["high", "low"] },
      }),
    );
  });

  it("returns empty object when neither model nor thinking is provided", () => {
    expect(resolveDelegationConfiguration(testCatalog, {})).toEqual({});
    expect(
      resolveDelegationConfiguration(testCatalog, { model: undefined, thinking: undefined }),
    ).toEqual({});
  });
});
