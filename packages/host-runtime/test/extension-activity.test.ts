import { afterEach, expect, it, vi } from "vitest";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { ExtensionActivity } from "../src/extension-activity.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const snapshot = (
  active = false,
  status = "completed",
  waiting = false,
  threadStatusType: "active" | "idle" = active ? "active" : "idle",
) =>
  ({
    thread: {
      id: "thread",
      cwd: "C:\\work\\demo",
      modelProvider: "codexhost",
      createdAt: 1,
      updatedAt: 2,
      status: { type: threadStatusType },
      name: "Demo task",
      turns: [],
    },
    activeTurnId: active ? "turn-2" : null,
    turnsPage: { data: [{ id: "turn-1", status }] },
    interactions: waiting ? [{ requestId: 42, kind: "approval" }] : [],
  }) as unknown as ClientThreadSnapshot;

it("tracks canonical running, waiting and terminal state without replaying history", async () => {
  const events = new ClientChannelEvents();
  let current = snapshot();
  const activity = new ExtensionActivity({
    events,
    snapshot: async () => current,
    retryDelaysMs: [5, 10],
  });
  activity.start();
  cleanup.push(() => activity.close());

  events.changed("thread", "thread/status/changed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(activity.read()).toMatchObject({ running: 0, waiting: 0, notifications: [] });

  current = snapshot(true);
  events.changed("thread", "turn/started");
  await expect.poll(() => activity.read().running).toBe(1);
  expect(activity.read().sessions).toMatchObject([
    { threadId: "thread", title: "Demo task", project: "demo", state: "running" },
  ]);

  current = snapshot(true, "completed", true);
  events.changed("thread", "item/commandExecution/requestApproval");
  await expect.poll(() => activity.read().waiting).toBe(1);
  expect(activity.read()).toMatchObject({ running: 0, notifications: [{ kind: "approval" }] });

  current = snapshot(false, "failed");
  events.changed("thread", "turn/completed");
  await expect.poll(() => activity.read().notifications[0]?.kind).toBe("failed");
  const revision = activity.read().notifications[0]?.revision;
  events.changed("thread", "turn/completed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(activity.read().notifications[0]?.revision).toBe(revision);

  current = snapshot(false, "interrupted");
  events.changed("thread", "thread/status/changed");
  await expect.poll(() => activity.read().sessions[0]?.state).toBe("idle");

  events.changed("thread", "thread/deleted");
  expect(activity.read()).toMatchObject({
    running: 0,
    waiting: 0,
    sessions: [],
    notifications: [],
  });
});

it("stays unsubscribed until started, stops cleanly, and handles metadata updates without snapshot reads", async () => {
  const events = new ClientChannelEvents();
  const snapshotSpy = vi.fn(async () => snapshot(true));
  const readMetadataSpy = vi.fn(async () => ({
    title: "Renamed task",
    cwd: "/workspace/renamed-project",
    updatedAt: 99,
  }));
  const activity = new ExtensionActivity({
    events,
    snapshot: snapshotSpy,
    readMetadata: readMetadataSpy,
  });
  cleanup.push(() => activity.close());

  expect(activity.active).toBe(false);
  events.changed("cold-thread", "turn/started");
  events.changed("cold-thread", "thread/name/updated");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(snapshotSpy).not.toHaveBeenCalled();
  expect(readMetadataSpy).not.toHaveBeenCalled();

  activity.start();
  expect(activity.active).toBe(true);

  // Renaming an untracked cold Thread must never trigger snapshot() or readMetadata().
  events.changed("untracked-cold", "thread/name/updated");
  events.changed("untracked-cold", "thread/metadata/updated");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(snapshotSpy).not.toHaveBeenCalled();
  expect(readMetadataSpy).not.toHaveBeenCalled();

  // Start tracking one Thread, then rename it: only readMetadata() runs, never snapshot().
  events.changed("tracked", "turn/started");
  await expect.poll(() => activity.read().running).toBe(1);
  expect(snapshotSpy).toHaveBeenCalledTimes(1);

  events.changed("tracked", "thread/name/updated");
  await expect.poll(() => activity.read().sessions[0]?.title).toBe("Renamed task");
  expect(snapshotSpy).toHaveBeenCalledTimes(1);
  expect(readMetadataSpy).toHaveBeenCalledTimes(1);
  expect(activity.read().sessions[0]).toMatchObject({
    threadId: "tracked",
    title: "Renamed task",
    project: "renamed-project",
    state: "running",
    updatedAt: 99,
  });

  // Stopping releases subscription and clears state.
  activity.stop();
  expect(activity.active).toBe(false);
  expect(activity.read()).toMatchObject({
    running: 0,
    waiting: 0,
    sessions: [],
    notifications: [],
  });
  events.changed("tracked", "turn/completed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(snapshotSpy).toHaveBeenCalledTimes(1);
});

it("keeps parent Threads running while subagents remain active and defers completion notification", async () => {
  const events = new ClientChannelEvents();
  let current = snapshot(true, "inProgress", false, "active");
  const activity = new ExtensionActivity({
    events,
    snapshot: async () => current,
  });
  activity.start();
  cleanup.push(() => activity.close());

  events.changed("parent", "turn/started");
  await expect.poll(() => activity.read().running).toBe(1);

  // Parent Turn completed, but a Subagent is still running so thread.status stays active.
  current = snapshot(false, "completed", false, "active");
  events.changed("parent", "turn/completed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(activity.read()).toMatchObject({
    running: 1,
    waiting: 0,
    notifications: [],
    sessions: [{ threadId: "parent", state: "running" }],
  });

  // Once the last Subagent finishes, thread.status transitions to idle and emits completion.
  current = snapshot(false, "completed", false, "idle");
  events.changed("parent", "thread/status/changed");
  await expect.poll(() => activity.read().running).toBe(0);
  expect(activity.read()).toMatchObject({
    running: 0,
    sessions: [{ threadId: "parent", state: "completed" }],
    notifications: [{ threadId: "parent", kind: "completed" }],
  });
});

it("retries transient snapshot failures within the same lifetime without dropping completion notifications", async () => {
  const events = new ClientChannelEvents();
  let failuresRemaining = 2;
  const activity = new ExtensionActivity({
    events,
    retryDelaysMs: [5, 10, 15],
    snapshot: async () => {
      if (failuresRemaining > 0) {
        failuresRemaining--;
        throw new Error("transient read failure");
      }
      return snapshot(false, "completed");
    },
  });
  activity.start();
  cleanup.push(() => activity.close());

  events.changed("thread", "turn/completed");
  await expect.poll(() => activity.read().notifications.length).toBe(1);
  expect(activity.read().notifications).toMatchObject([{ threadId: "thread", kind: "completed" }]);
});

it("discards late reads, coalesces completion and never resurrects deleted Threads", async () => {
  const events = new ClientChannelEvents();
  const replies: Array<(value: ClientThreadSnapshot) => void> = [];
  const activity = new ExtensionActivity({
    events,
    snapshot: () => new Promise((resolve) => replies.push(resolve)),
  });
  activity.start();
  cleanup.push(() => activity.close());

  events.changed("thread", "turn/completed");
  events.changed("thread", "thread/status/changed");
  const first = replies.shift();
  if (!first) throw new Error("missing snapshot request");
  first(snapshot(true));
  await expect.poll(() => replies.length).toBe(1);
  expect(activity.read().running).toBe(0);
  const second = replies.shift();
  if (!second) throw new Error("missing coalesced snapshot request");
  second(snapshot(false));
  await expect.poll(() => activity.read().notifications.length).toBe(1);

  events.changed("thread", "turn/completed");
  events.changed("thread", "thread/deleted");
  events.changed("thread", "turn/started");
  const deleted = replies.shift();
  if (!deleted) throw new Error("missing deleted snapshot request");
  deleted(snapshot(true));
  await expect.poll(() => replies.length).toBe(1);
  const restarted = replies.shift();
  if (!restarted) throw new Error("missing restarted snapshot request");
  restarted(snapshot(false));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(activity.read()).toMatchObject({ running: 0, notifications: [] });

  events.changed("native", "turn/started");
  events.changed("external", "turn/completed");
  activity.resetNative();
  const native = replies.shift();
  const external = replies.shift();
  if (!native || !external) throw new Error("missing backend reset snapshot requests");
  const nativeSnapshot = snapshot(true);
  native({ ...nativeSnapshot, thread: { ...nativeSnapshot.thread, modelProvider: "openai" } });
  external(snapshot(false));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(activity.read().running).toBe(0);
  expect(activity.read().sessions.some((session) => session.threadId === "native")).toBe(false);
  expect(activity.read().notifications).toMatchObject([
    { threadId: "external", kind: "completed" },
  ]);
});

it("bounds session metadata, prioritizes attention and removes persistently unreadable sessions", async () => {
  const events = new ClientChannelEvents();
  let unreadable = false;
  const activity = new ExtensionActivity({
    events,
    retryDelaysMs: [5, 10],
    snapshot: async (id) => {
      if (unreadable) throw new Error("Thread disappeared");
      const current = snapshot(id === "running", "completed", id === "waiting");
      return {
        ...current,
        thread: {
          ...current.thread,
          id,
          modelProvider: id === "running" ? "openai" : "codexhost",
          name: "A".repeat(300),
          cwd: id === "waiting" ? "/home/example/review/" : "C:\\private\\workspace\\demo\\",
          preview: "Private conversation text",
          updatedAt: Number(id.replace("idle-", "")) || 1,
        },
      };
    },
    describeHarness: async (id) =>
      id === "waiting" ? { id: "claude-code", name: "Claude Code" } : undefined,
  });
  activity.start();
  cleanup.push(() => activity.close());

  for (const id of [
    "running",
    "waiting",
    ...Array.from({ length: 40 }, (_, index) => `idle-${index}`),
  ])
    events.changed(id, "thread/status/changed");
  await expect.poll(() => activity.read().sessions.length).toBe(32);
  const result = activity.read();
  expect(result.sessions.slice(0, 2)).toMatchObject([
    {
      threadId: "waiting",
      project: "review",
      state: "waiting",
      title: "A".repeat(240),
      harness: { id: "claude-code", name: "Claude Code" },
    },
    {
      threadId: "running",
      project: "demo",
      state: "running",
      harness: { id: "codex", name: "Codex" },
    },
  ]);
  expect(
    result.sessions.find((session) => session.threadId.startsWith("idle-")),
  ).not.toHaveProperty("harness");
  expect(JSON.stringify(result)).not.toMatch(/Private conversation|private\\\\workspace/u);

  activity.resetNative();
  expect(activity.read()).toMatchObject({ running: 0, waiting: 1 });
  expect(activity.read().sessions.some((session) => session.threadId === "running")).toBe(false);

  unreadable = true;
  events.changed("waiting", "thread/status/changed");
  await expect.poll(() => activity.read().waiting).toBe(0);
  expect(activity.read().sessions.some((session) => session.threadId === "waiting")).toBe(false);
});
