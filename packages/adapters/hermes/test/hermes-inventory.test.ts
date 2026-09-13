import { describe, expect, it } from "vitest";

import {
  catalogModelsFromInventory,
  inventoryPythonCandidates,
  readHermesModelInventory,
} from "../src/hermes-inventory.js";
import { encodeHermesModelRef, projectHermesModelState } from "../src/hermes-models.js";

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

describe("Hermes inventory process", () => {
  it("resolves the interpreter next to the official Windows launcher", () => {
    expect(
      inventoryPythonCandidates(
        "C:\\Users\\test\\.hermes\\hermes-agent\\venv\\Scripts\\hermes.exe",
        "win32",
      )[0],
    ).toBe("C:\\Users\\test\\.hermes\\hermes-agent\\venv\\Scripts\\python.exe");
  });
});

describe("Hermes Session Model projection", () => {
  it.each([undefined, "unknown:model"])(
    "does not invent an effective Model for currentModelId=%s",
    (currentModelId) => {
      expect(
        projectHermesModelState({
          availableModels: [{ modelId: "zai:glm-5-turbo", name: "GLM 5 Turbo" }],
          ...(currentModelId ? { currentModelId } : {}),
        }),
      ).toEqual({ effectiveModel: null, resolvedModelLabel: null });
    },
  );

  it("aligns the native provider separator with the inventory catalog label", () => {
    expect(
      projectHermesModelState({
        availableModels: [{ modelId: "zai:glm-5.3", name: "Z.AI · GLM · glm-5.3" }],
        currentModelId: "zai:glm-5.3",
      }),
    ).toEqual({
      effectiveModel: encodeHermesModelRef("zai:glm-5.3"),
      resolvedModelLabel: "Z.AI / GLM / glm-5.3",
    });
  });
});
