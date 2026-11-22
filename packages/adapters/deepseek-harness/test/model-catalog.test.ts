import { HARNESS_MODEL_REF_MAX_LENGTH, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodeDeepSeekHarnessModelRef,
  encodeDeepSeekHarnessModelRef,
  normalizeDeepSeekModelCatalog,
  normalizeStoredDeepSeekModelRef,
  type DeepSeekNativeModelRef,
} from "../src/model-catalog.js";

function legacy(provider: string, model: string) {
  return harnessModelRefSchema.parse({
    id: `deepseek-harness-model-v2.${Buffer.from(JSON.stringify([provider, model])).toString("base64url")}`,
  });
}

function group(provider: string, ...models: string[]) {
  return { id: provider, name: provider, models: models.map((id) => ({ id, name: id })) };
}

describe("DeepSeek Model references", () => {
  it.each<DeepSeekNativeModelRef>([
    { provider: " 官方 ", model: "模型/flash: 1 " },
    { provider: "官方/提供方.v1", model: "系列/模型~高" },
  ])("publishes and resolves the exact identity: %j", (native) => {
    const { provider, model } = native;
    const { catalog, index } = normalizeDeepSeekModelCatalog([group(provider, model)], native);
    const ref = harnessModelRefSchema.parse({ id: `${provider}/${model}` });
    expect(catalog.models[0]?.ref).toEqual(ref);
    expect(catalog.defaultModel).toEqual(ref);
    expect(decodeDeepSeekHarnessModelRef(ref, index)).toEqual(native);
    const saved = legacy(provider.trim(), model.trim());
    expect(normalizeStoredDeepSeekModelRef(saved, index)).toEqual(ref);
    expect(() => decodeDeepSeekHarnessModelRef(saved, index)).toThrow("unavailable");
  });

  it("keeps colliding entries selectable but rejects their ambiguous readable ID", () => {
    const selection = { provider: "team/proxy", model: "model" };
    const { catalog, index } = normalizeDeepSeekModelCatalog(
      [group("team", "proxy/model", "plain"), group("team/proxy", "model")],
      selection,
    );
    const first = legacy("team", "proxy/model");
    const second = legacy("team/proxy", "model");
    expect(catalog.models.map(({ ref }) => ref.id)).toEqual([first.id, "team/plain", second.id]);
    expect(catalog.defaultModel).toEqual(second);
    expect(decodeDeepSeekHarnessModelRef(first, index)).toEqual({
      provider: "team",
      model: "proxy/model",
    });
    expect(decodeDeepSeekHarnessModelRef(second, index)).toEqual(selection);
    expect(() =>
      decodeDeepSeekHarnessModelRef(harnessModelRefSchema.parse({ id: "team/proxy/model" }), index),
    ).toThrow("unavailable");
  });

  it("does not guess when legacy trimming collapsed two identities", () => {
    const { index } = normalizeDeepSeekModelCatalog([group("provider", "model", "model ")]);
    expect(normalizeStoredDeepSeekModelRef(legacy("provider", "model"), index)).toBeUndefined();
  });

  it.each([
    "deepseek-harness-model-v1.Zmxhc2g",
    "another-adapter-model",
    "deepseek-harness-model-v2.invalid",
    `${legacy("provider", "model").id}=`,
  ])("rejects obsolete, foreign or malformed stored Model Ref %s", (id) => {
    const { index } = normalizeDeepSeekModelCatalog([group("provider", "model")]);
    expect(
      normalizeStoredDeepSeekModelRef(harnessModelRefSchema.parse({ id }), index),
    ).toBeUndefined();
  });

  it("rejects empty identities and oversized Model references", () => {
    expect(() => encodeDeepSeekHarnessModelRef({ provider: " ", model: "flash" })).toThrow(
      "must not be empty",
    );
    expect(() => encodeDeepSeekHarnessModelRef({ provider: "official", model: " " })).toThrow(
      "must not be empty",
    );
    expect(() =>
      encodeDeepSeekHarnessModelRef({
        provider: "official",
        model: "x".repeat(HARNESS_MODEL_REF_MAX_LENGTH),
      }),
    ).toThrow();
  });
});
