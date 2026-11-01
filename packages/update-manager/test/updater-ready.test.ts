import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { waitForUpdaterReady } from "../src/updater-ready.js";
import type { BackgroundUpdateStatus } from "../src/status.js";

function fixture() {
  const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() });
  const status: BackgroundUpdateStatus = {
    schemaVersion: 1,
    version: "1.0.0",
    installation: "npm",
    phase: "prepared",
    updatedAt: 1,
  };
  return {
    child,
    status,
    wait: (timeout = 1000) =>
      waitForUpdaterReady(child as unknown as ChildProcess, async () => status, timeout),
  };
}

describe("Updater handoff", () => {
  it("does not accept a PID as readiness", async () => {
    const { child, status, wait } = fixture();
    let ready = false;
    const pending = wait().then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ready).toBe(false);
    status.phase = "waiting-for-exit";
    await pending;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["error", "exit"])("rejects early %s", async (event) => {
    const { child, wait } = fixture();
    const pending = wait();
    child.emit(event, new Error("spawn failed"));
    await expect(pending).rejects.toThrow(event === "error" ? "spawn failed" : "exited");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("reports the native failure", async () => {
    const { status, wait } = fixture();
    status.phase = "failed";
    status.error = "wrong owner";
    await expect(wait()).rejects.toThrow("wrong owner");
  });

  it("terminates a helper that never acknowledges readiness", async () => {
    const { child, wait } = fixture();
    await expect(wait(25)).rejects.toThrow("startup timeout");
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
