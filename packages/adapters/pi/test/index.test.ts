import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";

describe("Pi adapter package", () => {
  it("depends on the public HarnessAdapter package", () => {
    expect(packageMetadata.adapterContract).toBe("@codexhost/harness-adapter");
  });
});
