import { HARNESS_MODEL_REF_MAX_LENGTH, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  canonicalizeOfficialCodexModelRef,
  decodeOfficialCodexModelRef,
  encodeOfficialCodexModelRef,
} from "../src/official-codex-model-ref.js";

describe("official Codex Model refs", () => {
  it.each([
    ["gpt-5.6-luna", "codex-model-v1.Z3B0LTUuNi1sdW5h"],
    ["xai/grok-4.6", "codex-model-v1.eGFpL2dyb2stNC42"],
    ["kimi/k3[1m]", "codex-model-v1.a2ltaS9rM1sxbV0"],
  ])("round-trips %s through a canonical opaque ref", (nativeModelId, opaqueId) => {
    const ref = encodeOfficialCodexModelRef(nativeModelId);
    expect(ref).toEqual({ id: opaqueId });
    expect(decodeOfficialCodexModelRef(ref)).toBe(nativeModelId);
  });

  it("canonicalizes legacy transport-safe native IDs", () => {
    const legacy = harnessModelRefSchema.parse({ id: "gpt-5.6-luna" });
    expect(decodeOfficialCodexModelRef(legacy)).toBe("gpt-5.6-luna");
    expect(canonicalizeOfficialCodexModelRef(legacy)).toEqual({
      id: "codex-model-v1.Z3B0LTUuNi1sdW5h",
    });
  });

  it("rejects empty, malformed, non-canonical, and overlong refs", () => {
    expect(() =>
      decodeOfficialCodexModelRef(harnessModelRefSchema.parse({ id: "codex-model-v1.empty" })),
    ).toThrow();
    expect(() =>
      decodeOfficialCodexModelRef(
        harnessModelRefSchema.parse({ id: "codex-model-v1.Z3B0LTUuNi1sdW5h." }),
      ),
    ).toThrow("not canonical");
    expect(() => encodeOfficialCodexModelRef(" ")).toThrow("must not be empty");
    expect(() => encodeOfficialCodexModelRef("x".repeat(HARNESS_MODEL_REF_MAX_LENGTH))).toThrow(
      "too long",
    );
  });

  it("canonicalizes legacy native IDs that collide with the opaque namespace", () => {
    const nativeModelId = "codex-model-v1.literal";
    expect(decodeOfficialCodexModelRef(encodeOfficialCodexModelRef(nativeModelId))).toBe(
      nativeModelId,
    );
    const legacy = harnessModelRefSchema.parse({ id: nativeModelId });
    expect(() => decodeOfficialCodexModelRef(legacy)).toThrow();
    expect(decodeOfficialCodexModelRef(canonicalizeOfficialCodexModelRef(legacy))).toBe(
      nativeModelId,
    );
  });
});
