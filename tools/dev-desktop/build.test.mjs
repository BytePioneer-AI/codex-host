import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { runQuietWebBuild } from "./build.mjs";

function run(script) {
  return runQuietWebBuild(
    { command: process.execPath, arguments: ["-e", script] },
    { root: process.cwd(), environment: process.env, outputStream: { isTTY: false } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("hides successful build stdout and stderr, showing only progress and elapsed time", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const result = await run("console.log('dependency output'); console.error('build warning')");
  expect(result.code).toBe(0);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenNthCalledWith(1, "codexhost web: building…");
  expect(log.mock.calls[1][0]).toMatch(/^codexhost web: build complete \(\d+\.\d{2}s\)\n$/u);
  expect(error).not.toHaveBeenCalled();
});

it("updates one terminal line with real plugin counts, build stages and elapsed time", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const write = vi.fn();
  const result = runQuietWebBuild(
    { command: "fixture", arguments: [] },
    {
      root: "/fixture",
      environment: {},
      spawnImplementation: () => child,
      outputStream: { isTTY: true, write },
    },
  );
  child.stdout.emit("data", "> codexhost@0.13.2 build:typescript\n");
  expect(write.mock.lastCall[0]).toContain("building… TypeScript");
  child.stdout.emit("data", "codexhost web: client plu");
  child.stdout.emit("data", "gins 12/36\n");
  expect(write.mock.lastCall[0]).toContain("Web UI plugins 12/36");
  const previousWrites = write.mock.calls.length;
  await vi.advanceTimersByTimeAsync(400);
  expect(write.mock.calls.length).toBeGreaterThan(previousWrites);
  child.stdout.emit("data", "codexhost web: building browser shell\n");
  expect(write.mock.lastCall[0]).toContain("Browser shell");
  child.stdout.emit("data", "> @codexhost/web-server@0.0.0 pack\n");
  expect(write.mock.lastCall[0]).toContain("Packaging");
  child.emit("close", 0, null);
  expect((await result).code).toBe(0);
  expect(write.mock.lastCall[0]).toBe("\r\x1b[2K");
  expect(vi.getTimerCount()).toBe(0);
});

it("clears terminal progress and timers when the build cannot be spawned", async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  const write = vi.fn();
  const result = runQuietWebBuild(
    { command: "missing", arguments: [] },
    {
      root: "/fixture",
      environment: {},
      spawnImplementation: () => child,
      outputStream: { isTTY: true, write },
    },
  );
  const rejected = expect(result).rejects.toThrow("spawn failed");
  child.emit("error", new Error("spawn failed"));
  await rejected;
  expect(write.mock.lastCall[0]).toBe("\r\x1b[2K");
  expect(vi.getTimerCount()).toBe(0);
});

it("prints bounded diagnostics on failure, retaining final pipe output", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const result = await run(
    "process.stderr.write('old-output' + 'x'.repeat(70000) + 'final build error', () => { process.exitCode = 7; });",
  );
  expect(result.code).toBe(7);
  expect(error.mock.calls[0][0]).toContain("build failed (status 7,");
  expect(error.mock.calls[1][0]).toHaveLength(64_000);
  expect(error.mock.calls[1][0]).not.toContain("old-output");
  expect(error.mock.calls[1][0]).toContain("final build error");
  expect(error.mock.calls[2][0]).toContain("npm run build:web");
});
