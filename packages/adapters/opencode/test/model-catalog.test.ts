import { Buffer } from "node:buffer";

import type { Model, Provider } from "@opencode-ai/sdk/v2";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodeOpenCodeModelRef,
  decodeOpenCodeVariant,
  encodeOpenCodeVariant,
  normalizeOpenCodeModelCatalog,
  normalizeStoredOpenCodeModelRef,
  openCodeContextWindow,
} from "../src/model-catalog.js";

function model(id: string, variants: string[] = []): Model {
  return {
    id,
    providerID: "provider",
    api: { id, url: "https://example.test", npm: "synthetic" },
    name: id,
    capabilities: {
      temperature: true,
      reasoning: variants.length > 0,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: Object.fromEntries(variants.map((variant) => [variant, {}])),
  };
}

function provider(id: string, connectedModels: Model[]): Provider {
  return {
    id,
    name: id.toUpperCase(),
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(
      connectedModels.map((entry) => [entry.id, { ...entry, providerID: id }]),
    ),
  };
}

function legacy(providerID: string, modelID: string) {
  return harnessModelRefSchema.parse({
    id: `opencode-model-v1.${Buffer.from(JSON.stringify([providerID, modelID])).toString("base64url")}`,
  });
}

describe("OpenCode Model catalog", () => {
  it.each([
    [{ providerID: "local/provider-一", modelID: "family/model-v1.2" }, "reasoning/high-一"],
    [{ providerID: "本地/提供方.v1", modelID: "系列/模型~高" }, "推理/高"],
  ])("round-trips exact Provider, Model, and variant identities: %j", (native, variantId) => {
    const { providerID, modelID } = native;
    const { catalog, index } = normalizeOpenCodeModelCatalog({
      all: [provider(providerID, [model(modelID)])],
      connected: [providerID],
      default: { [providerID]: modelID },
    });
    const ref = harnessModelRefSchema.parse({ id: `${providerID}/${modelID}` });
    const variant = encodeOpenCodeVariant(variantId);

    expect(catalog.defaultModel).toEqual(ref);
    expect(decodeOpenCodeModelRef(ref, index)).toEqual(native);
    const saved = legacy(providerID, modelID);
    expect(normalizeStoredOpenCodeModelRef(saved, index)).toEqual(ref);
    expect(() => decodeOpenCodeModelRef(saved, index)).toThrow("absent");
    expect(variant).toMatch(/^ocv\.[A-Za-z0-9_-]+$/u);
    expect(decodeOpenCodeVariant(variant)).toBe(variantId);
    expect(decodeOpenCodeVariant(encodeOpenCodeVariant(undefined))).toBeUndefined();
  });

  it("publishes only connected Providers with exact per-Model variants", () => {
    const first = provider("alpha", [model("reasoner", ["high", "low"])]);
    const second = provider("beta", [model("plain")]);
    const catalog = { all: [second, first], connected: ["alpha"], default: { alpha: "reasoner" } };
    const { catalog: normalized } = normalizeOpenCodeModelCatalog(catalog);

    expect(normalized.models).toHaveLength(1);
    expect(normalized.models[0]?.label).toBe("ALPHA / reasoner");
    expect(normalized.models[0]?.supportedThinkingOptionIds).toEqual([
      encodeOpenCodeVariant(undefined),
      encodeOpenCodeVariant("high"),
      encodeOpenCodeVariant("low"),
    ]);
    expect(normalized.defaultModel).toEqual({ id: "alpha/reasoner" });
    expect(openCodeContextWindow(catalog, { providerID: "alpha", modelID: "reasoner" })).toBe(
      200_000,
    );
  });

  it("uses the old encoding only for colliding catalog entries", () => {
    const { catalog, index } = normalizeOpenCodeModelCatalog({
      all: [
        provider("team", [model("proxy/model"), model("plain")]),
        provider("team/proxy", [model("model")]),
      ],
      connected: ["team", "team/proxy"],
      default: { team: "proxy/model" },
    });
    const first = legacy("team", "proxy/model");
    const second = legacy("team/proxy", "model");
    expect(catalog.models.map(({ ref }) => ref.id)).toEqual(
      expect.arrayContaining([first.id, second.id, "team/plain"]),
    );
    expect(catalog.defaultModel).toEqual(first);
    expect(decodeOpenCodeModelRef(first, index)).toEqual({
      providerID: "team",
      modelID: "proxy/model",
    });
    expect(decodeOpenCodeModelRef(second, index)).toEqual({
      providerID: "team/proxy",
      modelID: "model",
    });
    expect(() =>
      decodeOpenCodeModelRef(harnessModelRefSchema.parse({ id: "team/proxy/model" }), index),
    ).toThrow("absent");
  });

  it.each([
    "other-model-v1.value",
    "opencode-model-v1.bm90LWpzb24",
    `${legacy("provider", "model").id}=`,
  ])("rejects invalid stored Ref %s", (id) => {
    const { index } = normalizeOpenCodeModelCatalog({
      all: [provider("provider", [model("model")])],
      connected: ["provider"],
      default: {},
    });
    expect(
      normalizeStoredOpenCodeModelRef(harnessModelRefSchema.parse({ id }), index),
    ).toBeUndefined();
  });

  it("rejects foreign variants", () => {
    expect(() =>
      decodeOpenCodeVariant(harnessThinkingOptionIdSchema.parse("foreign.high")),
    ).toThrow("another Adapter");
  });
});
