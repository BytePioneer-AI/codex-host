import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  nativeModelIdForRef,
  parseQwenCodeModelState,
  sanitizeQwenCodeModelRefId,
} from "../src/index.js";

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
  it("sanitizes native Model IDs into transport-safe Ref IDs", () => {
    expect(sanitizeQwenCodeModelRefId("GLM-5.3-flash(openai)", new Set())).toBe(
      "GLM-5.3-flash-openai",
    );
    expect(sanitizeQwenCodeModelRefId("qwen-route:v1:abc", new Set())).toBe("qwen-route-v1-abc");
    expect(sanitizeQwenCodeModelRefId(")))", new Set())).toBe("qwen-model");
  });

  it("deduplicates Ref IDs after sanitization", () => {
    const taken = new Set(["glm-5"]);
    expect(sanitizeQwenCodeModelRefId("glm-5", taken)).toBe("glm-5-2");
  });

  it("parses the native session Model catalog with context windows", () => {
    const state = parseQwenCodeModelState(sessionModels);
    expect(state).not.toBeNull();
    const refs = state?.catalog.models.map(({ ref }) => ref.id);
    expect(refs).toEqual([
      "GLM-5.3-openai",
      "GLM-5.3-flash-openai",
      "deepseek-v3.2-openai",
      "qwen-route-v1-abc",
    ]);
    expect(state?.currentModel).toEqual({ id: "GLM-5.3-flash-openai" });
    expect(state?.catalog.defaultModel).toEqual({ id: "GLM-5.3-flash-openai" });
    expect(state?.catalog.thinkingOptions).toEqual([]);
    expect(state?.contextWindowTokensByModel.get("GLM-5.3-openai")).toBe(1_000_000);
    expect(state?.contextWindowTokensByModel.get("qwen-route-v1-abc")).toBeUndefined();
  });

  it("maps sanitized Refs back to native Model IDs", () => {
    const state = parseQwenCodeModelState(sessionModels);
    if (!state) throw new Error("expected a parsed Model catalog");
    const refFor = (id: string) => harnessModelRefSchema.parse({ id });
    expect(nativeModelIdForRef(state, refFor("GLM-5.3-flash-openai"))).toBe(
      "GLM-5.3-flash(openai)",
    );
    expect(nativeModelIdForRef(state, refFor("qwen-route-v1-abc"))).toBe("qwen-route:v1:abc");
    expect(nativeModelIdForRef(state, refFor("missing"))).toBeUndefined();
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
});
