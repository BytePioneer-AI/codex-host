import { describe, expect, it } from "vitest";
import {
  parseAntigravityAcpModelCatalog,
  parseAntigravityModels,
  readAcpEffectiveModelState,
} from "../src/model-catalog.js";
import type { AntigravityAcpConfigOption } from "../src/acp-types.js";

const models = [
  { modelId: "gemini-4-carbon", name: "Gemini 4" },
  { modelId: "claude-opus", name: "Claude Opus" },
];
const options: AntigravityAcpConfigOption[] = [
  {
    id: "model",
    name: "Model",
    currentValue: "gemini-4-carbon",
    options: models.map(({ modelId, name }) => ({ value: modelId, name })),
  },
  {
    id: "thought_level",
    name: "Thinking",
    currentValue: "xhigh",
    options: ["low", "medium", "high", "xhigh"].map((value) => ({
      value,
      name: value.toUpperCase(),
    })),
  },
];

describe("Antigravity model catalog", () => {
  it("preserves xhigh in CLI model suffixes, sorts reasoning options, and keeps single-variant models unsplit", () => {
    const catalog = parseAntigravityModels(
      "gemini-4-xhigh\tGemini 4 (XHigh)\ngemini-4-low\tGemini 4 (Low)\ngemini-4-high\tGemini 4 (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\nplain\tPlain\n",
    );
    expect(catalog.models[0]).toMatchObject({
      ref: { id: "gemini-4" },
      label: "Gemini 4",
      supportedThinkingOptionIds: ["low", "high", "xhigh"],
    });
    expect(catalog.models[1]).toEqual({
      ref: { id: "gpt-oss-120b-medium" },
      label: "GPT-OSS 120B (Medium)",
      resolvedModelLabel: "GPT-OSS 120B (Medium)",
    });
    expect(catalog.defaultThinkingOptionId).toBe("xhigh");
  });
  it("reads native ACP model IDs without removing effort-like suffixes", () => {
    const catalog = parseAntigravityAcpModelCatalog([
      { modelId: "native-high", name: "Native High" },
    ]);
    expect(catalog.models[0]).toMatchObject({
      ref: { id: "native-high" },
      label: "Native High",
    });
    expect(catalog.models[0]).not.toHaveProperty("supportedThinkingOptionIds");
    expect(catalog.thinkingOptions).toEqual([]);
  });
  it("uses model and thought_level config directories as authoritative", () => {
    const catalog = parseAntigravityAcpModelCatalog([{ modelId: "stale", name: "Stale" }], options);
    expect(catalog.models.map(({ ref }) => ref.id)).toEqual(models.map(({ modelId }) => modelId));
    expect(catalog.defaultModel).toEqual({ id: "gemini-4-carbon" });
    expect(catalog.defaultThinkingOptionId).toBe("xhigh");
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(catalog.models[1]).not.toHaveProperty("supportedThinkingOptionIds");
    expect(readAcpEffectiveModelState(options, catalog)).toEqual({
      effectiveModel: { id: "gemini-4-carbon" },
      resolvedModelLabel: "Gemini 4",
      effectiveThinkingOptionId: "xhigh",
      availableThinkingOptions: ["low", "medium", "high", "xhigh"].map((id) => ({
        id,
        label: id.toUpperCase(),
      })),
    });
  });
  it("clips thinking options to the current model's dynamic config", () => {
    const catalog = parseAntigravityAcpModelCatalog(models, options);
    const clipped = options.map((option) =>
      option.id === "thought_level"
        ? {
            ...option,
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          }
        : option,
    );
    expect(readAcpEffectiveModelState(clipped, catalog)).toMatchObject({
      effectiveThinkingOptionId: "low",
      availableThinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });
    const disabled = clipped.map((option) =>
      option.id === "thought_level" ? { ...option, currentValue: "xhigh", options: [] } : option,
    );
    expect(readAcpEffectiveModelState(disabled, catalog).availableThinkingOptions).toEqual([]);
    expect(readAcpEffectiveModelState(disabled, catalog).effectiveThinkingOptionId).toBeUndefined();
  });
  it("falls back to catalog labels but clears thinking when config omits thought_level", () => {
    const catalog = parseAntigravityAcpModelCatalog(models, options);
    expect(
      readAcpEffectiveModelState(
        options.slice(0, 1).map((option) => ({ ...option, options: [] })),
        catalog,
      ),
    ).toMatchObject({
      effectiveModel: { id: "gemini-4-carbon" },
      resolvedModelLabel: "Gemini 4",
      availableThinkingOptions: [],
    });
    expect(readAcpEffectiveModelState([], catalog)).toEqual({ availableThinkingOptions: [] });
    expect(readAcpEffectiveModelState(undefined, catalog)).toEqual({});
  });
  it("assigns thinking only to the selected model, even when it is not first", () => {
    const switched = options.map((option) =>
      option.id === "model" ? { ...option, currentValue: "claude-opus" } : option,
    );
    const catalog = parseAntigravityAcpModelCatalog(models, switched);
    expect(catalog.defaultModel).toEqual({ id: "claude-opus" });
    expect(catalog.models[0]).not.toHaveProperty("supportedThinkingOptionIds");
    expect(catalog.models[1]?.supportedThinkingOptionIds).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
  it("clears thinking after switching to a model without thought_level", () => {
    const catalog = parseAntigravityAcpModelCatalog(models, options);
    const switched: AntigravityAcpConfigOption[] = [
      {
        id: "model",
        name: "Model",
        currentValue: "claude-sonnet-4-6",
        options: [{ value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
      },
    ];
    expect(readAcpEffectiveModelState(switched, catalog)).toEqual({
      effectiveModel: { id: "claude-sonnet-4-6" },
      resolvedModelLabel: "Claude Sonnet 4.6",
      availableThinkingOptions: [],
    });
    const updatedCatalog = parseAntigravityAcpModelCatalog(models, switched);
    expect(updatedCatalog.models[0]).not.toHaveProperty("supportedThinkingOptionIds");
    expect(updatedCatalog.thinkingOptions).toEqual([]);
    expect(updatedCatalog.defaultThinkingOptionId).toBeUndefined();
  });
  it("rejects empty model catalogs", () =>
    expect(() => parseAntigravityAcpModelCatalog([])).toThrow("no usable Models"));
});
