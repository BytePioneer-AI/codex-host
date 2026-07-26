import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";

describe("mapping-store package", () => {
  it("builds without defining persistence behavior", () => {
    expect(packageMetadata.name).toBe("@codexhost/mapping-store");
    expect(packageMetadata.contractVersion).toBe(1);
  });
});
