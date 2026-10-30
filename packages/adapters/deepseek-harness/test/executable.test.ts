import { spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync, type Stats } from "node:fs";
import type * as filesystem from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deepSeekProcessInvocation,
  killDeepSeekProcessTree,
  resolveDeepSeekCommand,
  resolveWindowsTaskkillPath,
} from "../src/executable.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof filesystem>()),
  accessSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const entries = new Map<string, "file" | "directory">();

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  entries.clear();
  vi.mocked(accessSync).mockImplementation((file) => {
    if (!entries.has(String(file))) throw new Error("ENOENT");
  });
  vi.mocked(statSync).mockImplementation(
    (file) =>
      ({
        isFile: () => entries.get(String(file)) === "file",
      }) as Stats,
  );
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

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

  it("accepts Windows system directory aliases but rejects PATH-only and relative values", () => {
    expect(resolveWindowsTaskkillPath({ systemroot: "D:/Windows" })).toBe(
      String.raw`D:\Windows\System32\taskkill.exe`,
    );
    expect(resolveWindowsTaskkillPath({ WINDIR: String.raw`C:\Windows` })).toBe(
      String.raw`C:\Windows\System32\taskkill.exe`,
    );
    for (const env of [
      {},
      { PATH: "C:\\Windows" },
      { SystemRoot: "C:Windows" },
      { SystemRoot: "\\Windows" },
      { SystemRoot: "" },
    ]) {
      expect(() => resolveWindowsTaskkillPath(env)).toThrow("SystemRoot");
    }
  });

  it("honors explicit executable identity and skips directories on POSIX PATH", () => {
    platform("linux");
    entries.set("/bin/dsh", "file");
    entries.set("./custom/dsh", "file");
    entries.set("relative\\dsh", "file");
    expect(resolveDeepSeekCommand("/missing/dsh", { PATH: "/bin" })).toBeNull();
    expect(resolveDeepSeekCommand("./custom/dsh", { PATH: "/bin" })).toEqual({
      command: "./custom/dsh",
      arguments: [],
      kind: "configured",
    });
    expect(resolveDeepSeekCommand("relative\\dsh", {})).toEqual({
      command: "relative\\dsh",
      arguments: [],
      kind: "configured",
    });
    entries.set("/first/dsh", "directory");
    expect(resolveDeepSeekCommand(undefined, { PATH: '  :"/first": /bin : /last ' })).toEqual({
      command: "/bin/dsh",
      arguments: [],
      kind: "dsh",
    });
    expect(accessSync).toHaveBeenCalledWith("/bin/dsh", constants.X_OK);
  });

  it("uses local offline npx only when dsh is absent", () => {
    platform("linux");
    entries.set("/bin/npx", "file");
    expect(resolveDeepSeekCommand(undefined, { PATH: "/bin" })).toEqual({
      command: "/bin/npx",
      arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
      kind: "npx",
    });
    expect(resolveDeepSeekCommand(undefined, {})).toBeNull();
  });

  it("uses Windows case-insensitive environment names, PATHEXT and quoted PATH entries", () => {
    platform("win32");
    entries.set(String.raw`C:\npm\dsh.CMD`, "file");
    expect(
      resolveDeepSeekCommand(undefined, { Path: ' ; "C:\\npm" ; ', PATHEXT: " .EXE ; ; .CMD " }),
    ).toEqual({ command: String.raw`C:\npm\dsh.CMD`, arguments: [], kind: "dsh" });
    expect(accessSync).toHaveBeenCalledWith(String.raw`C:\npm\dsh.CMD`, constants.F_OK);
    entries.set(String.raw`C:\npm\custom.exe`, "file");
    expect(resolveDeepSeekCommand("custom.exe", { PATH: String.raw`C:\npm` })).toEqual({
      command: String.raw`C:\npm\custom.exe`,
      arguments: [],
      kind: "configured",
    });
    entries.delete(String.raw`C:\npm\dsh.CMD`);
    entries.set(String.raw`C:\npm\npx.cmd`, "file");
    expect(resolveDeepSeekCommand(undefined, { PATH: String.raw`C:\npm` })).toMatchObject({
      command: String.raw`C:\npm\npx.cmd`,
      kind: "npx",
    });
  });

  it("quotes Windows shims and preserves direct native invocations", () => {
    const args = ["web", "a b", "100%", 'a"b'];
    expect(
      deepSeekProcessInvocation("dsh.cmd", args, { COMSPEC: "custom-cmd.exe" }, "win32"),
    ).toEqual({
      command: "custom-cmd.exe",
      windowsVerbatimArguments: true,
      arguments: ["/d", "/v:off", "/s", "/c", '""dsh.cmd" "web" "a b" "100%%" "a""b""'],
    });
    expect(deepSeekProcessInvocation("dsh.bat", [], {}, "win32").command).toBe("cmd.exe");
    expect(deepSeekProcessInvocation("dsh.exe", args, {}, "win32")).toEqual({
      command: "dsh.exe",
      arguments: args,
      windowsVerbatimArguments: false,
    });
    expect(deepSeekProcessInvocation("dsh.cmd", args, {}, "linux")).toEqual({
      command: "dsh.cmd",
      arguments: args,
      windowsVerbatimArguments: false,
    });
    expect(deepSeekProcessInvocation("dsh", [], {}).windowsVerbatimArguments).toBe(false);
  });

  it("never starts taskkill for a child that has no process id", () => {
    const kill = vi.fn();
    for (const state of [
      { exitCode: 0, signalCode: null },
      { exitCode: null, signalCode: "SIGTERM" },
    ]) {
      killDeepSeekProcessTree({ ...state, kill } as unknown as ChildProcess, "win32", 5);
    }
    expect(kill).not.toHaveBeenCalled();
    killDeepSeekProcessTree(
      { exitCode: null, signalCode: null, kill } as unknown as ChildProcess,
      "win32",
      5,
    );
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("targets only the owned POSIX process group and propagates permission failures", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = { pid: 1234 } as ChildProcess;
    killDeepSeekProcessTree(child, "linux", 5);
    expect(kill).toHaveBeenCalledWith(-1234, "SIGKILL");
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(() => killDeepSeekProcessTree(child, "darwin", 5)).not.toThrow();
    for (const error of [
      Object.assign(new Error("permission"), { code: "EPERM" }),
      null,
      "failure",
    ]) {
      kill.mockImplementationOnce(() => {
        throw error;
      });
      expect(() => killDeepSeekProcessTree(child, "linux", 5)).toThrow();
    }
  });

  it("uses bounded hidden taskkill for the owned Windows tree and reports launch failure", () => {
    vi.stubEnv("SystemRoot", String.raw`C:\Windows`);
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    const child = { pid: 1234 } as ChildProcess;
    killDeepSeekProcessTree(child, "win32", 50);
    expect(spawnSync).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\taskkill.exe`,
      ["/pid", "1234", "/t", "/f"],
      { stdio: "ignore", windowsHide: true, timeout: 50 },
    );
    const error = new Error("taskkill could not start");
    vi.mocked(spawnSync).mockReturnValue({ error } as ReturnType<typeof spawnSync>);
    expect(() => killDeepSeekProcessTree(child, "win32", 50)).toThrow(error);
  });
});
