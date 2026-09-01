import { Buffer } from "node:buffer";

import type { Model, Provider } from "@opencode-ai/sdk/v2";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodeOpenCodeModelRef,
  decodeOpenCodeVariant,
  encodeOpenCodeModelRef,
  encodeOpenCodeVariant,
  normalizeOpenCodeModelCatalog,
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

describe("OpenCode Model catalog", () => {
  it("round-trips exact Provider, Model, and variant identities", () => {
    const native = { providerID: "local/provider-一", modelID: "family/model-v1.2" };
    const ref = encodeOpenCodeModelRef(native);
    const variant = encodeOpenCodeVariant("reasoning/high-一");

    expect(ref.id).toMatch(/^opencode-model-v1\.[A-Za-z0-9_-]+$/u);
    expect(decodeOpenCodeModelRef(ref)).toEqual(native);
    expect(variant).toMatch(/^ocv\.[A-Za-z0-9_-]+$/u);
    expect(decodeOpenCodeVariant(variant)).toBe("reasoning/high-一");
    expect(decodeOpenCodeVariant(encodeOpenCodeVariant(undefined))).toBeUndefined();
  });

  it("publishes only connected Providers with exact per-Model variants", () => {
    const first = provider("alpha", [model("reasoner", ["high", "low"])]);
    const second = provider("beta", [model("plain")]);
    const catalog = { all: [second, first], connected: ["alpha"], default: { alpha: "reasoner" } };
    const normalized = normalizeOpenCodeModelCatalog(catalog);

    expect(normalized.models).toHaveLength(1);
    expect(normalized.models[0]?.label).toBe("ALPHA / reasoner");
    expect(normalized.models[0]?.supportedThinkingOptionIds).toEqual([
      encodeOpenCodeVariant(undefined),
      encodeOpenCodeVariant("high"),
      encodeOpenCodeVariant("low"),
    ]);
    expect(normalized.defaultModel).toEqual(
      encodeOpenCodeModelRef({ providerID: "alpha", modelID: "reasoner" }),
    );
    expect(openCodeContextWindow(catalog, { providerID: "alpha", modelID: "reasoner" })).toBe(
      200_000,
    );
  });

  it("rejects foreign, malformed, and non-canonical refs", () => {
    expect(() =>
      decodeOpenCodeModelRef(harnessModelRefSchema.parse({ id: "other-model-v1.value" })),
    ).toThrow("another Adapter");
    expect(() =>
      decodeOpenCodeModelRef(harnessModelRefSchema.parse({ id: "opencode-model-v1.bm90LWpzb24" })),
    ).toThrow("malformed");
    const nonCanonical = Buffer.from('[ "provider", "model" ]', "utf8").toString("base64url");
    expect(() =>
      decodeOpenCodeModelRef(
        harnessModelRefSchema.parse({ id: `opencode-model-v1.${nonCanonical}` }),
      ),
    ).toThrow("not canonical");
    expect(() =>
      decodeOpenCodeVariant(harnessThinkingOptionIdSchema.parse("foreign.high")),
    ).toThrow("another Adapter");
  });
});
