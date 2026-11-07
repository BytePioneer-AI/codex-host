import { ChildProcess, spawn } from "node:child_process";
import type * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CodexAppServer } from "../src/rpc.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(spawn).mockReturnValue(
    Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([".cmd", ".bat"])(
  "launches a Windows %s entrypoint through the supplied ComSpec",
  (extension) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const command = `C:\\npm prefix\\codex${extension}`;
    const environment = {
      cOmSpEc: "C:\\Windows\\System32\\cmd.exe",
      CODEX_HOME: "C:\\native home",
    };

    new CodexAppServer({ command, cwd: "C:\\workspace", environment });

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      environment.cOmSpEc,
      ["/d", "/v:off", "/s", "/c", `""${command}" "app-server""`],
      {
        cwd: "C:\\workspace",
        env: environment,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  },
);

it.each(["win32", "darwin"])("spawns native executables directly on %s", (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  new CodexAppServer({ command: "codex.exe" });

  expect(spawn).toHaveBeenCalledExactlyOnceWith("codex.exe", ["app-server"], {
    cwd: undefined,
    env: process.env,
    windowsVerbatimArguments: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
});
