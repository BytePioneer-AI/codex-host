import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { formatDelegationModel } from "../src/delegation-model-argument.js";
import { resolveOfficialDelegationModel } from "../src/official-delegation-model.js";
import {
  normalizeOfficialCodexModelRef,
  officialCodexModelRef,
  officialCodexModelSelection,
} from "../src/official-codex-model-ref.js";

describe("official Codex Model refs", () => {
  it.each([
    [null, "codex-model-v1.cHJvdmlkZXIvbW9kZWw"],
    ["priority", "codex-fast-model-v1.cHJvdmlkZXIvbW9kZWw"],
    ["ultrafast", "codex-ultra-v1.cHJvdmlkZXIvbW9kZWw"],
  ])("normalizes legacy %s and writes the native Model ID and tier", (serviceTier, id) => {
    const ref = officialCodexModelRef("provider/model", serviceTier);
    expect(ref).toEqual({ id: "provider/model", ...(serviceTier ? { serviceTier } : {}) });
    expect(normalizeOfficialCodexModelRef(harnessModelRefSchema.parse({ id }))).toEqual(ref);
    expect(officialCodexModelSelection(ref)).toEqual({ model: "provider/model", serviceTier });
  });

  it.each(["xai/grok-4.6", "kimi/k3[1m]", " 模型 A ", "模".repeat(HARNESS_MODEL_REF_MAX_LENGTH)])(
    "preserves native Model ID (%#)",
    async (id) => {
      const ref = officialCodexModelRef(id, "flex");
      expect(ref).toEqual({ id });
      expect(formatDelegationModel(ref)).toBe(id);
      await expect(resolveOfficialDelegationModel(id, async () => undefined)).resolves.toEqual(ref);
    },
  );

  it("resolves CLI shorthand only for advertised tiers, without reinterpreting literal structured IDs", async () => {
    const fast = officialCodexModelRef("foo", "priority");
    const ultra = officialCodexModelRef("foo", "ultrafast");
    const literal = officialCodexModelRef("foo~fast");
    const unadvertised = officialCodexModelRef("bar~ultrafast");
    const legacyLooking = officialCodexModelRef("codex-model-v1.Zm9v");
    const catalog = harnessModelCatalogSchema.parse({
      models: [
        { ref: { id: "foo" }, label: "Foo", fastModel: fast },
        { ref: ultra, label: "Foo · Ultrafast" },
        { ref: literal, label: "Literal" },
        { ref: { id: "bar" }, label: "Bar" },
        { ref: unadvertised, label: "Bar Literal" },
        { ref: legacyLooking, label: "Native with a legacy prefix" },
      ],
      thinkingOptions: [],
    });
    const resolve = (argument: string | typeof literal) =>
      resolveOfficialDelegationModel(argument, async () => catalog);
    expect(formatDelegationModel(fast)).toBe("foo~fast");
    expect(formatDelegationModel(ultra)).toBe("foo~ultrafast");
    expect(formatDelegationModel(literal)).toBe("foo~fast");
    await expect(resolve("foo~fast")).resolves.toEqual(fast);
    await expect(resolve("foo~ultrafast")).resolves.toEqual(ultra);
    await expect(resolve(literal)).resolves.toEqual(literal);
    await expect(resolve("bar~ultrafast")).resolves.toEqual(unadvertised);
    await expect(resolve(legacyLooking.id)).resolves.toEqual(legacyLooking);
  });
});
