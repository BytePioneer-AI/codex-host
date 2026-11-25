import { describe, expect, it } from "vitest";

import { resolveOmpExecutable } from "../src/command.js";

describe("OMP executable discovery", () => {
  it("finds the default Windows installation without PATH inheritance", () => {
    const executable = String.raw`C:\Users\u\AppData\Local\omp\omp.exe`;

    expect(
      resolveOmpExecutable(
        {
          environment: {
            PATH: "",
            LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`,
          },
        },
        {
          platform: "win32",
          homeDirectory: String.raw`C:\Users\u`,
          isExecutable: (candidate) => candidate === executable,
        },
      ),
    ).toBe(executable);
  });
});
