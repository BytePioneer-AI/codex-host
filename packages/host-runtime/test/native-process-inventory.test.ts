import path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { readNativeProcessIds } from "../src/native-process-inventory.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const launcher = path.join(tmpdir(), "synthetic-codexhost-launcher");

beforeEach(() => {
  execFileMock.mockReset();
});

it("queries safe executable basenames sequentially and returns stable unique PIDs", async () => {
  const active = { value: 0, maximum: 0 };
  execFileMock.mockImplementation(
    (_file: string, arguments_: string[], _options: unknown, callback: ExecCallback) => {
      active.value += 1;
      active.maximum = Math.max(active.maximum, active.value);
      const name = arguments_[2];
      queueMicrotask(() => {
        active.value -= 1;
        callback(null, JSON.stringify({ pids: name === "codex" ? [9, 2] : [9, 14] }), "");
      });
      return {};
    },
  );

  await expect(
    readNativeProcessIds({
      launcher,
      executableNames: ["codex", "codex", "codex.exe"],
      environment: { SYNTHETIC: "1" },
    }),
  ).resolves.toEqual([2, 9, 14]);
  expect(active.maximum).toBe(1);
  expect(execFileMock).toHaveBeenCalledTimes(2);
  expect(execFileMock.mock.calls[0]?.[1]).toEqual(["process-inventory", "--name", "codex"]);
  expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
});

it("rejects unsafe names before spawning a helper", async () => {
  await expect(
    readNativeProcessIds({ launcher: "relative-launcher", executableNames: ["codex"] }),
  ).rejects.toThrow("Native process inventory unavailable");
  await expect(readNativeProcessIds({ launcher, executableNames: [] })).rejects.toThrow(
    "Native process inventory unavailable",
  );
  for (const executableName of ["", "../codex", " codex", "codex\n", "x".repeat(257)]) {
    await expect(
      readNativeProcessIds({ launcher, executableNames: [executableName] }),
    ).rejects.toThrow("Native process inventory unavailable");
  }
  expect(execFileMock).not.toHaveBeenCalled();
});

it("rejects malformed and invalid helper results without exposing output", async () => {
  for (const output of [
    "synthetic-secret",
    JSON.stringify({ pids: [0] }),
    JSON.stringify({ pids: [1.5] }),
    JSON.stringify({ pids: [1], token: "synthetic-secret" }),
  ]) {
    execFileMock.mockImplementationOnce(
      (_file: string, _arguments: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, output, "");
        return {};
      },
    );
    await expect(readNativeProcessIds({ launcher, executableNames: ["codex"] })).rejects.toThrow(
      /^Native process inventory unavailable$/u,
    );
  }
});

it("rejects helper output and PID aggregation overflow", async () => {
  execFileMock.mockImplementationOnce(
    (_file: string, _arguments: string[], _options: unknown, callback: ExecCallback) => {
      callback(new Error("stdout maxBuffer synthetic-secret"), "x".repeat(1024), "");
      return {};
    },
  );
  await expect(readNativeProcessIds({ launcher, executableNames: ["codex"] })).rejects.toThrow(
    /^Native process inventory unavailable$/u,
  );

  const first = Array.from({ length: 6000 }, (_, index) => index + 1);
  const second = Array.from({ length: 6000 }, (_, index) => index + 6001);
  execFileMock
    .mockImplementationOnce(
      (_file: string, _arguments: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, JSON.stringify({ pids: first }), "");
        return {};
      },
    )
    .mockImplementationOnce(
      (_file: string, _arguments: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, JSON.stringify({ pids: second }), "");
        return {};
      },
    );
  await expect(
    readNativeProcessIds({ launcher, executableNames: ["codex", "codex.exe"] }),
  ).rejects.toThrow("Native process inventory unavailable");
});

it("sets a bounded deadline and redacts timeout diagnostics", async () => {
  execFileMock.mockImplementation(
    (
      _file: string,
      _arguments: string[],
      options: { timeout?: number },
      callback: ExecCallback,
    ) => {
      expect(options.timeout).toBe(3000);
      const error = new Error("synthetic-secret timed out");
      callback(error, "", "synthetic-secret");
      return {};
    },
  );
  await expect(readNativeProcessIds({ launcher, executableNames: ["codex"] })).rejects.toThrow(
    /^Native process inventory unavailable$/u,
  );
});
