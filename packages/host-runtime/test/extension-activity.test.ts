import { afterEach, expect, it } from "vitest";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import { ExtensionActivity } from "../src/extension-activity.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const snapshot = (active = false, status = "completed", waiting = false) =>
  ({
    thread: {
      id: "thread",
      cwd: "C:\\work\\demo",
      modelProvider: "codexhost",
      createdAt: 1,
      updatedAt: 2,
      status: { type: "idle" },
      name: "Demo task",
      turns: [],
    },
    activeTurnId: active ? "turn-2" : null,
    turnsPage: { data: [{ id: "turn-1", status }] },
    interactions: waiting ? [{ requestId: 42, kind: "approval" }] : [],
  }) as ClientThreadSnapshot;

it("tracks canonical running, waiting and terminal state without replaying history", async () => {
  const events = new ClientChannelEvents();
  let current = snapshot();
  const activity = new ExtensionActivity(events, async () => current);
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

it("discards late reads, coalesces completion and never resurrects deleted Threads", async () => {
  const events = new ClientChannelEvents();
  const replies: Array<(value: ClientThreadSnapshot) => void> = [];
  const activity = new ExtensionActivity(
    events,
    () => new Promise((resolve) => replies.push(resolve)),
  );
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

it("bounds session metadata, prioritizes attention and removes unreadable sessions", async () => {
  const events = new ClientChannelEvents();
  let unreadable = false;
  const activity = new ExtensionActivity(
    events,
    async (id) => {
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
    undefined,
    async (id) => (id === "waiting" ? { id: "claude-code", name: "Claude Code" } : undefined),
  );
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
