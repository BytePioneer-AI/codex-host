import { describe, expect, it } from "vitest";
import { packageMetadata } from "../src/index.js";
import type { HarnessExecutionPolicy } from "../src/index.js";

describe("harness-adapter package", () => {
  it("participates in the shared contract", () => {
    expect(packageMetadata).toEqual({
      name: "@codexhost/harness-adapter",
      contractVersion: 1,
    });
  });

  it("exports the create-time execution policy contract", () => {
    const policy: HarnessExecutionPolicy = "unattended-full-access";
    expect(policy).toBe("unattended-full-access");
  });
});
