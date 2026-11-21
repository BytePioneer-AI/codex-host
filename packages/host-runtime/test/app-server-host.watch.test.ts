import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlApi, DelegationThreadSnapshot } from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import {
  bindOfficialThread,
  createFixture,
  messageParams,
  method,
  readJsonLine,
  startExternalThread,
  startPiThread,
  startPiTurn,
  stopFixture,
  threadStatus,
  turnEvent,
} from "./app-server-host-fixture.js";

describe("watch delivery on Host idle events", () => {
  it.each(["Thread", "Subagent"])("nudges watch before polling on %s idle", async (target) => {
    const registry = new DelegationControlRegistry();
    const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
      subagents: { readSnapshot: async () => ({ ok: true as const, value: { turns: [] } }) },
    });
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      onDelegationApi: (registration) => registry.register(registration),
    });
    try {
      const parentId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, parentId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = adapter.sessions[0];
      if (!session) throw new Error("Missing external session");
      let watchedId = parentId;
      if (target === "Subagent") {
        session.startSubagentDelegation({
          subagentId: "child",
          nativeSubagentId: "native-child",
          description: "Child task",
          background: false,
          status: "running",
        });
        const started = await fixture.collector.waitFor(
          (message) =>
            method(message, "thread/started") &&
            (messageParams(message).thread as JsonObject | undefined)?.parentThreadId === parentId,
        );
        watchedId = (messageParams(started).thread as JsonObject).id as string;
      }
      const notifyId = await startExternalThread(fixture, "codexhost/pi-native", 3);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await expect(
        registry.watch({ threadId: watchedId, notifyThreadId: notifyId, timeoutMs: 60_000 }),
      ).resolves.toMatchObject({ state: "watching", status: "running" });

      const messages = fixture.collector.messages;
      const afterRegistration = messages.length;
      if (target === "Subagent") {
        // Keep the parent Turn running: only the Subagent becomes idle.
        session.emitSubagentState("native-child", "completed");
      } else {
        session.succeedTurn();
      }
      // waitFor advances the fake clock, but not far enough to reach the 2s poll.
      await vi.waitFor(() => {
        const updates = messages.slice(afterRegistration);
        expect(updates.some((message) => threadStatus(message, watchedId, "idle"))).toBe(true);
        expect(
          updates.find(
            (message) =>
              method(message, "item/started") &&
              messageParams(message).threadId === notifyId &&
              (messageParams(message).item as JsonObject | undefined)?.type === "userMessage",
          ),
        ).toMatchObject({
          params: {
            item: {
              content: [{ text: expect.stringContaining(`(thread://${watchedId}): completed`) }],
            },
          },
        });
      });
    } finally {
      registry.close();
      vi.useRealTimers();
      await stopFixture(fixture);
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
          input: [{ type: "text", text: expect.stringContaining("(thread://child): completed") }],
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

  it("retries watch delivery when an external Harness rejects turn.start with sessionBusy", async () => {
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (registration) => {
        api = registration;
        return undefined;
      },
    });
    await fixture.ready;
    if (!api) throw new Error("Delegation API was not registered");
    const started = await api.start({
      harnessId: fixture.adapter.harnessId,
      parentThreadId: "client:test",
      cwd: process.cwd(),
      task: "parent task",
    });
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Missing external session");
    session.succeedTurn();
    const controlApi = api;
    await vi.waitFor(async () =>
      expect((await controlApi.read({ threadId: started.threadId, view: "result" })).status).toBe(
        "completed",
      ),
    );
    session.rejectNextTurn({
      code: "sessionBusy",
      message: "Antigravity Turn is already running",
      retryable: true,
    });

    let childStatus: "running" | "completed" = "running";
    const send = vi.spyOn(api, "send");
    const service = new DelegationWatchService(
      {
        read: async ({ threadId }): Promise<DelegationThreadSnapshot> => ({
          threadId,
          harnessId: fixture.adapter.harnessId,
          status: threadId === "child" ? childStatus : "completed",
          turn: { turnId: `${threadId}-turn`, status: childStatus },
          progress: [],
          result: { availability: "pending" },
        }),
        send: (input) => send(input),
      },
      { pollIntervalMs: 15 },
    );
    try {
      await service.watch({
        threadId: "child",
        notifyThreadId: started.threadId,
        timeoutMs: 60_000,
      });
      childStatus = "completed";
      await vi.waitFor(async () => expect((await service.watches()).watches).toEqual([]));
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      service.close();
      await stopFixture(fixture);
    }
  });
});
