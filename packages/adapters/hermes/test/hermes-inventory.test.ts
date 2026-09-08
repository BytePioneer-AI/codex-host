import { describe, expect, it } from "vitest";

import { catalogModelsFromInventory } from "../src/hermes-inventory.js";

describe("Hermes model catalog", () => {
  it("labels each model as Provider / model", () => {
    const catalog = catalogModelsFromInventory({
      models: [
        { modelId: "zai:glm-5-turbo", label: "glm-5-turbo", provider: "Z.AI" },
        {
          modelId: "minimax-oauth:MiniMax-M3",
          label: "MiniMax-M3",
          provider: "MiniMax",
        },
      ],
      currentModelId: "zai:glm-5-turbo",
    });

    expect(catalog.models.map(({ label }) => label)).toEqual([
      "Z.AI / glm-5-turbo",
      "MiniMax / MiniMax-M3",
    ]);
    expect(catalog.defaultModel).not.toBeNull();
  });

  it("does not invent a default when Hermes reports no configured model", () => {
    const catalog = catalogModelsFromInventory({
      models: [{ modelId: "zai:glm-5-turbo", label: "glm-5-turbo", provider: "Z.AI" }],
      currentModelId: null,
    });

    expect(catalog.defaultModel).toBeNull();
  });

  it("hides a virtual MoA preset whose backing providers are unavailable", () => {
    const catalog = catalogModelsFromInventory({
      models: [
        {
          modelId: "moa:default",
          label: "default",
          provider: "Mixture of Agents",
          available: false,
        },
        { modelId: "zai:glm-5-turbo", label: "glm-5-turbo", provider: "Z.AI" },
      ],
      currentModelId: "zai:glm-5-turbo",
    });

    expect(catalog.models.map(({ label }) => label)).toEqual(["Z.AI / glm-5-turbo"]);
  });
});
