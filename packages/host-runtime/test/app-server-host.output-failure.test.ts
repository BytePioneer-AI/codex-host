import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  requestId,
  startExternalThread,
  startPiThread,
  startPiTurn,
  stopFixture,
  threadStatus,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("AppServerHost output failure", () => {
  it("fails the Turn and closes its Session when an Item changes type at completion", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [{ id: "auto", label: "Auto" }],
      defaultModeId: "auto",
    });
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    try {
      const threadId = await startPiThread(fixture);
      const turnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      const close = vi.spyOn(session, "close");
      const itemId = hostItemIdSchema.parse("conflicting-item");
      session.emitEvent({
        type: "item.started",
        turnId,
        item: { type: "reasoning", itemId, text: "Thinking" },
      });
      session.emitEvent({
        type: "item.completed",
        turnId,
        snapshot: {
          item: { type: "agentMessage", itemId, text: "Done" },
          outcome: { status: "succeeded" },
        },
      });
      // A bad Item must not leave the Host running or let a later success hide the failure.
      session.succeedTurn();
      const completed = await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      expect(completed).toMatchObject({
        params: {
          turn: {
            status: "failed",
            error: { message: expect.stringContaining("Host Item changed type") },
          },
        },
      });
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
      expect(close).toHaveBeenCalledOnce();
      expect(
        fixture.collector.messages.filter((message) =>
          turnEvent(message, "turn/completed", turnId),
        ),
      ).toHaveLength(1);
      expect(fixture.collector.messages).toContainEqual(
        expect.objectContaining({
          method: "item/completed",
          params: expect.objectContaining({
            item: expect.objectContaining({ id: `${itemId}-summary`, type: "reasoning" }),
          }),
        }),
      );
      // Configuration must resume the native identity, not execute on the closed Session.
      const execute = vi.spyOn(session, "execute");
      const nativeOpen = adapter.open.bind(adapter);
      const open = vi.spyOn(adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return nativeOpen(input);
        const restored = new FakeHarnessSession(
          adapter.harnessId,
          adapter.catalog,
          undefined,
          input.nativeRef,
          undefined,
          true,
          input.cwd,
          true,
          undefined,
          null,
          permissionModes,
        );
        return { ok: true, value: restored };
      });
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/thread/permission-mode/select",
        params: { threadId, permissionModeId: "auto" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { effectivePermissionModeId: "auto" },
      });
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "resume",
          nativeRef: session.initialState.nativeRef,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
      const otherThread = await startExternalThread(fixture, "codexhost/pi-native", 4);
      const otherTurn = await startPiTurn(fixture, otherThread, 5);
      const otherSession = fixture.adapter.sessions[1];
      if (!otherSession) throw new Error("Other Pi Session was not opened");
      otherSession.succeedTurn();
      expect(
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", otherTurn),
        ),
      ).toMatchObject({
        params: { turn: { status: "completed" } },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
