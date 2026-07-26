import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPiInvocation, prepareSpawn, resolvePiCommand } from "./command.mjs";

const fakePath = path.resolve(import.meta.dirname, "fixtures/fake pi.mjs");

describe("Gate C Pi command selection", () => {
  it("uses configured argv before PI_COMMAND and the PATH default", () => {
    expect(
      buildPiInvocation({
        configuredCommand: [process.execPath, fakePath],
        env: { PI_COMMAND: "ignored" },
        rpcArgs: ["--session-dir", "space path"],
      }),
    ).toEqual({
      command: process.execPath,
      prefixArgs: [fakePath],
      source: "configured",
      args: [fakePath, "--mode", "rpc", "--session-dir", "space path"],
    });
  });

  it("treats PI_COMMAND as one path instead of a shell command line", () => {
    expect(resolvePiCommand({ env: { PI_COMMAND: "pi --model injected" } })).toEqual({
      command: "pi --model injected",
      prefixArgs: [],
      source: "environment",
    });
  });

  it("uses the PATH command when no override exists", () => {
    expect(resolvePiCommand({ env: {} })).toEqual({
      command: "pi",
      prefixArgs: [],
      source: "path",
    });
  });

  it("wraps Windows command scripts without enabling a general shell", () => {
    const prepared = prepareSpawn(
      { command: String.raw`C:\Program Files\Pi\pi.cmd`, args: ["--mode", "rpc"] },
      { platform: "win32", env: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` } },
    );
    expect(prepared.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(prepared.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(prepared.args.at(-1)).toContain('"C:\\Program Files\\Pi\\pi.cmd"');
    expect(prepared.windowsVerbatimArguments).toBe(true);
  });
});
