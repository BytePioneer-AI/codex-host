import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { parseQwenCodeModelState } from "../src/qwen-models.js";

const sessionModels = {
  currentModelId: "GLM-5.3-flash(openai)",
  availableModels: [
    { modelId: "GLM-5.3(openai)", name: "[Z.AI] GLM-5.3", _meta: { contextLimit: 1_000_000 } },
    {
      modelId: "GLM-5.3-flash(openai)",
      name: "[Z.AI] GLM-5.3-flash",
      _meta: { contextLimit: 1_000_000 },
    },
    { modelId: "deepseek-v3.2(openai)", name: "DeepSeek v3.2", _meta: { contextLimit: 131_072 } },
    { modelId: "qwen-route:v1:abc", name: "Routed Model" },
  ],
};

describe("Qwen Code Model Catalog", () => {
  it("parses the native session Model catalog with context windows", () => {
    const state = parseQwenCodeModelState(sessionModels);
    expect(state).not.toBeNull();
    const refs = state?.catalog.models.map(({ ref }) => ref.id);
    expect(refs).toEqual([
      "GLM-5.3(openai)",
      "GLM-5.3-flash(openai)",
      "deepseek-v3.2(openai)",
      "qwen-route:v1:abc",
    ]);
    expect(state?.currentModel).toEqual({ id: "GLM-5.3-flash(openai)" });
    expect(state?.catalog.defaultModel).toEqual({ id: "GLM-5.3-flash(openai)" });
    expect(state?.catalog.thinkingOptions).toEqual([]);
    expect(state?.contextWindowTokensByModel.get("GLM-5.3(openai)")).toBe(1_000_000);
    expect(state?.contextWindowTokensByModel.get("qwen-route:v1:abc")).toBeUndefined();
  });

  it("rejects malformed native catalogs", () => {
    expect(parseQwenCodeModelState({})).toBeNull();
    expect(parseQwenCodeModelState({ currentModelId: "m", availableModels: [] })).toBeNull();
    expect(parseQwenCodeModelState({ currentModelId: "m", availableModels: "nope" })).toBeNull();
  });

  it("accepts Harness Model Refs it produces", () => {
    const state = parseQwenCodeModelState(sessionModels);
    for (const model of state?.catalog.models ?? []) {
      expect(harnessModelRefSchema.safeParse(model.ref).success).toBe(true);
    }
  });

  it("keeps exactly one entry per duplicated native Model ID", () => {
    const state = parseQwenCodeModelState({
      currentModelId: "GLM-5.3-flash(openai)",
      availableModels: [
        { modelId: "GLM-5.3-flash(openai)", name: "flash" },
        { modelId: "GLM-5.3-flash(openai)", name: "flash again" },
        { modelId: "qwen-route:v1:coder", name: "routed" },
        { modelId: "qwen-route:v1:coder", name: "routed again" },
      ],
    });
    expect(state?.catalog.models.map(({ ref }) => ref.id)).toEqual([
      "GLM-5.3-flash(openai)",
      "qwen-route:v1:coder",
    ]);
  });
});
