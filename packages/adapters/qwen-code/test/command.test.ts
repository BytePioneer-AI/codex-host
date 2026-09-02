import { describe, expect, it } from "vitest";

import { resolveQwenCodeExecutable } from "../src/command.js";

describe("Qwen Code executable resolution", () => {
  it("resolves a Windows npm shim to the SDK-compatible JavaScript entrypoint", () => {
    const appData = String.raw`C:\Users\test\AppData\Roaming`;
    const shim = String.raw`C:\Users\test\AppData\Roaming\npm\qwen.cmd`;
    const entrypoint = String.raw`C:\Users\test\AppData\Roaming\npm\node_modules\@qwen-code\qwen-code\cli-entry.js`;

    expect(
      resolveQwenCodeExecutable(
        {
          environment: {
            APPDATA: appData,
            PATH: String.raw`C:\Users\test\AppData\Roaming\npm`,
            PATHEXT: ".CMD",
          },
          homeDirectory: String.raw`C:\Users\test`,
          platform: "win32",
        },
        { isExecutable: (candidate) => candidate === shim || candidate === entrypoint },
      ),
    ).toBe(entrypoint);
  });

  it("rejects a Windows npm shim when its Qwen JavaScript entrypoint is absent", () => {
    const shim = String.raw`C:\tools\qwen.cmd`;

    expect(() =>
      resolveQwenCodeExecutable(
        { command: shim, environment: {}, platform: "win32" },
        { isExecutable: (candidate) => candidate === shim },
      ),
    ).toThrow("not installed");
  });
});
