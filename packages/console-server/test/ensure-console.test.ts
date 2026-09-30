import type * as childProcess from "node:child_process";
import type * as fsPromises from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, statMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  statMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: spawnMock,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fsPromises>()),
  stat: statMock,
}));

import { ensureConsole } from "../src/open.js";

const port = 42_123;
const appDirectory = path.resolve("console-target");
const entryPath = path.join(appDirectory, "console-server.mjs");
const options = {
  appDirectory,
  entryPath,
  environment: { CODEXHOST_CONSOLE_PORT: String(port) },
};
const metadata = { mtimeMs: 2_000, size: 64 };
const target = { appDirectory, buildId: "2000-64", pid: 200 };
const old = { appDirectory: path.resolve("console-previous"), buildId: "old", pid: 100 };

type Instance = { appDirectory: string; buildId: string | null; pid: number };
let instance: Instance | null;
const fetchMock = vi.fn<typeof fetch>();
const shutdownMock = vi.fn<(identity: Instance) => Promise<Response>>();

async function ensureResult() {
  const result = ensureConsole(options).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  await vi.runAllTimersAsync();
  return await result;
}

beforeEach(() => {
  vi.useFakeTimers();
  instance = null;
  statMock.mockReset().mockImplementation(async (file: string) => {
    if (file === entryPath) return metadata;
    throw Object.assign(new Error("missing bundle"), { code: "ENOENT" });
  });
  spawnMock.mockReset().mockReturnValue({ unref: vi.fn() });
  shutdownMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const request = new URL(String(input));
    expect(request.origin).toBe(`http://127.0.0.1:${port}`);
    if (request.pathname === "/api/shutdown") {
      return await shutdownMock(JSON.parse(String(init?.body)) as Instance);
    }
    expect(request.pathname).toBe("/api/health");
    if (instance) return Response.json({ service: "codexhost-console", ...instance });
    throw Object.assign(new Error("mock port is free"), { code: "ECONNREFUSED" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ensureConsole installation identity", () => {
  it("reuses only the matching installation and build", async () => {
    instance = target;
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("normalizes directory segments before reusing the same installation", async () => {
    instance = { ...target, appDirectory: `${appDirectory}${path.sep}child${path.sep}..` };
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")(
    "reuses a Windows installation with different path case and separators",
    async () => {
      instance = { ...target, appDirectory: appDirectory.toUpperCase().replaceAll("\\", "/") };
      expect(await ensureResult()).toEqual({ value: { port }, error: null });
      expect(shutdownMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps differently cased Unix directories distinct",
    async () => {
      instance = { ...target, appDirectory: appDirectory.toUpperCase() };
      const result = await ensureResult();
      expect(result.value).toBeNull();
      expect(result.error).toBeInstanceOf(Error);
      expect(shutdownMock).toHaveBeenCalledExactlyOnceWith(instance);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an old instance when its shutdown request fails", async () => {
    instance = old;
    shutdownMock.mockRejectedValue(new Error("shutdown unavailable"));
    const startedAt = Date.now();
    const result = await ensureResult();
    expect(result.value).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(5_150);
    expect(shutdownMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects an old build that acknowledges shutdown but never exits", async () => {
    instance = { ...target, buildId: "previous-build" };
    const result = await ensureResult();
    expect(result.value).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(shutdownMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ["another installation", old],
    ["another build", { ...target, buildId: "unexpected-build" }],
    ["an unknown build", { ...target, buildId: null }],
  ] as const)("rejects %s responding after a cold start", async (_label, unexpected) => {
    spawnMock.mockImplementation(() => {
      instance = unexpected;
      return { unref: vi.fn() };
    });
    const startedAt = Date.now();
    const result = await ensureResult();
    expect(result.value).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(10_150);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it("waits for the requested identity when another console initially responds after spawn", async () => {
    spawnMock.mockImplementation(() => {
      instance = old;
      return { unref: vi.fn() };
    });
    const settled = vi.fn();
    const result = ensureConsole(options).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();

    instance = target;
    await vi.runAllTimersAsync();
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ port });
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it("accepts a matching concurrent replacement during shutdown", async () => {
    instance = old;
    shutdownMock.mockImplementation(async () => {
      instance = target;
      return new Response(null, { status: 204 });
    });
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("preserves a matching replacement that rejects the old instance shutdown identity", async () => {
    instance = old;
    shutdownMock.mockImplementation(async (identity) => {
      // The old port owner was replaced after the final probe, before POST arrived.
      instance = target;
      expect(identity).toEqual(old);
      return new Response(null, { status: 409 });
    });
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).toHaveBeenCalledExactlyOnceWith(old);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(instance).toBe(target);
  });

  it("accepts a matching replacement even when the old shutdown request fails", async () => {
    instance = old;
    shutdownMock.mockImplementation(async () => {
      instance = target;
      throw new Error("old instance already exited");
    });
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not shut down a matching instance that appears while reading the build", async () => {
    instance = old;
    statMock.mockImplementationOnce(async () => {
      instance = target;
      return metadata;
    });
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("starts the requested installation after the old instance exits", async () => {
    instance = old;
    shutdownMock.mockImplementation(async () => {
      instance = null;
      return new Response(null, { status: 204 });
    });
    spawnMock.mockImplementation(() => {
      instance = target;
      return { unref: vi.fn() };
    });
    expect(await ensureResult()).toEqual({ value: { port }, error: null });
    expect(shutdownMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, [entryPath, "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: options.environment,
    });
  });
});
