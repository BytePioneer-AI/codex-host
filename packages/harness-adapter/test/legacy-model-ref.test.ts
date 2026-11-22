import { Buffer } from "node:buffer";

import { harnessModelCatalogSchema, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { normalizeLegacyBase64ModelRef } from "../src/index.js";

const id = " provider/模型 ";
const payload = Buffer.from(id).toString("base64url");
const tieredId = "tiered-only";
const catalog = harnessModelCatalogSchema.parse({
  models: [
    { ref: { id, serviceTier: "priority" }, label: "Fast" },
    { ref: { id }, label: "Standard" },
    { ref: { id: tieredId, serviceTier: "priority" }, label: "Fast only" },
  ],
  thinkingOptions: [],
});

describe("normalizeLegacyBase64ModelRef", () => {
  it.each(["legacy.", ""])("finds the exact untiered Model with prefix %j", (prefix) => {
    const stored = harnessModelRefSchema.parse({ id: prefix + payload });
    expect(normalizeLegacyBase64ModelRef(stored, catalog, prefix)).toEqual({ id });
  });

  it.each([
    { id: `other.${payload}` },
    { id: `legacy.${payload}=` },
    { id: "legacy." },
    { id: `legacy.${Buffer.from("unlisted").toString("base64url")}` },
    { id: `legacy.${Buffer.from(tieredId).toString("base64url")}` },
    { id: `legacy.${payload}`, serviceTier: "priority" },
  ])("does not normalize an unmatched, noncanonical or tiered Ref: %j", (stored) => {
    expect(
      normalizeLegacyBase64ModelRef(harnessModelRefSchema.parse(stored), catalog, "legacy."),
    ).toBeUndefined();
  });
});
