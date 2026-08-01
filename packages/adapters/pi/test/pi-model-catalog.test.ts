import { Buffer } from "node:buffer";

import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodePiModelRef,
  encodePiModelRef,
  normalizePiModelCatalog,
  normalizePiThinkingOptions,
} from "../src/pi-model-catalog.js";

describe("Pi Model Catalog normalization", () => {
  it("round-trips exact Provider and Model identities with separators and Unicode", () => {
    const native = { provider: "local/provider-一", id: "family/model-v1.2" };
    const ref = encodePiModelRef(native);

    expect(ref.id).toMatch(/^pi-model-v1\.[A-Za-z0-9_-]+$/u);
    expect(decodePiModelRef(ref)).toEqual(native);
  });

  it("keeps Provider identity distinct, removes exact duplicates, and sorts deterministically", () => {
    const catalog = normalizePiModelCatalog(
      [
        { provider: "z-provider", id: "same" },
        { provider: "a-provider", id: "same" },
        { provider: "a-provider", id: "same" },
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
    expect(catalog.models[1]?.supportedThinkingOptionIds).toEqual(["off", "high"]);
    expect(catalog.models[0]?.supportedThinkingOptionIds).toBeUndefined();
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

  it("rejects an effective Model absent from the available catalog", () => {
    expect(() =>
      normalizePiModelCatalog(
        [{ provider: "available", id: "model" }],
        {
          provider: "missing",
          id: "model",
        },
        [harnessThinkingOptionIdSchema.parse("off")],
        harnessThinkingOptionIdSchema.parse("off"),
      ),
    ).toThrow("absent from the available Model catalog");
  });

  it("rejects malformed, foreign, and non-canonical opaque refs", () => {
    expect(() =>
      decodePiModelRef(harnessModelRefSchema.parse({ id: "other-adapter-v1.value" })),
    ).toThrow("does not belong");
    expect(() =>
      decodePiModelRef(harnessModelRefSchema.parse({ id: "pi-model-v1.bm90LWpzb24" })),
    ).toThrow("malformed");

    const nonCanonical = Buffer.from('[ "provider", "model" ]', "utf8").toString("base64url");
    expect(() =>
      decodePiModelRef(harnessModelRefSchema.parse({ id: `pi-model-v1.${nonCanonical}` })),
    ).toThrow("not canonical");
  });
});
