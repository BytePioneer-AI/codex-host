import { describe, expect, it } from "vitest";

import { grokInvocation } from "../src/command.js";

describe("Grok invocation", () => {
  it("starts ACP stdio without a Model flag by default", () => {
    expect(grokInvocation("/opt/grok", "darwin")).toMatchObject({
      command: "/opt/grok",
      arguments: ["agent", "--no-leader", "stdio"],
    });
  });

  it("passes the exact startup Model as one native argument", () => {
    const id = " xai/模型 [1m] & (test) ";
    expect(grokInvocation("/opt/grok", "darwin", id)).toMatchObject({
      command: "/opt/grok",
      arguments: ["agent", "--no-leader", "--model", id, "stdio"],
    });
    expect(grokInvocation("C:\\bin\\grok.cmd", "win32", id).arguments.at(-1)).toBe(
      `""C:\\bin\\grok.cmd" "agent" "--no-leader" "--model" "${id}" "stdio""`,
    );
  });
});
