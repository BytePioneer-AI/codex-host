import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  catalogModelsFromInventory,
  inventoryPythonCandidates,
  venvPythonFromShim,
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

  it("matches the configured custom provider alias without selecting another provider's model", () => {
    const catalog = catalogModelsFromInventory({
      models: [
        { modelId: "other:gpt-5.6-sol", label: "gpt-5.6-sol", provider: "Other" },
        {
          modelId: "custom:pi-openai:gpt-5.6-sol",
          modelIdAliases: ["custom:pi-openai:gpt-5.6-sol", "pi openai:gpt-5.6-sol"],
          label: "gpt-5.6-sol",
          provider: "Pi OpenAI",
        },
      ],
      currentModelId: "custom:pi-openai:gpt-5.6-sol",
    });
    expect(catalog.defaultModel).toEqual(encodeHermesModelRef("custom:pi-openai:gpt-5.6-sol"));
    expect(catalog.models.map(({ ref }) => ref)).toContainEqual(catalog.defaultModel);
    expect(catalog.models.map(({ ref }) => ref)).toContainEqual(
      encodeHermesModelRef("custom:pi-openai:gpt-5.6-sol"),
    );
  });

  it("never substitutes a historical alias for the native route", () => {
    const catalog = catalogModelsFromInventory({
      models: [
        {
          modelId: "custom:sol-gateway:Model:Beta",
          modelIdAliases: ["custom:custom:sol-gateway:Model:Beta"],
          label: "Model:Beta",
          provider: "Sol Gateway",
        },
      ],
      currentModelId: "custom:custom:sol-gateway:Model:Beta",
    });
    expect(catalog.defaultModel).toEqual(encodeHermesModelRef("custom:sol-gateway:Model:Beta"));
  });

  it("rejects ambiguous defaults instead of choosing the last provider", () => {
    expect(() =>
      catalogModelsFromInventory({
        models: ["first", "second"].map((provider) => ({
          modelId: `${provider}:Model`,
          modelIdAliases: ["legacy:Model"],
          label: "Model",
          provider,
        })),
        currentModelId: "legacy:Model",
      }),
    ).toThrow("multiple Provider routes");
  });

  it("reports a missing configured model without selecting the first model", () => {
    expect(() =>
      catalogModelsFromInventory({
        models: [{ modelId: "zai:Model", label: "Model", provider: "Z.AI" }],
        currentModelId: "other:Model",
      }),
    ).toThrow("absent from its available catalog");
  });

  it("deduplicates native routes without merging providers with the same model", () => {
    const model = { modelId: "first:Model", label: "Model", provider: "First" };
    const catalog = catalogModelsFromInventory({
      models: [model, model, { ...model, modelId: "second:Model", provider: "Second" }],
      currentModelId: "first:Model",
    });
    expect(catalog.models).toHaveLength(2);
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

  it("resolves the standalone Windows installation layout", () => {
    expect(inventoryPythonCandidates("C:\\hermes\\bin\\hermes.exe", "win32")).toContain(
      "C:\\hermes\\hermes-agent\\venv\\Scripts\\python.exe",
    );
  });

  it("follows the bound virtualenv from a Windows command shim", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-windows-shim-"));
    const shim = path.join(directory, "hermes.cmd");
    try {
      await writeFile(
        shim,
        '@echo off\r\n"D:\\Apps\\Hermes\\hermes-agent\\venv\\Scripts\\hermes.exe" %*\r\n',
      );
      await expect(venvPythonFromShim(shim, "win32")).resolves.toBe(
        "D:\\Apps\\Hermes\\hermes-agent\\venv\\Scripts\\python.exe",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
