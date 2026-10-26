import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { HarnessInstallationTasks } from "../src/harness-installation-tasks.js";

const state = {
  currentVersion: "1.1.0",
  latestVersion: "1.1.0",
  updateAvailable: false,
  canUpdate: true,
};

describe("Harness installation background tasks", () => {
  it("submits independent updates immediately, merges duplicates, and retains sanitized outcomes on this Host", async () => {
    const first = Promise.withResolvers<typeof state>();
    const second = Promise.withResolvers<typeof state>();
    const pi = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
      installation: vi.fn(() => first.promise),
    });
    const grok = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("grok")), {
      installation: vi.fn(() => second.promise),
    });
    const adapters = new Map([
      ["pi", pi],
      ["grok", grok],
    ]);
    const tasks = new HarnessInstallationTasks();
    const a = tasks.start({ harnessId: "pi", action: "update" }, adapters);
    const b = tasks.start({ harnessId: "grok", action: "update" }, adapters);
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    expect(tasks.start({ harnessId: "pi", action: "update" }, adapters)).toEqual(a);
    expect(pi.installation).toHaveBeenCalledTimes(1);
    expect(grok.installation).toHaveBeenCalledTimes(1);
    expect(() => new HarnessInstallationTasks().status({ taskId: a.taskId })).toThrow(
      "unavailable on this Host",
    );
    expect(() =>
      tasks.start({ harnessId: "pi", action: "update", command: "evil" }, adapters),
    ).toThrow("Invalid");
    expect(() => tasks.status({ taskId: a.taskId, command: "evil" })).toThrow("Invalid");
    second.reject(new Error("private-native-token"));
    await vi.waitFor(() =>
      expect(tasks.status({ taskId: b.taskId })).toMatchObject({
        status: "failed",
        error: { code: -32077 },
      }),
    );
    expect(JSON.stringify(tasks.status({ taskId: b.taskId }))).not.toContain(
      "private-native-token",
    );
    expect(tasks.status({ taskId: a.taskId }).status).toBe("running");
    first.resolve(state);
    await vi.waitFor(() =>
      expect(tasks.status({ taskId: a.taskId })).toEqual({
        taskId: a.taskId,
        status: "succeeded",
        result: state,
      }),
    );
  });

  it("expires completed outcomes without removing an active update", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<typeof state>();
      const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
        installation: vi.fn(() => pending.promise),
      });
      const tasks = new HarnessInstallationTasks();
      const task = tasks.start({ harnessId: "pi", action: "update" }, new Map([["pi", adapter]]));
      vi.advanceTimersByTime(16 * 60_000);
      expect(tasks.status({ taskId: task.taskId }).status).toBe("running");
      pending.resolve(state);
      await vi.waitFor(() =>
        expect(tasks.status({ taskId: task.taskId }).status).toBe("succeeded"),
      );
      vi.advanceTimersByTime(16 * 60_000);
      expect(() => tasks.status({ taskId: task.taskId })).toThrow("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });
});
