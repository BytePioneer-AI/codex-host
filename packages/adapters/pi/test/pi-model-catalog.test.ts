import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  createPiModelIndex,
  encodePiModelRef,
  normalizeStoredPiModelRef,
  resolvePiModelRef,
  normalizePiModelCatalog,
  normalizePiThinkingOptions,
} from "../src/pi-model-catalog.js";

describe("Pi Model Catalog normalization", () => {
  it.each([false, true])("round-trips exact pairs and Fast (collision: %s)", (collision) => {
    const native = { provider: "本地/提供方", id: "系列/GPT 模型:高~fast" };
    const other = { provider: "本地", id: "提供方/系列/GPT 模型:高~fast" };
    const models = [
      { ...native, reasoning: true, api: "openai-responses" },
      ...(collision ? [{ ...other, reasoning: false }] : []),
    ];
    const catalog = normalizePiModelCatalog(models, native, null, null, null, true);
    const base = catalog.defaultModel;
    const fast = catalog.models.find(({ fastModel }) => fastModel)?.fastModel;
    assert(base && fast, "Expected base and Fast Model Refs");
    const legacy = (tuple: unknown[]) =>
      harnessModelRefSchema.parse({
        id: `pi-model-v1.${Buffer.from(JSON.stringify(tuple)).toString("base64url")}`,
      });
    const old = legacy([native.provider, native.id]);
    const readable = harnessModelRefSchema.parse({ id: "本地/提供方/系列/GPT 模型:高~fast" });
    expect(base).toEqual(collision ? old : readable);
    expect(fast).toEqual({ id: base.id, serviceTier: "priority" });
    expect(normalizeStoredPiModelRef(old, catalog)).toEqual(base);
    expect(normalizeStoredPiModelRef(legacy([native.provider, native.id, true]), catalog)).toEqual(
      fast,
    );
    expect(
      normalizeStoredPiModelRef(legacy([native.provider, native.id, false]), catalog),
    ).toBeUndefined();
    expect(resolvePiModelRef(fast, createPiModelIndex(models))).toEqual({ ...native, fast: true });
    const otherRef = legacy([other.provider, other.id]);
    if (collision) {
      expect(resolvePiModelRef(otherRef, createPiModelIndex(models))).toEqual(other);
      expect(() => resolvePiModelRef(readable, createPiModelIndex(models))).toThrow();
    } else {
      expect(normalizeStoredPiModelRef(otherRef, catalog)).toBeUndefined();
    }
  });

  it("keeps Provider identity distinct, removes exact duplicates, and sorts deterministically", () => {
    const catalog = normalizePiModelCatalog(
      [
        { provider: "z-provider", id: "same", reasoning: true },
        { provider: "a-provider", id: "same", reasoning: false },
        { provider: "a-provider", id: "same", reasoning: false },
      ],
      { provider: "z-provider", id: "same" },
      [harnessThinkingOptionIdSchema.parse("off"), harnessThinkingOptionIdSchema.parse("high")],
      harnessThinkingOptionIdSchema.parse("high"),
    );

    expect(catalog.models.map(({ label }) => label)).toEqual([
      "a-provider / same",
      "z-provider / same",
    ]);
    expect(catalog.models[0]?.ref).not.toEqual(catalog.models[1]?.ref);
    expect(catalog.defaultModel).toEqual(catalog.models[1]?.ref);
    expect(catalog.defaultThinkingOptionId).toBe("high");
    expect(catalog.models[1]?.supportedThinkingOptionIds).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["off"]);
  });

  it("normalizes only Pi-reported Thinking levels and keeps unknown labels Adapter-owned", () => {
    expect(
      normalizePiThinkingOptions([
        harnessThinkingOptionIdSchema.parse("off"),
        harnessThinkingOptionIdSchema.parse("xhigh"),
        harnessThinkingOptionIdSchema.parse("future_mode"),
      ]),
    ).toEqual([
      { id: "off", label: "Off" },
      { id: "xhigh", label: "Extra High" },
      { id: "future_mode", label: "Future Mode" },
    ]);
  });

  it("publishes an effective Model that Pi does not list as available as the default", () => {
    const catalog = normalizePiModelCatalog(
      [{ provider: "available", id: "model", reasoning: true }],
      {
        provider: "retired",
        id: "model",
      },
      [harnessThinkingOptionIdSchema.parse("off"), harnessThinkingOptionIdSchema.parse("high")],
      harnessThinkingOptionIdSchema.parse("high"),
      true,
    );

    expect(catalog.models.map(({ label }) => label)).toEqual([
      "available / model",
      "retired / model",
    ]);
    expect(catalog.defaultModel).toEqual(encodePiModelRef({ provider: "retired", id: "model" }));
    // Listed Models have no per-Model Thinking evidence; the synthesized Model uses Pi's levels.
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(catalog.models[1]?.supportedThinkingOptionIds).toEqual(["off", "high"]);
  });

  it("infers Thinking support for an effective Model from active thinking levels when reasoning is unreported", () => {
    const catalog = normalizePiModelCatalog(
      [],
      { provider: "retired", id: "model" },
      [harnessThinkingOptionIdSchema.parse("off"), harnessThinkingOptionIdSchema.parse("high")],
      harnessThinkingOptionIdSchema.parse("high"),
    );

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["off", "high"]);
    expect(catalog.defaultModel).toEqual(encodePiModelRef({ provider: "retired", id: "model" }));
    expect(catalog.defaultThinkingOptionId).toBe("high");
  });

  it("declares only the Thinking levels Pi reports for a synthesized effective Model", () => {
    const catalog = normalizePiModelCatalog(
      [],
      { provider: "retired", id: "model" },
      [harnessThinkingOptionIdSchema.parse("max")],
      harnessThinkingOptionIdSchema.parse("max"),
      true,
    );

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["max"]);
    expect(catalog.defaultThinkingOptionId).toBe("max");
  });

  it("omits reported Thinking levels that the draft catalog does not offer", () => {
    const catalog = normalizePiModelCatalog(
      [],
      { provider: "retired", id: "model" },
      [
        harnessThinkingOptionIdSchema.parse("off"),
        harnessThinkingOptionIdSchema.parse("future_mode"),
      ],
      harnessThinkingOptionIdSchema.parse("off"),
      true,
    );

    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["off"]);
  });

  it("matches listed Models when Pi reports no Thinking levels for a synthesized effective Model", () => {
    const catalog = normalizePiModelCatalog(
      [{ provider: "available", id: "model", reasoning: true }],
      { provider: "retired", id: "model" },
      null,
      harnessThinkingOptionIdSchema.parse("high"),
      true,
    );

    expect(catalog.thinkingOptions).toEqual([]);
    expect(catalog.defaultThinkingOptionId).toBeUndefined();
    expect(
      catalog.models.map(({ supportedThinkingOptionIds }) => supportedThinkingOptionIds),
    ).toEqual([[], []]);
  });

  it("does not claim Thinking support for an effective Model when thinking levels are off only", () => {
    const catalog = normalizePiModelCatalog(
      [],
      { provider: "retired", id: "model" },
      [harnessThinkingOptionIdSchema.parse("off")],
      harnessThinkingOptionIdSchema.parse("off"),
    );

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["off"]);
    expect(catalog.defaultModel).toEqual(encodePiModelRef({ provider: "retired", id: "model" }));
    expect(catalog.defaultThinkingOptionId).toBe("off");
  });

  it("respects explicit reasoning=false when thinking level is off", () => {
    const catalog = normalizePiModelCatalog(
      [],
      { provider: "retired", id: "model" },
      [harnessThinkingOptionIdSchema.parse("off")],
      harnessThinkingOptionIdSchema.parse("off"),
      false,
    );

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toEqual(["off"]);
  });

  it("rejects duplicate Model entries with conflicting reasoning metadata", () => {
    expect(() =>
      normalizePiModelCatalog(
        [
          { provider: "provider", id: "model", reasoning: true },
          { provider: "provider", id: "model", reasoning: false },
        ],
        { provider: "provider", id: "model" },
        [harnessThinkingOptionIdSchema.parse("off")],
        harnessThinkingOptionIdSchema.parse("off"),
      ),
    ).toThrow("disagree on reasoning capability");
  });

  it("rejects malformed, foreign, and non-canonical opaque refs", () => {
    const catalog = normalizePiModelCatalog(
      [{ provider: "provider", id: "model", reasoning: true }],
      null,
      null,
      null,
    );
    const nonCanonical = Buffer.from('[ "provider", "model" ]', "utf8").toString("base64url");
    for (const id of [
      "other-adapter-v1.value",
      "pi-model-v1.bm90LWpzb24",
      `pi-model-v1.${nonCanonical}`,
    ]) {
      expect(
        normalizeStoredPiModelRef(harnessModelRefSchema.parse({ id }), catalog),
      ).toBeUndefined();
    }
  });
});
