import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostRestartMode, readRunningHost, shouldRestartHost } from "./host-restart.mjs";

describe("shared development Host decision", () => {
  it.each([
    [false, true, true, undefined, false],
    [false, true, true, "restart", false],
    [true, false, true, undefined, false],
    [true, true, false, undefined, true],
    [true, true, true, "restart", true],
    [true, false, true, "restart", true],
    [true, true, false, "keep", false],
  ])(
    "running=%s changed=%s other=%s mode=%s => %s",
    async (running, changed, other, mode, expected) => {
      const ask = vi.fn();
      const otherInterfaceRunning = vi.fn(async () => other);
      expect(
        await shouldRestartHost({
          running,
          changed,
          mode,
          otherInterfaceRunning,
          otherInterface: "other",
          interactive: true,
          ask,
          log: vi.fn(),
        }),
      ).toBe(expected);
      expect(ask).not.toHaveBeenCalled();
      if (!running || !changed || mode) expect(otherInterfaceRunning).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["", false],
    ["keep", false],
    ["restart", true],
    [" RESTART ", true],
    ["invalid", false],
  ])(
    "accepts only an explicit restart, not Enter or invalid input (%s)",
    async (answer, expected) => {
      const ask = vi.fn(async () => answer);
      const log = vi.fn();
      expect(
        await shouldRestartHost({
          running: true,
          changed: true,
          otherInterface: "Web",
          otherInterfaceRunning: async () => true,
          interactive: true,
          ask,
          log,
        }),
      ).toBe(expected);
      expect(ask).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledTimes(expected ? 0 : 1);
      if (!expected) expect(log.mock.calls[0][0]).toContain("old Host");
    },
  );

  it("keeps a changed Host and warns in non-interactive mode when the other interface is open", async () => {
    const ask = vi.fn();
    const warn = vi.fn();
    const log = vi.fn();
    expect(
      await shouldRestartHost({
        running: true,
        changed: true,
        otherInterface: "Web",
        otherInterfaceRunning: async () => true,
        interactive: false,
        ask,
        warn,
        log,
      }),
    ).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("--restart-host"));
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("old Host"));
  });

  it("validates mutually exclusive flags", () => {
    expect(hostRestartMode({})).toBeUndefined();
    expect(hostRestartMode({ "restart-host": true })).toBe("restart");
    expect(hostRestartMode({ "keep-host": true })).toBe("keep");
    expect(() => hostRestartMode({ "restart-host": true, "keep-host": true })).toThrow(
      "mutually exclusive",
    );
  });

  it("requires a live pid, tolerates stale/invalid records, and treats EPERM as alive", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "codexhost-owner-"));
    const file = path.join(data, "shared-host-ready.json");
    try {
      expect(await readRunningHost(data)).toBeNull();
      for (const text of ["{", "null", "{}", '{"pid":0}', '{"pid":"123"}']) {
        await writeFile(file, text);
        expect(await readRunningHost(data)).toBeNull();
      }
      await writeFile(file, JSON.stringify({ pid: process.pid, runtime: "/host" }));
      expect(await readRunningHost(data)).toEqual({ runtime: "/host" });
      expect(
        await readRunningHost(data, () => {
          throw Object.assign(new Error(), { code: "ESRCH" });
        }),
      ).toBeNull();
      expect(
        await readRunningHost(data, () => {
          throw Object.assign(new Error(), { code: "EPERM" });
        }),
      ).toEqual({ runtime: "/host" });
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });
});
