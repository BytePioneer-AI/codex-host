import { describe, expect, it } from "vitest";

import { grokInvocation } from "../src/command.js";

describe("Grok invocation", () => {
  it("starts ACP stdio without a Model flag by default", () => {
    expect(grokInvocation("/opt/grok", "darwin")).toMatchObject({
      command: "/opt/grok",
      arguments: ["agent", "--no-leader", "stdio"],
    });
  });

  it("passes --model so session/new bakes the selected identity prompt", () => {
    expect(grokInvocation("/opt/grok", "darwin", "grok-4.5")).toMatchObject({
      command: "/opt/grok",
      arguments: ["agent", "--no-leader", "--model", "grok-4.5", "stdio"],
    });
  });
});
