import { describe, expect, it } from "vitest";
import { rendererBuildMetadata } from "../src/index.js";

describe("renderer-extension package", () => {
  it("declares a browser-only build target", () => {
    expect(rendererBuildMetadata.target).toBe("browser");
    expect(rendererBuildMetadata.contractVersion).toBe(1);
  });
});
