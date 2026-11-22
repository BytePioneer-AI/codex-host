import { HARNESS_MODEL_REF_MAX_LENGTH, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import {
  formatOfficialDelegationModel,
  resolveOfficialDelegationModel,
} from "../src/official-delegation-model.js";

import {
  canonicalizeOfficialCodexModelRef,
  decodeOfficialCodexModelRef,
  decodeOfficialCodexModelSelection,
  encodeOfficialCodexModelRef,
} from "../src/official-codex-model-ref.js";

describe("official Codex Model refs", () => {
  it.each([
    ["priority", "codex-fast-model-v1.cHJvdmlkZXIvbW9kZWw"],
    ["ultrafast", "codex-ultra-v1.cHJvdmlkZXIvbW9kZWw"],
  ])("round-trips %s as a selection of the same native Model", (serviceTier, id) => {
    const ref = encodeOfficialCodexModelRef("provider/model", serviceTier);
    expect(ref).toEqual({ id });
    expect(decodeOfficialCodexModelRef(ref)).toBe("provider/model");
    expect(decodeOfficialCodexModelSelection(ref)).toEqual({
      model: "provider/model",
      serviceTier,
    });
    expect(canonicalizeOfficialCodexModelRef(ref)).toEqual(ref);
    expect(() =>
      decodeOfficialCodexModelSelection(harnessModelRefSchema.parse({ id: `${ref.id}.` })),
    ).toThrow("canonical");
  });

  it("keeps the base ref for an ordinary selection and unrecognized tiers", () => {
    const ref = encodeOfficialCodexModelRef("provider/model");
    expect(decodeOfficialCodexModelSelection(ref)).toEqual({
      model: "provider/model",
      serviceTier: null,
    });
    expect(encodeOfficialCodexModelRef("provider/model", "flex")).toEqual(ref);
  });
  it.each([
    ["gpt-5.6-luna", "codex-model-v1.Z3B0LTUuNi1sdW5h"],
    ["xai/grok-4.6", "codex-model-v1.eGFpL2dyb2stNC42"],
    ["kimi/k3[1m]", "codex-model-v1.a2ltaS9rM1sxbV0"],
  ])("round-trips %s through a canonical opaque ref", async (nativeModelId, opaqueId) => {
    const ref = encodeOfficialCodexModelRef(nativeModelId);
    expect(ref).toEqual({ id: opaqueId });
    expect(decodeOfficialCodexModelRef(ref)).toBe(nativeModelId);
    expect(formatOfficialDelegationModel(ref)).toBe(nativeModelId);
    await expect(
      resolveOfficialDelegationModel(nativeModelId, async () => undefined),
    ).resolves.toEqual(ref);
  });

  it("canonicalizes legacy transport-safe native IDs", () => {
    const legacy = harnessModelRefSchema.parse({ id: "gpt-5.6-luna" });
    expect(decodeOfficialCodexModelRef(legacy)).toBe("gpt-5.6-luna");
    expect(canonicalizeOfficialCodexModelRef(legacy)).toEqual({
      id: "codex-model-v1.Z3B0LTUuNi1sdW5h",
    });
  });

  it("round-trips readable choices even when a native ID ends in a tier suffix", async () => {
    const fast = harnessModelRefSchema.parse({ id: "codex-fast-model-v1.Zm9v" });
    const literal = encodeOfficialCodexModelRef("foo~fast");
    const unadvertised = encodeOfficialCodexModelRef("bar~ultrafast");
    const catalog = {
      models: [
        { ref: encodeOfficialCodexModelRef("foo"), label: "Foo", fastModel: fast },
        { ref: literal, label: "Literal" },
        { ref: encodeOfficialCodexModelRef("bar"), label: "Bar" },
        { ref: unadvertised, label: "Bar Literal" },
      ],
      thinkingOptions: [],
    };
    const resolve = (argument: string) =>
      resolveOfficialDelegationModel(argument, async () => catalog);
    expect(formatOfficialDelegationModel(fast, catalog)).toBe("foo~fast");
    const literalArgument = formatOfficialDelegationModel(literal, catalog);
    expect(literalArgument).toBe(literal.id);
    expect(formatOfficialDelegationModel(literal)).toBe(literal.id);
    const unadvertisedArgument = formatOfficialDelegationModel(unadvertised, catalog);
    expect(unadvertisedArgument).toBe("bar~ultrafast");
    await expect(resolve("foo~fast")).resolves.toEqual(fast);
    await expect(resolve(literalArgument)).resolves.toEqual(literal);
    await expect(resolve(unadvertisedArgument)).resolves.toEqual(unadvertised);
    await expect(resolve(fast.id)).resolves.toEqual(fast);
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
