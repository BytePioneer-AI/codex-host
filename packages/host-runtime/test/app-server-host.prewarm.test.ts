import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  harnessCommandDescriptorSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  THREAD_PREWARM_DISCARD_METHOD,
} from "@codexhost/shared-contracts";
import {
  JsonLineCollector,
  closeFixture,
  createFixture,
  requiredMessageId,
  startExternalThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;
function firstSession(f: Fixture) {
  const session = f.adapter.sessions[0];
  if (!session) throw new Error("Missing test Session");
  return session;
}
async function discard(f: Fixture, threadId: string, id = 30) {
  writeRequest(f.desktopInput, { id, method: THREAD_PREWARM_DISCARD_METHOD, params: { threadId } });
  return f.collector.waitFor((message) => message.id === id);
}

function startedThreads(f: Fixture, threadId: string) {
  return f.collector.messages.filter(
    (message) =>
      message.method === "thread/started" &&
      (message.params as JsonObject)?.thread &&
      ((message.params as JsonObject).thread as JsonObject).id === threadId,
  );
}

function answerEmptyOfficialLists(f: Fixture) {
  const official = new JsonLineCollector(f.official.stdin);
  f.official.stdin.on("data", () => {
    for (const request of official.messages.splice(0)) {
      writeRequest(f.official.stdout, {
        id: requiredMessageId(request),
        result: { data: [], nextCursor: null, backwardsCursor: null },
      });
    }
  });
}

async function list(f: Fixture, id: number, params: JsonObject = {}) {
  writeRequest(f.desktopInput, { id, method: "thread/list", params });
  const response = await f.collector.waitFor((message) => message.id === id);
  expect(response).not.toHaveProperty("error");
  return ((response.result as JsonObject).data as JsonObject[]).map((thread) => thread.id);
}

/** Model an Adapter that reports its identity on the first submitted Turn. */
function deferIdentity(f: Fixture) {
  const open = f.adapter.open.bind(f.adapter);
  vi.spyOn(f.adapter, "open").mockImplementation(async (input) => {
    const result = await open(input);
    if (result.ok) {
      const state = result.value.initialState;
      Object.defineProperty(result.value, "initialState", {
        value: { ...state, nativeRef: undefined },
      });
      const outputs = result.value.outputs;
      Object.defineProperty(result.value, "outputs", {
        value: (async function* (): AsyncGenerator<HarnessOutput> {
          for await (const output of outputs) {
            if (output.kind === "event" && output.event.type === "turn.started") {
              yield { kind: "event", event: { type: "session.state.changed", state } };
            }
            yield output;
          }
        })(),
      });
    }
    return result;
  });
}

describe("external Thread prewarm lifecycle", () => {
  it.each([false, true])(
    "hides prewarms from notifications and lists until submission (deferred identity: %s)",
    async (deferred) => {
      const f = createFixture();
      answerEmptyOfficialLists(f);
      if (deferred) deferIdentity(f);
      try {
        const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
          codexhostPrewarm: true,
        });
        expect(await list(f, 10)).toEqual([]);
        expect(startedThreads(f, threadId)).toEqual([]);
        expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toMatchObject({
          state: "creating",
          turnMappings: [],
        });
        const turnId = await startPiTurn(f, threadId);
        await f.collector.waitFor((message) => message.method === "turn/started");
        expect(startedThreads(f, threadId)).toHaveLength(1);
        expect(await list(f, 11)).toEqual([threadId]);
        firstSession(f).succeedTurn();
        await f.collector.waitFor((message) => message.method === "turn/completed");
        expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toMatchObject({
          state: "ready",
          turnMappings: [{ hostTurnId: turnId }],
        });
        await startPiTurn(f, threadId, 3);
        expect(startedThreads(f, threadId)).toHaveLength(1);
        firstSession(f).succeedTurn();
      } finally {
        await stopFixture(f);
      }
    },
  );

  it.each([false, true])(
    "does not publish state changes, inspection, or configuration (deferred identity: %s)",
    async (deferred) => {
      const f = createFixture();
      answerEmptyOfficialLists(f);
      if (deferred) deferIdentity(f);
      try {
        const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
          codexhostPrewarm: true,
        });
        const session = firstSession(f);
        session.emitEvent({ type: "session.state.changed", state: session.initialState });
        writeRequest(f.desktopInput, {
          id: 10,
          method: "codexhost/thread/model/select",
          params: { threadId, model: { id: "fake-model-v1.secondary" } },
        });
        expect(await f.collector.waitFor((message) => message.id === 10)).not.toHaveProperty(
          "error",
        );
        writeRequest(f.desktopInput, { id: 11, method: "thread/read", params: { threadId } });
        expect(await f.collector.waitFor((message) => message.id === 11)).not.toHaveProperty(
          "error",
        );
        expect(await list(f, 12)).toEqual([]);
        expect(await list(f, 13, { sortKey: "section_position", sectionId: "pinned" })).toEqual([]);
        expect(startedThreads(f, threadId)).toEqual([]);
        await startPiTurn(f, threadId);
        expect(await list(f, 14)).toEqual([threadId]);
        expect(startedThreads(f, threadId)).toHaveLength(1);
        session.succeedTurn();
      } finally {
        await stopFixture(f);
      }
    },
  );

  it("publishes a prewarm when the first submission is a native command", async () => {
    const f = createFixture();
    answerEmptyOfficialLists(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const session = firstSession(f);
      session.commands = {
        list: async () => ({
          ok: true,
          value: {
            commands: [
              harnessCommandDescriptorSchema.parse({
                id: "fake.compact",
                invocation: "/compact",
                label: "Compact",
                argumentMode: "none",
              }),
            ],
          },
        }),
        execute: async ({ turnId }) => {
          session.emitEvent({ type: "turn.started", turnId });
          session.emitEvent({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
          return { ok: true, value: { turnId } };
        },
      };
      writeRequest(f.desktopInput, {
        id: 2,
        method: "codexhost/thread/command/execute",
        params: { threadId, commandId: "fake.compact" },
      });
      expect(await f.collector.waitFor((message) => message.id === 2)).not.toHaveProperty("error");
      await f.collector.waitFor((message) => message.method === "turn/completed");
      expect(startedThreads(f, threadId)).toHaveLength(1);
      expect(await list(f, 10)).toEqual([threadId]);
    } finally {
      await stopFixture(f);
    }
  });

  it("retains real autonomous work instead of discarding it as an unused prewarm", async () => {
    const f = createFixture();
    answerEmptyOfficialLists(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const turnId = hostTurnIdSchema.parse("autonomous-prewarm-work");
      firstSession(f).publishAutonomousTurn(turnId, [{ type: "text", text: "native work" }]);
      await f.collector.waitFor((message) => message.method === "turn/completed");
      expect(startedThreads(f, threadId)).toHaveLength(1);
      expect(await list(f, 10)).toEqual([threadId]);
      expect(await discard(f, threadId)).toMatchObject({ result: { discarded: false } });
      expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toMatchObject({
        state: "ready",
        turnMappings: [{ hostTurnId: turnId }],
      });
    } finally {
      await stopFixture(f);
    }
  });

  it("does not recover an abandoned prewarm as a sidebar Thread after restart", async () => {
    const f = createFixture();
    const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
      codexhostPrewarm: true,
    });
    await closeFixture(f);
    const restarted = createFixture({ mappingStoreDirectory: f.mappingStoreDirectory });
    answerEmptyOfficialLists(restarted);
    try {
      await restarted.ready;
      expect(await list(restarted, 10)).toEqual([]);
      expect(await restarted.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toBeNull();
    } finally {
      await stopFixture(restarted);
    }
  });

  it("does not execute or publish a draft when committing its native identity fails", async () => {
    const f = createFixture();
    answerEmptyOfficialLists(f);
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const execute = vi.spyOn(firstSession(f), "execute");
      vi.spyOn(f.mappingStore, "commitReady").mockRejectedValueOnce(new Error("disk failure"));
      writeRequest(f.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "hello" }] },
      });
      expect(await f.collector.waitFor((message) => message.id === 2)).toHaveProperty("error");
      expect(execute).not.toHaveBeenCalled();
      expect(startedThreads(f, threadId)).toEqual([]);
      expect(await list(f, 10)).toEqual([]);
      await startPiTurn(f, threadId, 3);
      expect(startedThreads(f, threadId)).toHaveLength(1);
      firstSession(f).succeedTurn();
    } finally {
      await stopFixture(f);
    }
  });
  it.each([false, true])(
    "closes unused prewarms before removing their mapping (deferred identity: %s)",
    async (deferred) => {
      const f = createFixture();
      answerEmptyOfficialLists(f);
      if (deferred) deferIdentity(f);
      try {
        const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
          codexhostPrewarm: true,
        });
        const session = firstSession(f);
        const close = vi.spyOn(session, "close");
        expect((await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId)))?.state).toBe(
          "creating",
        );
        expect(await discard(f, threadId)).toMatchObject({ result: { discarded: true } });
        expect(close).toHaveBeenCalledOnce();
        expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toBeNull();
        expect(await discard(f, threadId, 31)).toMatchObject({ result: { discarded: false } });
        expect(close).toHaveBeenCalledOnce();
        expect(await list(f, 32)).toEqual([]);
        expect(startedThreads(f, threadId)).toEqual([]);
        expect(await startExternalThread(f, "codexhost/pi-native", 40)).toBeTruthy();
      } finally {
        await stopFixture(f);
      }
    },
  );

  it("does not discard ordinary empty Threads", async () => {
    const f = createFixture();
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native");
      const close = vi.spyOn(firstSession(f), "close");
      expect(await discard(f, threadId)).toMatchObject({ result: { discarded: false } });
      expect(close).not.toHaveBeenCalled();
    } finally {
      await stopFixture(f);
    }
  });

  it("atomically adopts a submitted prewarm before a queued discard", async () => {
    const f = createFixture();
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const session = firstSession(f);
      const close = vi.spyOn(session, "close");
      const turn = startPiTurn(f, threadId);
      const discarded = discard(f, threadId);
      await turn;
      expect(await discarded).toMatchObject({ result: { discarded: false } });
      expect(close).not.toHaveBeenCalled();
      session.succeedTurn();
      expect(await discard(f, threadId, 31)).toMatchObject({ result: { discarded: false } });
    } finally {
      await stopFixture(f);
    }
  });

  it("retains the mapping and blocks work after an uncertain close", async () => {
    const f = createFixture();
    try {
      const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
        codexhostPrewarm: true,
      });
      const close = vi
        .spyOn(firstSession(f), "close")
        .mockRejectedValueOnce(new Error("close failed"));
      expect(await discard(f, threadId)).toMatchObject({ error: { code: -32075 } });
      expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).not.toBeNull();
      writeRequest(f.desktopInput, {
        id: 50,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text: "must not run" }] },
      });
      expect(await f.collector.waitFor((message) => message.id === 50)).toHaveProperty("error");
      close.mockRestore();
    } finally {
      await stopFixture(f);
    }
  });
});
