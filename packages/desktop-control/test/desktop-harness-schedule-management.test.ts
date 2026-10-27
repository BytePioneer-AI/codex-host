import { describe, expect, it, vi } from "vitest";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  parseHarnessScheduleTime,
  type ThreadOwnership,
} from "@codexhost/shared-contracts";
import { createDesktopScheduleManagement } from "../src/desktop-harness-schedule-management.js";

const threadId = hostThreadIdSchema.parse("ffb4571e-d945-4f3e-8ce4-1db511796001");
const otherThread = hostThreadIdSchema.parse("ffb4571e-d945-4f3e-8ce4-1db511796002");
const target = { id: "existing-task", targetThreadId: threadId };
const daily = "FREQ=DAILY;BYHOUR=9;BYMINUTE=15;BYSECOND=0";
const complex =
  "DTSTART;TZID=Asia/Shanghai:20261027T091500\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2";
const native = () => ({
  ...target,
  kind: "heartbeat",
  name: "Existing",
  prompt: "original body",
  status: "ACTIVE",
  rrule: daily,
  notificationPolicy: "always",
  model: null,
  reasoningEffort: null,
  createdAt: 1,
});
function fixture() {
  let rows: Record<string, unknown>[] = [native()];
  const services = {
    assertAvailable: vi.fn(),
    listAutomations: vi.fn(async (): Promise<unknown> => ({ items: structuredClone(rows) })),
    readOwnership: vi.fn(async (id: string): Promise<ThreadOwnership> => ({
      owner: "external",
      threadId: hostThreadIdSchema.parse(id),
      harnessId: harnessIdSchema.parse("pi"),
    })),
    updateAutomation: vi.fn(async (params: Record<string, unknown>): Promise<unknown> => {
      const index = rows.findIndex((row) => row.id === params.id);
      rows[index] = { ...rows[index], ...params };
      return { item: structuredClone(rows[index]) };
    }),
    deleteAutomation: vi.fn(async (id: string): Promise<unknown> => {
      rows = rows.filter((row) => row.id !== id);
      return { success: true, status: "deleted" };
    }),
    refreshList: vi.fn(async () => {}),
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    deleteDirectory: vi.fn(),
    stopTurn: vi.fn(),
  };
  return {
    services,
    api: createDesktopScheduleManagement(services),
    signal: new AbortController().signal,
    read: () => rows,
    replace: (next: typeof rows) => {
      rows = next;
    },
  };
}

