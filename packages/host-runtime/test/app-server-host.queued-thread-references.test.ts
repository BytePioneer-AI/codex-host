import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

it.each(["automatic", "manual"])(
  "uses the queued submitter's Host identity on %s start",
  async (mode) => {
    const remoteRead = vi.fn(async () => {
      throw new Error("Remote forwarding unavailable");
    });
    const registry = new DelegationControlRegistry({ remoteRead });
    const f = createFixture({ onDelegationApi: (api) => registry.register(api) });
    try {
      const threadId = await startPiThread(f);
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Session missing");
      const execute = vi.spyOn(session, "execute");
      const request = async (id: number, method: string, params: JsonObject) => {
        writeRequest(f.desktopInput, { id, method, params: { threadId, ...params } });
        const response = await f.collector.waitFor((message) => requestId(message, id));
        expect(response).not.toHaveProperty("error");
        return response.result as JsonObject;
      };
      const input = [{ type: "text", text: "thread://target?hostId=queued-host" }];
      const first = await request(10, "turn/start", {
        input,
        codexhostSourceHostId: "previous-host",
      });
      const firstTurnId = String((first.turn as JsonObject).id);
      const added = await request(11, "thread/queue/add", {
        input,
        clientUserMessageId: "queued-message",
        codexhostSourceHostId: "queued-host",
      });
      const queued = added.queuedSubmission as JsonObject & { id: string };
      expect(Object.keys(queued).sort()).toEqual(["clientUserMessageId", "id", "input"]);
      await request(12, "thread/queue/update", {
        input,
        queuedSubmissionId: queued.id,
        codexhostSourceHostId: "editing-host",
      });
      expect(await request(13, "thread/queue/list", {})).toEqual({
        data: [queued],
        nextCursor: null,
      });
      if (mode === "manual") {
        await request(14, "turn/interrupt", { turnId: firstTurnId });
        session.completeCancellation();
      } else session.succeedTurn();
      await f.collector.waitFor((message) => turnEvent(message, "turn/completed", firstTurnId));
      if (mode === "manual")
        await request(15, "thread/queue/start", {
          queuedSubmissionId: queued.id,
          codexhostSourceHostId: "resuming-host",
        });
      await vi.waitFor(() =>
        expect(
          execute.mock.calls.filter(
            ([command]) => (command as { type: string }).type === "turn.start",
          ),
        ).toHaveLength(2),
      );
      await expect(
        registry.read({
          threadId,
          callerThreadId: threadId,
          hostId: "queued-host",
          view: "result",
        }),
      ).resolves.toMatchObject({ hostId: "queued-host" });
      expect(remoteRead).not.toHaveBeenCalled();
      await expect(
        registry.read({
          threadId,
          callerThreadId: threadId,
          hostId: "previous-host",
          view: "result",
        }),
      ).rejects.toThrow("Remote forwarding unavailable");
    } finally {
      registry.close();
      await stopFixture(f);
    }
  },
);
