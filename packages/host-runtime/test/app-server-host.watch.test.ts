import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { DelegationControlApi, DelegationThreadSnapshot } from "../src/delegation-types.js";
import { DelegationWatchService } from "../src/delegation-watch.js";
import {
  bindOfficialThread,
  createFixture,
  readJsonLine,
  stopFixture,
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
  it.each(["accepted", "rejected", "unknown"] as const)(
    "steers a running native parent and handles an %s receipt without duplicate delivery",
    async (receipt) => {
      const value = await watchFixture();
      try {
        const read = await readJsonLine(value.fixture.official.stdin);
        value.answer(read.id, {
          result: {
            thread: {
              id: "native-parent",
              status: { type: "active" },
              turns: [{ id: "parent-turn", status: "inProgress" }],
            },
          },
        });
        const steer = await readJsonLine(value.fixture.official.stdin);
        expect(steer).toMatchObject({
          method: "turn/steer",
          params: { threadId: "native-parent", expectedTurnId: "parent-turn" },
        });
        expect(value.send).toHaveBeenCalledWith(expect.objectContaining({ steer: true }));
        if (receipt === "rejected") {
          value.answer(steer.id, { error: { code: -32602, message: "Turn has ended" } });
          // A proven rejection can retry; an idle parent then receives one new Turn.
          const resume = await value.readThenResume();
          value.answer(resume.id, value.idle);
          const start = await readJsonLine(value.fixture.official.stdin);
          expect(start).toMatchObject({ method: "turn/start" });
          value.answer(start.id, { result: { turn: { id: "next-turn" } } });
        } else {
          value.answer(
            steer.id,
            receipt === "accepted" ? { result: { turnId: "parent-turn" } } : {},
          );
        }
        await vi.waitFor(async () => {
          const watches = (await value.service.watches()).watches;
          if (receipt === "unknown") {
            expect(watches).toMatchObject([
              {
                state: "undeliverable",
                reason: expect.stringContaining("Delivery outcome unknown"),
              },
            ]);
          } else {
            expect(watches).toEqual([]);
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(value.send).toHaveBeenCalledTimes(receipt === "rejected" ? 2 : 1);
        expect(value.fixture.official.stdin.read()).toBeNull();
      } finally {
        value.service.close();
        await stopFixture(value.fixture);
      }
    },
  );

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
