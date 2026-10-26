import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { HostCommand } from "@codexhost/harness-adapter";
import type { DelegationControlApi, DelegationThreadSnapshot } from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import {
  bindOfficialThread,
  createFixture,
  readJsonLine,
  startExternalThread,
  startPiThread,
  startPiTurn,
  stopFixture,
  turnEvent,
} from "./app-server-host-fixture.js";

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
  it("steers a running native parent without resuming or starting another Turn", async () => {
    const value = await watchFixture();
    try {
      const read = await readJsonLine(value.fixture.official.stdin);
      expect(read.method).toBe("thread/read");
      value.answer(read.id, {
        result: {
          thread: {
            id: "native-parent",
            status: { type: "active" },
            turns: [{ id: "running-parent-turn", status: "inProgress", items: [] }],
          },
        },
      });
      const steer = await readJsonLine(value.fixture.official.stdin);
      expect(steer).toMatchObject({
        method: "turn/steer",
        params: {
          threadId: "native-parent",
          expectedTurnId: "running-parent-turn",
          input: [{ type: "text", text: expect.stringContaining("(thread://child): completed") }],
        },
      });
      value.answer(steer.id, { result: { turnId: "running-parent-turn" } });
      await vi.waitFor(async () => expect((await value.service.watches()).watches).toEqual([]));
      expect(value.send).toHaveBeenCalledWith(expect.objectContaining({ steer: true }));
      expect(value.fixture.official.stdin.read()).toBeNull();
    } finally {
      value.service.close();
      await stopFixture(value.fixture);
    }
  });

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
});

async function externalWatchFixture(options: { externalSteerTimeoutMs?: number } = {}) {
  let api: DelegationControlApi | undefined;
  const fixture = createFixture({
    ...options,
    onDelegationApi: (value) => {
      api = value;
      return undefined;
    },
  });
  fixture.adapter.supportsSteer = true;
  const parentId = await startPiThread(fixture);
  const parentTurnId = await startPiTurn(fixture, parentId);
  const childId = await startExternalThread(fixture, "codexhost/pi-native", 3);
  await startPiTurn(fixture, childId, 4);
  const [parent, child] = fixture.adapter.sessions;
  if (!api || !parent || !child) throw new Error("Missing external watch fixture");
  const send = vi.spyOn(api, "send");
  const service = new DelegationWatchService(api, { pollIntervalMs: 10 });
  await service.watch({ threadId: childId, notifyThreadId: parentId, timeoutMs: 60_000 });
  return { fixture, parent, parentTurnId, child, send, service };
}

describe("watch delivery to an external parent", () => {
  it("retries an ended target after capability read without losing or duplicating the notification", async () => {
    const value = await externalWatchFixture();
    const read = Promise.withResolvers<typeof value.parent.capabilities>();
    const readCapabilities = vi.fn(() => read.promise);
    Object.assign(value.parent, { readCapabilities });
    const execute = vi.spyOn(value.parent, "execute");
    try {
      value.child.succeedTurn();
      await vi.waitFor(() => expect(readCapabilities).toHaveBeenCalledOnce());
      value.parent.succeedTurn();
      await value.fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", value.parentTurnId),
      );
      read.resolve(value.parent.capabilities);
      await vi.waitFor(async () => expect((await value.service.watches()).watches).toEqual([]));
      expect(value.send).toHaveBeenCalledTimes(2);
      expect(value.parent.steers).toEqual([]);
      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        expect.objectContaining({
          type: "turn.start",
          input: [{ type: "text", text: expect.stringContaining("[codexhost thread watch]") }],
        }),
      ]);
    } finally {
      read.resolve(value.parent.capabilities);
      value.service.close();
      await stopFixture(value.fixture);
    }
  });

  it.each(["native reply lost", "cancel failed"])("does not retry after %s", async (failure) => {
    const value = await externalWatchFixture();
    const originalExecute = value.parent.execute.bind(value.parent);
    if (failure === "cancel failed") {
      Object.assign(value.parent, {
        readCapabilities: async () => ({ ...value.parent.capabilities, steer: false }),
      });
    }
    const execute = vi
      .spyOn(value.parent, "execute")
      .mockImplementation(async (command: HostCommand) => {
        if (command.type === "turn.cancel" && failure === "cancel failed") {
          return {
            ok: false,
            error: { code: "nativeFailure", message: "cancel failed", retryable: false },
          };
        }
        if (command.type === "turn.steer") {
          await originalExecute(command);
          throw new Error("native reply lost");
        }
        throw new Error(`Unexpected command: ${command.type}`);
      });
    try {
      value.child.succeedTurn();
      await vi.waitFor(async () =>
        expect((await value.service.watches()).watches).toMatchObject([
          { state: "undeliverable", reason: expect.stringContaining("Delivery outcome unknown") },
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(value.send).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(value.parent.steers).toHaveLength(failure === "native reply lost" ? 1 : 0);
    } finally {
      value.service.close();
      await stopFixture(value.fixture);
    }
  });

  it("keeps a notification when the previous Turn stops slowly and delivers it once after idle", async () => {
    const value = await externalWatchFixture({ externalSteerTimeoutMs: 50 });
    Object.assign(value.parent, {
      readCapabilities: async () => ({ ...value.parent.capabilities, steer: false }),
    });
    const execute = vi.spyOn(value.parent, "execute");
    const notificationStarts = () =>
      execute.mock.calls
        .map(([command]) => command as unknown as HostCommand)
        .filter(
          (command) =>
            command.type === "turn.start" &&
            command.input.some((input) => input.text.includes("[codexhost thread watch]")),
        );
    try {
      value.child.succeedTurn();
      await vi.waitFor(() => expect(value.send).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.cancel" })),
      );
      // The previous Turn does not settle within the steering deadline. The rejected
      // send must stay pending instead of becoming undeliverable.
      await vi.waitFor(() => expect(value.send).toHaveBeenCalledTimes(2));
      expect((await value.service.watches()).watches).toMatchObject([{ state: "pendingDelivery" }]);
      expect(notificationStarts()).toHaveLength(0);
      value.parent.succeedTurn();
      await vi.waitFor(async () => expect((await value.service.watches()).watches).toEqual([]));
      expect(notificationStarts()).toEqual([
        expect.objectContaining({
          type: "turn.start",
          input: [{ type: "text", text: expect.stringContaining("[codexhost thread watch]") }],
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notificationStarts()).toHaveLength(1);
    } finally {
      value.service.close();
      await stopFixture(value.fixture);
    }
  });
});
