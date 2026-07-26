import { describe, expect, it } from "vitest";

import { deriveCapabilities } from "./capabilities.mjs";

const base = { profile: "isolated", required: true, checks: {}, evidence: [] };

describe("Gate C capability matrix", () => {
  it("requires all evidence scenarios for multi-source capabilities", () => {
    const partial = deriveCapabilities([{ ...base, id: "extension-interactions", status: "PASS" }]);
    expect(partial.find(({ id }) => id === "question").status).toBe("not-observed");
    const complete = deriveCapabilities([
      { ...base, id: "extension-interactions", status: "PASS" },
      { ...base, id: "native-live-question", status: "PASS" },
    ]);
    expect(complete.find(({ id }) => id === "question").status).toBe("supported");
  });

  it("keeps approval optional and absent without explicit native semantics", () => {
    const capabilities = deriveCapabilities([
      { ...base, id: "native-live-question", status: "PASS" },
    ]);
    expect(capabilities.find(({ id }) => id === "approval")).toMatchObject({
      required: false,
      status: "not-observed",
    });
  });
});
