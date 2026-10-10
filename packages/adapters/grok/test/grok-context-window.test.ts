import { describe, expect, it } from "vitest";
import { parseGrokModelState } from "../src/grok-models.js";

describe("Grok default context window", () => {
  it.each([
    [[256000, 500000], 500000],
    [[256000], undefined],
    [undefined, undefined],
    [["500000"], undefined],
    [[1000000], undefined],
  ])("only selects 500K when the native model advertises it: %j", (windows, expected) => {
    const state = parseGrokModelState({
      currentModelId: "fixture",
      availableModels: [
        {
          modelId: "fixture",
          name: "Fixture",
          _meta: {
            totalContextTokens: 256000,
            contextWindows: windows,
          },
        },
      ],
    });
    expect(state?.defaultContextWindowTokensByModel.get("fixture")).toBe(expected);
    // Parsing preferences alone must not pretend native configuration already succeeded.
    expect(state?.contextWindowTokensByModel.get("fixture")).toBe(256000);
  });
});
