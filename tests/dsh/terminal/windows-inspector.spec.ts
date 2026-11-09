import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { WindowsProcessInspector } from "@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each(["SystemRoot", "windir"])("resolves taskkill from %s without PATH", (key) => {
  vi.stubEnv("PATH", "C:\\test-fixtures");
  vi.stubEnv("SystemRoot", undefined);
  vi.stubEnv("windir", undefined);
  vi.stubEnv(key, "D:\\Windows");
  const inspector = new WindowsProcessInspector();
  inspector.signalGroup(4242, "SIGTERM");
  inspector.signalGroup(4242, "SIGKILL");
  expect(spawnSync).toHaveBeenNthCalledWith(
    1,
    "D:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4242", "/T"],
    { stdio: "ignore", windowsHide: true },
  );
  expect(spawnSync).toHaveBeenNthCalledWith(
    2,
    "D:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4242", "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  );
});

it.each([undefined, "relative"])("rejects an unavailable or invalid system root: %s", (root) => {
  vi.stubEnv("SystemRoot", root);
  vi.stubEnv("windir", undefined);
  expect(() => new WindowsProcessInspector().signalGroup(4242, "SIGKILL")).toThrow(
    "Windows SystemRoot is unavailable or invalid",
  );
  expect(spawnSync).not.toHaveBeenCalled();
});

it("reports taskkill launch failure", () => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const error = Object.assign(new Error("taskkill could not start"), { code: "ENOENT" });
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: null,
    error,
  });
  expect(() => new WindowsProcessInspector().signalGroup(4242, "SIGKILL")).toThrow(error);
});
