import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type {
  DelegationControlApi,
  DelegationControlRegistration,
  DelegationThreadSnapshot,
} from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import { ThreadActivity } from "../src/thread-activity.js";
import {
  bindOfficialThread,
  createFixture,
  readJsonLine,
  startPiThread,
  startPiTurn,
  stopFixture,
} from "./app-server-host-fixture.js";

describe("watch activity from Host Harness streams", () => {
  it("publishes native tool events and external subagent events through the registration", async () => {
    let registration: DelegationControlRegistration | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        registration = api;
        return undefined;
      },
    });
    try {
      await fixture.ready;
      if (!registration?.subscribeActivity) throw new Error("Missing activity subscription");
      const activity = vi.fn();
      const unsubscribe = registration.subscribeActivity(activity);
      fixture.official.stdout.write(
        `${JSON.stringify({ method: "item/commandExecution/outputDelta", params: { threadId: "native", delta: "output" } })}\n`,
      );
      await vi.waitFor(() => expect(activity).toHaveBeenCalledWith(["native"]));
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake Harness session");
      activity.mockClear();
      session.emitSubagentState("worker", "running");
      await vi.waitFor(() => expect(activity).toHaveBeenCalledWith([threadId]));
      unsubscribe();
      activity.mockClear();
      session.emitSubagentTranscriptChanged("worker");
      await new Promise((resolve) => setImmediate(resolve));
      expect(activity).not.toHaveBeenCalled();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("forgets native subagent ancestry when the official Thread closes", async () => {
    let registration: DelegationControlRegistration | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        registration = api;
        return undefined;
      },
    });
    const official = (message: JsonObject) =>
      fixture.official.stdout.write(`${JSON.stringify(message)}\n`);
    const progress = () =>
      official({
        method: "item/agentMessage/delta",
        params: { threadId: "native-child", delta: "progress" },
      });
    try {
      await fixture.ready;
      if (!registration?.subscribeActivity) throw new Error("Missing activity subscription");
      const activity = vi.fn();
      registration.subscribeActivity(activity);
      official({
        method: "thread/started",
        params: {
          thread: {
            id: "native-child",
            source: { subAgent: { thread_spawn: { parent_thread_id: "native-parent" } } },
          },
        },
      });
      progress();
      await vi.waitFor(() =>
        expect(activity).toHaveBeenLastCalledWith(["native-child", "native-parent"]),
      );
      official({ method: "thread/closed", params: { threadId: "native-child" } });
      progress();
      await vi.waitFor(() => expect(activity).toHaveBeenLastCalledWith(["native-child"]));
    } finally {
      await stopFixture(fixture);
    }
  });

  it("releases ancestry when an external session ends and when the official backend stops", async () => {
    const forget = vi.spyOn(ThreadActivity.prototype, "forget");
    const clear = vi.spyOn(ThreadActivity.prototype, "clear");
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      await startPiTurn(fixture, threadId);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing fake Harness session");
      expect(forget).not.toHaveBeenCalled();
      await session.close();
      await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(threadId));

      expect(clear).not.toHaveBeenCalled();
      fixture.official.emit("exit", 1, null);
      await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    } finally {
      forget.mockRestore();
      clear.mockRestore();
      fixture.host.close();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });
});

async function watchFixture() {
  let api: DelegationControlApi | undefined;
  const fixture = createFixture({
    onDelegationApi: (registration) => {
      api = registration;
      return undefined;
    },
  });
  await fixture.ready;
  if (!api) throw new Error("Delegation API was not registered");
  await bindOfficialThread(fixture, "native-parent");
  const send = vi.spyOn(api, "send");
  let status: "running" | "completed" = "running";
  const service = new DelegationWatchService(
    {
      // Only observation is synthetic. Notification delivery uses the real Host API.
      read: async ({ threadId }): Promise<DelegationThreadSnapshot> => ({
        threadId,
        harnessId: "codex",
        status: threadId === "child" ? status : "completed",
        turn: { turnId: `${threadId}-turn`, status },
        progress: [],
        result: { availability: "pending" },
        nextCursor: null,
      }),
      send: (input) => send(input),
    },
    { pollIntervalMs: 10 },
  );
  await service.watch({ threadId: "child", notifyThreadId: "native-parent", timeoutMs: 60_000 });
  status = "completed";
  const answer = (id: unknown, response: JsonObject) => {
    fixture.official.stdout.write(`${JSON.stringify({ id, ...response })}\n`);
  };
  const idle = {
    result: { thread: { id: "native-parent", status: { type: "idle" }, turns: [] } },
  };
  const readThenResume = async () => {
    const read = await readJsonLine(fixture.official.stdin);
    expect(read).toMatchObject({
      method: "thread/read",
      params: { threadId: "native-parent", includeTurns: true },
    });
    answer(read.id, idle);
    const resume = await readJsonLine(fixture.official.stdin);
    expect(resume).toMatchObject({
      method: "thread/resume",
      params: { threadId: "native-parent", excludeTurns: true },
    });
    return resume;
  };
  return { fixture, service, send, answer, idle, readThenResume };
}

describe("watch delivery through native Codex resume", () => {
  it.each<{ label: string; response: JsonObject }>([
    { label: "rejected", response: { error: { code: -32603, message: "resume unavailable" } } },
    { label: "missing result", response: {} },
    {
      label: "wrong Thread",
      response: { result: { thread: { id: "other", status: { type: "idle" } } } },
    },
    {
      label: "not loaded",
      response: { result: { thread: { id: "native-parent", status: { type: "notLoaded" } } } },
    },
    {
      label: "busy",
      response: { result: { thread: { id: "native-parent", status: { type: "active" } } } },
    },
  ])("retries after a $label resume without starting a duplicate Turn", async ({ response }) => {
    const value = await watchFixture();
    try {
      const firstResume = await value.readThenResume();
      value.answer(firstResume.id, response);
      await vi.waitFor(async () =>
        expect((await value.service.watches()).watches).toMatchObject([
          { state: "pendingDelivery", outcome: "completed" },
        ]),
      );
      // The next request must be a new read, not a Turn start after the failed resume.
      const secondResume = await value.readThenResume();
      value.answer(secondResume.id, value.idle);
      const start = await readJsonLine(value.fixture.official.stdin);
      expect(start).toMatchObject({
        method: "turn/start",
        params: {
          threadId: "native-parent",
          input: [{ type: "text", text: expect.stringContaining("Turn child-turn") }],
        },
      });
      value.answer(start.id, { result: { turn: { id: "notification-turn" } } });
      await vi.waitFor(async () => expect((await value.service.watches()).watches).toEqual([]));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(value.send).toHaveBeenCalledTimes(2);
      expect(value.fixture.official.stdin.read()).toBeNull();
    } finally {
      value.service.close();
      await stopFixture(value.fixture);
    }
  });

  it("does not retry an unknown start result after a successful resume", async () => {
    const value = await watchFixture();
    try {
      const resume = await value.readThenResume();
      value.answer(resume.id, value.idle);
      const start = await readJsonLine(value.fixture.official.stdin);
      expect(start).toMatchObject({ method: "turn/start" });
      // No error, but no Turn identity either: acceptance cannot be determined.
      value.answer(start.id, { result: {} });
      await vi.waitFor(async () =>
        expect((await value.service.watches()).watches).toMatchObject([
          { state: "undeliverable", reason: expect.stringContaining("Delivery outcome unknown") },
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(value.send).toHaveBeenCalledOnce();
      expect(value.fixture.official.stdin.read()).toBeNull();
    } finally {
      value.service.close();
      await stopFixture(value.fixture);
    }
  });
});
