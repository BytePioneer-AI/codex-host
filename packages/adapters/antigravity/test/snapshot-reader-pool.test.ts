import { expect, it, vi } from "vitest";
import { AntigravitySnapshotReaderPool } from "../src/snapshot-reader-pool.js";
import {
  AntigravityTransportError,
  type AntigravityOpenAcpSessionInput,
} from "../src/acp-types.js";

function fixture() {
  let sessionId: string | null = null;
  let closed = false;
  const reader = {
    get sessionId() {
      return sessionId;
    },
    get isClosed() {
      return closed;
    },
    skipPermissions: false,
    initialize: vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
    openSession: vi.fn(async (input: AntigravityOpenAcpSessionInput) => {
      if (closed || sessionId !== null) {
        throw new AntigravityTransportError("unavailable", "Reader already has an open Session");
      }
      sessionId = input.sessionId ?? "new";
      return { opened: { sessionId }, replayedEvents: [] };
    }),
    closeSession: vi.fn(async () => {
      sessionId = null;
    }),
    close: vi.fn(async () => {
      closed = true;
      sessionId = null;
    }),
    setSessionEventHandler: () => {},
    setMode: async () => {},
    setConfigOption: async () => [],
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => {},
  };
  const pool = new AntigravitySnapshotReaderPool({ createTransport: () => reader });
  const load = (id: string) =>
    pool.loadSession({
      sessionId: id,
      cwd: "/workspace",
      environment: { HOME: "/home/test" },
      skipPermissions: false,
    });
  return { reader, pool, load };
}

it("keeps a request arriving on completion behind already queued reads", async () => {
  const { reader, pool, load } = fixture();
  const gate = Promise.withResolvers<undefined>();
  const open = reader.openSession.getMockImplementation()!;
  reader.openSession.mockImplementationOnce(async (input) => {
    const result = await open(input);
    await gate.promise;
    return result;
  });
  const first = load("A");
  const queued = load("B");
  const arriving = first.then(() => load("C"));
  gate.resolve(undefined);
  const results = await Promise.allSettled([first, queued, arriving]);
  try {
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(reader.openSession.mock.calls.map(([input]) => input.sessionId)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(reader.initialize).toHaveBeenCalledOnce();
  } finally {
    await pool.close();
  }
});

it("reports retired cleanup failure even if it settled before pool close", async () => {
  const { reader, pool, load } = fixture();
  const loadError = new Error("native load failed");
  const cleanupError = new Error("reader cleanup failed");
  reader.openSession.mockRejectedValueOnce(loadError);
  reader.close.mockRejectedValueOnce(cleanupError);
  await expect(load("failed")).rejects.toBe(loadError);
  await new Promise<undefined>((resolve) => setImmediate(resolve, undefined));
  await expect(pool.close()).rejects.toBe(cleanupError);
});

it("does not report a successful retry after active reader cleanup failed", async () => {
  const { reader, pool, load } = fixture();
  await load("A");
  const cleanupError = new Error("reader cleanup failed");
  reader.close.mockRejectedValueOnce(cleanupError);
  await expect(pool.close()).rejects.toBe(cleanupError);
  await expect(pool.close()).rejects.toBe(cleanupError);
});
