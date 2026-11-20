import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withRemoteAppServerSocketInitializationLock } from "../src/remote-socket-lock.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const originalPlatform = process.platform;
let directory: string;
let resource: string;

beforeEach(async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  directory = await mkdtemp(path.join(os.tmpdir(), "socket-lock-"));
  resource = path.join(directory, "resource");
  Object.defineProperty(process, "platform", { value: "win32" });
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.mocked(rename).mockClear();
  await rm(directory, { recursive: true, force: true });
});

it("retries a Windows sharing violation without removing the published register", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  vi.mocked(rename)
    .mockImplementationOnce(actual.rename)
    .mockImplementationOnce(async (_source, destination) => {
      expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({ choosing: true });
      throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" });
    });

  const action = vi.fn(async () => "accepted");
  await expect(withRemoteAppServerSocketInitializationLock(resource, action)).resolves.toBe(
    "accepted",
  );
  expect(action).toHaveBeenCalledTimes(1);
  expect(rename).toHaveBeenCalledTimes(3);
  expect(vi.mocked(rename).mock.calls[1]).toEqual(vi.mocked(rename).mock.calls[2]);
  expect(await readdir(`${resource}.initializers`)).toEqual([]);
});

it.each([
  { code: "EACCES", attempts: 7 },
  { code: "EIO", attempts: 2 },
])(
  "bounds retries for $code and never runs the action after a failed publication",
  async ({ code, attempts }) => {
    const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
    vi.mocked(rename)
      .mockImplementationOnce(actual.rename)
      .mockRejectedValue(Object.assign(new Error("Publication failed"), { code }));
    const action = vi.fn(async () => undefined);

    await expect(withRemoteAppServerSocketInitializationLock(resource, action)).rejects.toThrow(
      "Publication failed",
    );
    expect(action).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(attempts);
    expect(await readdir(`${resource}.initializers`)).toEqual([]);
  },
);
