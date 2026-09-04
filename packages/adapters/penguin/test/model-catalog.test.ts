import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodePenguinModelRef,
  encodePenguinModelRef,
  normalizePenguinModelCatalog,
} from "../src/model-catalog.js";

describe("Penguin Model catalog", () => {
  it("round-trips the Provider and Model identity without exposing credentials", () => {
    const ref = encodePenguinModelRef({ provider: "openai", modelId: "gpt-test" });

    expect(ref.id).toMatch(/^penguin-model-v1\.[A-Za-z0-9_-]+$/u);
    expect(decodePenguinModelRef(ref)).toEqual({ provider: "openai", modelId: "gpt-test" });
  });

  it("normalizes the native response into a bounded Host catalog", () => {
    const catalog = normalizePenguinModelCatalog({
      models: [
        {
          provider: "openai",
          modelId: "gpt-test",
          displayName: "GPT Test",
          contextWindow: 128_000,
          isDefault: true,
          apiKey: "must-not-leak",
        },
        { provider: "anthropic", modelId: "claude-test", name: "Claude Test" },
        { provider: "openai", modelId: "gpt-test", displayName: "duplicate" },
      ],
      defaultModel: { provider: "openai", modelId: "gpt-test" },
    });

    expect(catalog.models).toHaveLength(2);
    expect(catalog.models.map(({ label }) => label)).toEqual(["Claude Test", "GPT Test"]);
    expect(catalog.defaultModel).toEqual(
      encodePenguinModelRef({ provider: "openai", modelId: "gpt-test" }),
    );
    expect(catalog.models[1]?.supportedThinkingOptionIds).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(JSON.stringify(catalog)).not.toContain("must-not-leak");
  });

  it("rejects a ref owned by another Adapter", () => {
    expect(() =>
      decodePenguinModelRef(harnessModelRefSchema.parse({ id: "opencode-model-v1.value" })),
    ).toThrow("does not belong to PenguinAdapter");
  });
});
