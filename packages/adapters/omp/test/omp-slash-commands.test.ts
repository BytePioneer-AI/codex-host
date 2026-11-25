import { describe, expect, it } from "vitest";

import { ompLiveCommands, parseOmpAvailableCommands } from "../src/omp-slash-commands.js";

describe("OMP advertised commands", () => {
  it("exposes context and extension commands while excluding native skills and other built-ins", () => {
    const native = parseOmpAvailableCommands([
      { name: "model", description: "Switch model", source: "builtin" },
      { name: "compact", description: "Compact", source: "builtin" },
      { name: "context", description: "Context usage", source: "builtin" },
      { name: "skill:tdd", description: "TDD", source: "skill" },
      { name: "review", description: "Review", source: "extension" },
      { name: "legacy", description: "No source" },
    ]);
    expect(ompLiveCommands(native)).toEqual([
      { name: "context", description: "Context usage" },
      { name: "review", description: "Review" },
      { name: "legacy", description: "No source" },
    ]);
    expect(parseOmpAvailableCommands("x")).toEqual([]);
  });
});
