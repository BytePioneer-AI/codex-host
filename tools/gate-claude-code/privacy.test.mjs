import { describe, expect, it } from "vitest";

import { assertTrackedSummarySafe } from "./privacy.mjs";

describe("Claude Probe tracked-evidence privacy", () => {
  it("accepts allowlisted structural facts", () => {
    expect(
      assertTrackedSummarySafe({
        sdkVersion: "0.3.220",
        commandSource: "path",
        checks: { sameSession: true },
        facts: { eventTypes: ["system", "assistant", "result"] },
      }),
    ).toBeDefined();
  });

  it.each([
    [{ prompt: "secret" }, "key"],
    [{ accountId: "native-account" }, "key"],
    [{ native: "0195f89c-b6dc-7dcb-b829-438b1fdcf41a" }, "value"],
    [{ native: "person@example.test" }, "value"],
    [{ native: "/Users/example/private.json" }, "value"],
    [{ native: "C:\\Users\\example\\private.json" }, "value"],
  ])("rejects sensitive tracked evidence (%s)", (value) => {
    expect(() => assertTrackedSummarySafe(value)).toThrow(/forbidden|sensitive/u);
  });
});
