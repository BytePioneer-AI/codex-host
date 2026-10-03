import { describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema, THREAD_PREWARM_DISCARD_METHOD } from "@codexhost/shared-contracts";
import {
  createFixture,
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

describe("external Thread prewarm lifecycle", () => {
  it.each([false, true])(
    "closes unused prewarms before removing their mapping (deferred identity: %s)",
    async (deferred) => {
      const f = createFixture();
      if (deferred) {
        const open = f.adapter.open.bind(f.adapter);
        vi.spyOn(f.adapter, "open").mockImplementation(async (input) => {
          const result = await open(input);
          if (result.ok) Object.defineProperty(result.value, "initialState", { value: {} });
          return result;
        });
      }
      try {
        const threadId = await startExternalThread(f, "codexhost/pi-native", 1, {
          codexhostPrewarm: true,
        });
        const session = firstSession(f);
        const close = vi.spyOn(session, "close");
        expect((await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId)))?.state).toBe(
          deferred ? "creating" : "ready",
        );
        expect(await discard(f, threadId)).toMatchObject({ result: { discarded: true } });
        expect(close).toHaveBeenCalledOnce();
        expect(await f.mappingStore.getThread(hostThreadIdSchema.parse(threadId))).toBeNull();
        expect(await discard(f, threadId, 31)).toMatchObject({ result: { discarded: false } });
        expect(close).toHaveBeenCalledOnce();
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