describe("native local heartbeat management", () => {
  it("rejects edits to binding fields and an inconsistent external Codex ownership result", async () => {
    const f = fixture();
    const edit = {
      name: "changed",
      targetThreadId: otherThread,
      cwd: "/different",
      model: "other",
    };
    expect((await f.api.update(target, edit, f.signal)).outcome).toBe("failed");
    f.services.readOwnership.mockResolvedValue({
      owner: "external",
      threadId,
      harnessId: harnessIdSchema.parse("codex"),
    });
    expect((await f.api.delete(target, f.signal)).outcome).toBe("failed");
    expect(f.services.updateAutomation).not.toHaveBeenCalled();
    expect(f.services.deleteAutomation).not.toHaveBeenCalled();
  });
  it("does not offer ambiguous duplicate ids for management", async () => {
    const f = fixture();
    f.replace([native(), native()]);
    expect(await f.api.list(f.signal)).toEqual({ items: [], unresolved: 2 });
  });
  it("does not use a read started before a lost write acknowledgement to unlock another write", async () => {
    const f = fixture();
    const older = Promise.withResolvers<unknown>();
    f.services.listAutomations.mockReturnValueOnce(older.promise);
    const read = f.api.list(f.signal);
    f.services.deleteAutomation.mockRejectedValueOnce(new Error("lost acknowledgement"));
    expect((await f.api.delete(target, f.signal)).outcome).toBe("unknown");
    older.resolve({ items: [native()] });
    await read;
    expect((await f.api.delete(target, f.signal)).outcome).toBe("unknown");
    expect(f.services.deleteAutomation).toHaveBeenCalledOnce();
  });
  it("reads the native store again on reentry and excludes cron, remote and cloud tasks", async () => {
    const f = fixture();
    f.replace([
      native(),
      { ...native(), id: "codex", targetThreadId: otherThread },
      { ...native(), id: "cron", kind: "cron" },
      { ...native(), id: "cloud", executor: "cloud" },
      { ...native(), id: "remote", hostId: "ssh:test" },
    ]);
    f.services.readOwnership.mockImplementation(async (id) =>
      id === otherThread
        ? { owner: "codex", threadId: otherThread }
        : { owner: "external", threadId, harnessId: harnessIdSchema.parse("pi") },
    );
    expect(await f.api.list(f.signal)).toMatchObject({
      items: [
        { id: target.id, harnessId: "pi" },
        { id: "codex", harnessId: "codex" },
      ],
      unresolved: 0,
    });
    f.replace([{ ...native(), name: "Edited in official list" }]);
    const reopened = createDesktopScheduleManagement(f.services);
    expect((await reopened.list(f.signal)).items[0]?.name).toBe("Edited in official list");
    expect(f.services.updateAutomation).not.toHaveBeenCalled();
  });
  it("manages an explicitly Codex-owned local heartbeat through the same native store", async () => {
    const f = fixture();
    const codexTarget = { id: "codex-task", targetThreadId: otherThread };
    f.replace([{ ...native(), ...codexTarget, model: null }]);
    f.services.readOwnership.mockResolvedValue({ owner: "codex", threadId: otherThread });
    expect(await f.api.list(f.signal)).toMatchObject({
      items: [{ ...codexTarget, harnessId: "codex" }],
      unresolved: 0,
    });
    expect((await f.api.update(codexTarget, { prompt: "Codex body" }, f.signal)).outcome).toBe(
      "saved",
    );
    expect(f.read()[0]).toMatchObject({
      ...codexTarget,
      prompt: "Codex body",
      targetThreadId: otherThread,
      model: null,
      notificationPolicy: "always",
    });
    expect((await f.api.setStatus(codexTarget, "PAUSED", f.signal)).outcome).toBe("saved");
    expect((await f.api.setStatus(codexTarget, "ACTIVE", f.signal)).outcome).toBe("saved");
    expect((await f.api.delete(codexTarget, f.signal)).outcome).toBe("saved");
    expect(f.services.updateAutomation).toHaveBeenCalledTimes(3);
    expect(f.services.deleteAutomation).toHaveBeenCalledExactlyOnceWith(codexTarget.id);
    expect(f.services.createThread).not.toHaveBeenCalled();
    expect(f.services.deleteThread).not.toHaveBeenCalled();
    expect(f.services.deleteDirectory).not.toHaveBeenCalled();
    expect(f.services.stopTurn).not.toHaveBeenCalled();
  });
  it("keeps confirmed rows visible on partial ownership failures and does not turn a read failure into empty", async () => {
    const f = fixture();
    f.replace([native(), { ...native(), id: "unreadable", targetThreadId: otherThread }]);
    f.services.readOwnership.mockRejectedValueOnce(new Error("metadata unavailable"));
    const result = await f.api.list(f.signal);
    expect(result.unresolved).toBe(1);
    expect(result.items).toHaveLength(1);
    f.services.listAutomations.mockRejectedValueOnce(new Error("disconnected"));
    await expect(f.api.list(f.signal)).rejects.toThrow("disconnected");
    f.services.listAutomations.mockResolvedValueOnce({});
    await expect(f.api.list(f.signal)).rejects.toThrow("could not be read");
  });
  it("leaves an ownership response for a different Thread unresolved and blocks writes", async () => {
    const f = fixture();
    f.services.readOwnership.mockResolvedValue({
      owner: "codex",
      threadId: otherThread,
    });
    expect(await f.api.list(f.signal)).toEqual({ items: [], unresolved: 1 });
    expect((await f.api.update(target, { name: "changed" }, f.signal)).outcome).toBe("failed");
    expect(f.services.updateAutomation).not.toHaveBeenCalled();
  });
  it.each(["cron", "cloud", "changed-target", "missing", "ambiguous", "ownership-error"])(
    "blocks all writes for %s",
    async (kind) => {
      const f = fixture();
      if (kind === "codex")
        f.services.readOwnership.mockResolvedValue({ owner: "codex", threadId });
      if (kind === "cron") f.replace([{ ...native(), kind: "cron" }]);
      if (kind === "cloud") f.replace([{ ...native(), executor: "cloud" }]);
      if (kind === "changed-target") f.replace([{ ...native(), targetThreadId: otherThread }]);
      if (kind === "missing") f.replace([]);
      if (kind === "ambiguous") f.replace([native(), native()]);
      if (kind === "ownership-error")
        f.services.readOwnership.mockRejectedValue(new Error("unavailable"));
      expect((await f.api.update(target, { name: "changed" }, f.signal)).outcome).toBe("failed");
      expect((await f.api.setStatus(target, "PAUSED", f.signal)).outcome).toBe("failed");
      expect((await f.api.delete(target, f.signal)).outcome).toBe("failed");
      expect(f.services.updateAutomation).not.toHaveBeenCalled();
      expect(f.services.deleteAutomation).not.toHaveBeenCalled();
    },
  );
  it("updates the original id, preserves latest untouched fields and leaves Model on the Thread", async () => {
    const f = fixture();
    await f.api.list(f.signal);
    f.replace([
      { ...native(), notificationPolicy: "never", prompt: "new native body", rrule: complex },
    ]);
    expect((await f.api.update(target, { name: "changed" }, f.signal)).outcome).toBe("saved");
    expect(f.services.updateAutomation).toHaveBeenCalledExactlyOnceWith({
      id: target.id,
      kind: "heartbeat",
      name: "changed",
      prompt: "new native body",
      status: "ACTIVE",
      targetThreadId: threadId,
      rrule: complex,
      model: null,
      reasoningEffort: null,
      notificationPolicy: "never",
    });
    expect(f.read()[0]?.name).toBe("changed"); // The official list reads this same native store.
    expect(f.services.createThread).not.toHaveBeenCalled();
    expect((await f.api.list(f.signal)).items[0]?.rrule).toBe(complex);
  });
  it("changes basic time only when requested and refuses to replace an unsupported current RRULE", async () => {
    const f = fixture();
    const schedule = { frequency: "weekly" as const, hour: 16, minute: 30, weekday: 5 };
    expect((await f.api.update(target, { prompt: "updated", schedule }, f.signal)).outcome).toBe(
      "saved",
    );
    expect(f.read()[0]).toMatchObject({
      prompt: "updated",
      rrule: "FREQ=WEEKLY;BYHOUR=16;BYMINUTE=30;BYSECOND=0;BYDAY=FR",
    });
    f.replace([{ ...native(), rrule: complex }]);
    expect((await f.api.update(target, { schedule }, f.signal)).outcome).toBe("failed");
    expect(f.services.updateAutomation).toHaveBeenCalledOnce();
  });
  it("pauses/resumes the same schedule and deletes only the schedule", async () => {
    const f = fixture();
    f.replace([{ ...native(), rrule: complex }]);
    for (const status of ["PAUSED", "ACTIVE"] as const) {
      expect((await f.api.setStatus(target, status, f.signal)).outcome).toBe("saved");
      expect(f.read()[0]).toMatchObject({ status, rrule: complex, notificationPolicy: "always" });
    }
    expect((await f.api.delete(target, f.signal)).outcome).toBe("saved");
    expect(f.services.deleteAutomation).toHaveBeenCalledExactlyOnceWith(target.id);
    expect((await f.api.list(f.signal)).items).toEqual([]);
    for (const method of [
      f.services.createThread,
      f.services.deleteThread,
      f.services.deleteDirectory,
      f.services.stopTurn,
    ])
      expect(method).not.toHaveBeenCalled();
  });
  it.each(["update", "delete"] as const)(
    "does not replay uncertain %s, including numeric RPC errors",
    async (method) => {
      const f = fixture();
      const call = () =>
        method === "update"
          ? f.api.update(target, { name: "changed" }, f.signal)
          : f.api.delete(target, f.signal);
      const write = method === "update" ? f.services.updateAutomation : f.services.deleteAutomation;
      write.mockRejectedValueOnce(
        Object.assign(new Error("internal failure after commit"), { jsonRpcCode: -32603 }),
      );
      expect(await call()).toMatchObject({ outcome: "unknown", retryable: false });
      expect((await call()).outcome).toBe("unknown");
      expect(write).toHaveBeenCalledOnce();
      f.services.readOwnership.mockRejectedValueOnce(new Error("cannot verify"));
      expect((await f.api.list(f.signal)).unresolved).toBe(1);
      expect((await call()).outcome).toBe("unknown");
      expect(write).toHaveBeenCalledOnce();
      await f.api.list(f.signal);
      expect((await call()).outcome).toBe("saved");
      expect(write).toHaveBeenCalledTimes(2);
    },
  );
  it("bounds a write, does not unlock it with refresh while still pending, and never auto-replays", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const response = Promise.withResolvers<unknown>();
      f.services.deleteAutomation.mockReturnValueOnce(response.promise);
      const api = createDesktopScheduleManagement(f.services, 50);
      const first = api.delete(target, f.signal);
      await vi.advanceTimersByTimeAsync(50);
      expect((await first).outcome).toBe("unknown");
      await api.list(f.signal);
      expect((await api.delete(target, f.signal)).outcome).toBe("unknown");
      expect(f.services.deleteAutomation).toHaveBeenCalledOnce();
      response.resolve({ success: true, status: "deleted" });
      await vi.advanceTimersByTimeAsync(0);
      expect((await api.delete(target, f.signal)).outcome).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not dispatch a write after leaving during the ownership check", async () => {
    const f = fixture();
    const owner = Promise.withResolvers<ThreadOwnership>();
    f.services.readOwnership.mockReturnValueOnce(owner.promise);
    const controller = new AbortController();
    const first = f.api.delete(target, controller.signal);
    await vi.waitFor(() => expect(f.services.readOwnership).toHaveBeenCalledOnce());
    controller.abort();
    expect((await first).outcome).toBe("failed");
    owner.resolve({ owner: "external", threadId, harnessId: harnessIdSchema.parse("pi") });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.services.deleteAutomation).not.toHaveBeenCalled();
  });
  it("deduplicates overlapping writes and treats an unverified response as unknown", async () => {
    const f = fixture();
    const result = Promise.withResolvers<unknown>();
    f.services.updateAutomation.mockReturnValueOnce(result.promise);
    const first = f.api.update(target, { name: "changed" }, f.signal);
    expect((await f.api.update(target, { name: "changed" }, f.signal)).outcome).toBe("failed");
    await vi.waitFor(() => expect(f.services.updateAutomation).toHaveBeenCalledOnce());
    result.resolve({ item: { ...native(), id: "wrong" } });
    expect((await first).outcome).toBe("unknown");
    expect(f.services.updateAutomation).toHaveBeenCalledOnce();
  });
});
describe("basic schedule editor", () => {
  it("recognizes only lossless daily/single-day weekly rules", () => {
    expect(parseHarnessScheduleTime(daily)).toEqual({
      frequency: "daily",
      hour: 9,
      minute: 15,
      weekday: 1,
    });
    expect(
      parseHarnessScheduleTime(
        "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR;BYHOUR=16;BYMINUTE=30;BYSECOND=0",
      ),
    ).toEqual({ frequency: "weekly", hour: 16, minute: 30, weekday: 5 });
    for (const rule of [
      complex,
      daily + ";COUNT=4",
      daily + ";BYHOUR=2",
      daily.replace("BYHOUR=9", "BYHOUR=99"),
      daily.replace("BYSECOND=0", "BYSECOND=30"),
      "FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYDAY=MO,FR",
    ])
      expect(parseHarnessScheduleTime(rule)).toBeNull();
  });
});
