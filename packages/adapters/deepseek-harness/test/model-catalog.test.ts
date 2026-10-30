import { HARNESS_MODEL_REF_MAX_LENGTH, harnessModelRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  decodeDeepSeekHarnessModelRef,
  encodeDeepSeekHarnessModelRef,
} from "../src/model-catalog.js";

describe("DeepSeek Model references", () => {
  it("round-trips the canonical provider and model identity", () => {
    const ref = encodeDeepSeekHarnessModelRef({ provider: " 官方 ", model: "模型/flash " });
    expect(decodeDeepSeekHarnessModelRef(ref)).toEqual({ provider: "官方", model: "模型/flash" });
  });

  it.each([
    "deepseek-harness-model-v1.Zmxhc2g",
    "another-adapter-model",
    "deepseek-harness-model-v2.invalid",
    `deepseek-harness-model-v2.${Buffer.from(JSON.stringify(["provider", 123])).toString("base64url")}`,
    `deepseek-harness-model-v2.${Buffer.from(JSON.stringify(["provider", "model", "extra"])).toString("base64url")}`,
    `deepseek-harness-model-v2.${Buffer.from(JSON.stringify([" provider", "model"])).toString("base64url")}`,
  ])("rejects obsolete, foreign or malformed Model Ref %s", (id) => {
    expect(() => decodeDeepSeekHarnessModelRef(harnessModelRefSchema.parse({ id }))).toThrow();
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
    ).toThrow("too long");
  });
});
