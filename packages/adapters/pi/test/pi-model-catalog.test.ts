import { Buffer } from "node:buffer";

import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodePiModelRef,
  encodePiModelRef,
  normalizePiModelCatalog,
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
    );

    expect(catalog.models.map(({ label }) => label)).toEqual([
      "a-provider / same",
      "z-provider / same",
    ]);
    expect(catalog.models[0]?.ref).not.toEqual(catalog.models[1]?.ref);
    expect(catalog.defaultModel).toEqual(catalog.models[1]?.ref);
  });

  it("rejects an effective Model absent from the available catalog", () => {
    expect(() =>
      normalizePiModelCatalog([{ provider: "available", id: "model" }], {
        provider: "missing",
        id: "model",
      }),
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
