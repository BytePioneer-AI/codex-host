import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { CopilotAdapter } from "../src/adapter.js";
import { createCopilotClient } from "../src/client.js";
import { checkpoint, sessionRef } from "../src/refs.js";
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCopilotClient: vi.fn(),
}));

describe("Copilot derived resource failures", () => {
  it("retains the original error if deleting the failed copy also fails", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "copilot-derive-error-"));
    const source = "11111111-1111-4111-8111-111111111111",
      copy = "22222222-2222-4222-8222-222222222222";
    const events = [
      {
        type: "session.start",
        id: "start",
        timestamp: "2026-10-22T00:00:00Z",
        parentId: null,
        data: { sessionId: source, context: { cwd } },
      },
      {
        type: "user.message",
        id: "message-event",
        timestamp: "2026-10-22T00:00:01Z",
        parentId: "start",
        data: { content: "source", messageId: "message" },
      },
    ] as SessionEvent[];
    const inspect = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {
        throw new Error("cannot delete fixture");
      }),
      rpc: {
        sessions: {
          checkInUse: vi.fn(async () => ({ inUse: [] })),
          fork: vi.fn(async () => ({ sessionId: copy })),
          readPersistedEvents: vi.fn(async () => ({
            events,
            cursor: "end",
            cursorStatus: "ok",
            hasMore: false,
          })),
        },
      },
    };
    const child = {
      start: vi.fn(async () => {
        throw new Error("SDK protocol version mismatch");
      }),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
    };
    vi.mocked(createCopilotClient)
      .mockReturnValueOnce(inspect as unknown as CopilotClient)
      .mockReturnValueOnce(child as unknown as CopilotClient);
    const adapter = new CopilotAdapter({ CODEXHOST_COPILOT_COMMAND: process.execPath });
    try {
      const result = await adapter.open({
        kind: "fork",
        sourceRef: sessionRef(source),
        checkpoint: checkpoint(source, "message"),
        cwd,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "protocolError", diagnostic: expect.stringContaining(copy) },
      });
      expect(inspect.deleteSession).toHaveBeenCalledWith(copy);
      expect(inspect.deleteSession).not.toHaveBeenCalledWith(source);
      expect(inspect.stop).toHaveBeenCalledOnce();
    } finally {
      await adapter.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
