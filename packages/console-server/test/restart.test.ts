import { describe, expect, it, vi } from "vitest";
import { ConsoleRestart, type RestartObservation } from "../src/restart.js";
const previous: RestartObservation = {
  launcherPid: 1,
  controllerPid: 2,
  installed: true,
  failure: null,
};

describe("managed console restart", () => {
  it("does not report success for attach, old status or a new controller still installing", async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce({ ...previous, launcherPid: 3 })
      .mockResolvedValueOnce({ ...previous, launcherPid: 3, controllerPid: 4, installed: false })
      .mockResolvedValue({ ...previous, launcherPid: 3, controllerPid: 4 });
    const sleep = vi.fn(async () => {});
    const restart = new ConsoleRestart(async () => {}, observe, sleep);
    restart.start(previous);
    expect(() => restart.start(previous)).toThrow("already");
    await vi.waitFor(() => expect(restart.status.phase).toBe("succeeded"));
    expect(observe).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
  it("reports spawn, startup and timeout failures and permits retry", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue(undefined);
    const restart = new ConsoleRestart(run, async () => ({
      ...previous,
      failure: "startup failed",
    }));
    restart.start(previous);
    await vi.waitFor(() =>
      expect(restart.status).toEqual({ phase: "failed", error: "spawn failed" }),
    );
    restart.start(previous);
    await vi.waitFor(() =>
      expect(restart.status).toEqual({ phase: "failed", error: "startup failed" }),
    );
    let time = 0;
    const timeout = new ConsoleRestart(
      async () => {},
      async () => previous,
      async () => {
        time += 250;
      },
      () => time,
      500,
    );
    timeout.start(previous);
    await vi.waitFor(() => expect(timeout.status.error).toContain("timed out"));
  });
});
