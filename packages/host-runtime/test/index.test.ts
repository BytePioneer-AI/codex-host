import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";

describe("host-runtime package", () => {
  it("declares the composition-root dependencies", () => {
    expect(packageMetadata.dependencies).toHaveLength(4);
    expect(packageMetadata.dependencies).toContain("@codexhost/protocol-core");
  });
});
