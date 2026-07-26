import { describe, expect, it } from "vitest";
import { packageMetadata, workspaceContractVersionSchema } from "../src/index.js";

describe("shared-contracts package", () => {
  it("exports a validated workspace contract version", () => {
    expect(workspaceContractVersionSchema.parse(1)).toBe(1);
    expect(packageMetadata.contractVersion).toBe(1);
  });
});
