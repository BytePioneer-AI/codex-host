import { describe, expect, it } from "vitest";

import { overallStatus, scenarioResult, scenarioStatus } from "./contracts.mjs";

function result(status, required = true) {
  return scenarioResult({
    id: `scenario-${status.toLowerCase()}`,
    profile: "hermetic",
    required,
    status,
    checks: { observed: status === "PASS" },
    facts: { eventCount: 1 },
    ...(status === "BLOCKED"
      ? { blocker: { category: "installation", resolution: "Install Claude Code" } }
      : {}),
  });
}

describe("Claude Probe contracts", () => {
  it("derives a scenario status from all checks", () => {
    expect(scenarioStatus({ first: true, second: true })).toBe("PASS");
    expect(scenarioStatus({ first: true, second: false })).toBe("FAIL");
  });

  it("rejects PASS scenarios with failed checks", () => {
    expect(() =>
      scenarioResult({
        id: "invalid-pass",
        profile: "hermetic",
        required: true,
        status: "PASS",
        checks: { invariant: false },
        facts: {},
      }),
    ).toThrow("contains a failed check");
  });

  it("requires a concrete blocker only for BLOCKED", () => {
    expect(() =>
      scenarioResult({
        id: "missing-blocker",
        profile: "inspect",
        required: true,
        status: "BLOCKED",
        checks: {},
        facts: {},
      }),
    ).toThrow();
    expect(result("BLOCKED").blocker.category).toBe("installation");
  });

  it("uses only required scenarios for the overall verdict", () => {
    expect(overallStatus([result("PASS"), result("FAIL", false)])).toBe("PASS");
    expect(overallStatus([result("PASS"), result("BLOCKED")])).toBe("BLOCKED");
    expect(overallStatus([result("BLOCKED"), result("FAIL")])).toBe("FAIL");
  });
});
