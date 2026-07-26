import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";

describe("harness-adapter package", () => {
  it("participates in the shared contract", () => {
    expect(packageMetadata).toEqual({
      name: "@codexhost/harness-adapter",
      contractVersion: 1,
    });
  });
});
