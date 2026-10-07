import { describe, expect, it } from "vitest";
import { usageModelLabel } from "../../src/console/usage/model-labels.js";

describe("usage model labels", () => {
  it("uses native display metadata without guessing unknown IDs", () => {
    const labels = [{ harness: "qoder", model: "qfmodel", label: "Qwen3.8-Flash" }];
    expect(usageModelLabel("qfmodel", labels)).toBe("Qwen3.8-Flash");
    expect(usageModelLabel("qfmodel", undefined)).toBe("qfmodel");
    expect(usageModelLabel("other", labels)).toBe("other");
    expect(usageModelLabel("qfmodel", labels, "unrelated")).toBe("qfmodel");
  });

  it("does not use one distribution's label for another or mislabel combined rows", () => {
    const labels = [
      { harness: "qoder", model: "mmodel", label: "MiniMax-M3" },
      { harness: "qoder-cn", model: "mmodel", label: "MiniMax-M2.7" },
    ];
    expect(usageModelLabel("mmodel", labels)).toBe("mmodel");
    expect(usageModelLabel("mmodel", labels, "qoder")).toBe("MiniMax-M3");
    expect(usageModelLabel("mmodel", labels, "qoder-cn")).toBe("MiniMax-M2.7");
    expect(
      usageModelLabel("mmodel", [
        ...labels.slice(0, 1),
        { harness: "other", model: "mmodel", label: "mmodel" },
      ]),
    ).toBe("mmodel");
  });

  it("can display a common label across distributions", () => {
    expect(
      usageModelLabel("qfmodel", [
        { harness: "qoder", model: "qfmodel", label: "Qwen3.8-Flash" },
        { harness: "qoder-cn", model: "qfmodel", label: "Qwen3.8-Flash" },
      ]),
    ).toBe("Qwen3.8-Flash");
  });
});
