import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCodeServerInvocation, resolveOpenCodeExecutable } from "../src/command.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fakeExecutable(): { directory: string; executable: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-opencode-adapter-"));
  directories.push(directory);
  const executable = path.join(
    directory,
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, executable };
}

describe("OpenCode executable resolution", () => {
  it("uses an explicit executable and the native serve entrypoint", () => {
    const { executable } = fakeExecutable();
    const resolved = resolveOpenCodeExecutable({ command: executable, environment: {} });

    expect(resolved).toBe(executable);
    expect(openCodeServerInvocation(resolved, {}, "darwin")).toMatchObject({
      command: executable,
      arguments: ["serve", "--hostname=127.0.0.1", "--port=0"],
    });
  });

  it("resolves OpenCode from PATH", () => {
    const { directory, executable } = fakeExecutable();
    expect(
      resolveOpenCodeExecutable({
        environment: { PATH: directory, PATHEXT: ".exe" },
        platform: process.platform,
      }),
    ).toBe(executable);
  });

  it("finds the documented user install directory outside a Finder-style PATH", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-opencode-home-"));
    directories.push(homeDirectory);
    const executable = path.join(homeDirectory, ".opencode", "bin", "opencode");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(
      resolveOpenCodeExecutable({
        environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        homeDirectory,
        platform: "darwin",
      }),
    ).toBe(executable);
  });

  it("reports an unavailable installation without falling back to the SDK launcher", () => {
    const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-opencode-home-"));
    directories.push(homeDirectory);
    expect(() =>
      resolveOpenCodeExecutable(
        { environment: { PATH: "" }, homeDirectory, platform: "linux" },
        { isExecutable: () => false },
      ),
    ).toThrow("not installed");
  });
});
