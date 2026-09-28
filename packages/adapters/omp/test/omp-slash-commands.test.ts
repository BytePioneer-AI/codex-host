import { describe, expect, it } from "vitest";

import { ompLiveCommands, parseOmpAvailableCommands } from "../src/omp-slash-commands.js";

describe("OMP advertised commands", () => {
  it("exposes skills and extension commands, never built-ins", () => {
    const native = parseOmpAvailableCommands([
      { name: "model", description: "Switch model", source: "builtin" },
      { name: "compact", description: "Compact", source: "builtin" },
      { name: "skill:tdd", description: "TDD", source: "skill" },
      { name: "review", description: "Review", source: "extension" },
      { name: "legacy", description: "No source" },
    ]);
    expect(ompLiveCommands(native)).toEqual([
      { name: "skill:tdd", description: "TDD", kind: "skill" },
      { name: "review", description: "Review", kind: "command" },
      { name: "legacy", description: "No source", kind: "command" },
    ]);
    expect(parseOmpAvailableCommands("x")).toEqual([]);
  });
});
