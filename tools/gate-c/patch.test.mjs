import { describe, expect, it } from "vitest";

import { verifyUnifiedPatch } from "./patch.mjs";

describe("Gate C unified patch verification", () => {
  it("applies a standard multi-hunk patch to CRLF input", () => {
    const before = "alpha\r\nbeta\r\ngamma\r\ndelta\r\n";
    const patch = [
      "--- a/sample.txt",
      "+++ b/sample.txt",
      "@@ -1,2 +1,2 @@",
      "-alpha",
      "+ALPHA",
      " beta",
      "@@ -3,2 +3,2 @@",
      " gamma",
      "-delta",
      "+DELTA",
      "",
    ].join("\r\n");
    expect(verifyUnifiedPatch(before, patch, "ALPHA\r\nbeta\r\ngamma\r\nDELTA\r\n")).toBe(true);
  });

  it("rejects absent or non-applicable patches", () => {
    expect(verifyUnifiedPatch("a\n", undefined, "b\n")).toBe(false);
    expect(verifyUnifiedPatch("different\n", "@@ -1 +1 @@\n-a\n+b\n", "b\n")).toBe(false);
  });
});
