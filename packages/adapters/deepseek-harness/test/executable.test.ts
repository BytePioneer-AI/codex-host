import { describe, expect, it } from "vitest";

import { resolveWindowsTaskkillPath } from "../src/executable.js";

describe("DeepSeek executable helpers", () => {
  it("resolves taskkill from SystemRoot without consulting PATH", () => {
    expect(
      resolveWindowsTaskkillPath({
        PATH: String.raw`C:\attacker`,
        SystemRoot: String.raw`C:\Windows`,
      }),
    ).toBe(String.raw`C:\Windows\System32\taskkill.exe`);
    expect(() => resolveWindowsTaskkillPath({ SystemRoot: "relative" })).toThrow("SystemRoot");
  });
});
