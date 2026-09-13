import path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
import { stopNativeProcesses } from "../src/native-process-stop.js";
const launcher = path.join(tmpdir(), "synthetic-launcher");
type Callback = (error: Error | null, stdout: string) => void;
beforeEach(() => {
  execFileMock.mockReset();
});
it("uses one bounded native operation, not a respawn-killing loop", async () => {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: unknown, cb: Callback) => cb(null, '{"stopped":2}'),
  );
  await stopNativeProcesses({ launcher, executableNames: ["codex", "codex", "codex.exe"] });
  expect(execFileMock).toHaveBeenCalledOnce();
  expect(execFileMock.mock.calls[0]?.[1]).toEqual([
    "process-stop",
    "--name",
    "codex",
    "--name",
    "codex.exe",
  ]);
  expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 30_000, maxBuffer: 4096 });
});
it("rejects unsafe requests before spawning", async () => {
  for (const names of [[], ["../codex"], ["codex\n"], Array(9).fill("codex")]) {
    await expect(stopNativeProcesses({ launcher, executableNames: names })).rejects.toThrow(
      "Native process stop could not be confirmed",
    );
  }
  expect(execFileMock).not.toHaveBeenCalled();
});
it.each(["secret", '{"stopped":-1}', '{"stopped":1,"secret":"hidden"}'])(
  "rejects malformed output",
  async (output) => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, cb: Callback) => cb(null, output),
    );
    await expect(stopNativeProcesses({ launcher, executableNames: ["codex"] })).rejects.toThrow(
      /^Native process stop could not be confirmed$/,
    );
  },
);
it("does not expose errors or accept timeout as exit evidence", async () => {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _options: unknown, cb: Callback) =>
      cb(new Error("secret timeout"), '{"stopped":1}'),
  );
  await expect(stopNativeProcesses({ launcher, executableNames: ["codex"] })).rejects.toThrow(
    /^Native process stop could not be confirmed$/,
  );
});
