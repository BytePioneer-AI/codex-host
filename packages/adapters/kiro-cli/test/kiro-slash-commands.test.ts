import { describe, expect, it } from "vitest";

import { kiroLiveCommands, parseKiroAvailableCommands } from "../src/kiro-slash-commands.js";

describe("Kiro advertised commands", () => {
  it("keeps steering and custom agents while excluding native skills", () => {
    const native = parseKiroAvailableCommands([
      { name: "quick-spec", description: "Spec", _meta: { kiro: { type: "steering" } } },
      { name: "context-gatherer", description: "", _meta: { kiro: { type: "custom-agent" } } },
      { name: "tdd", description: "TDD", _meta: { kiro: { type: "skill" } } },
      { name: "plain", description: "No meta" },
      { name: 3 },
    ]);
    expect(native.map(({ type }) => type)).toEqual(["steering", "custom-agent", "skill", null]);
    expect(kiroLiveCommands(native)).toEqual([
      { name: "quick-spec", description: "Spec" },
      { name: "context-gatherer", description: "" },
      { name: "plain", description: "No meta" },
    ]);
  });
});
