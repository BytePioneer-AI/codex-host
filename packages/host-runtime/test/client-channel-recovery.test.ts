import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { expect, it, vi } from "vitest";
import { createFixture, startPiThread, stopFixture } from "./app-server-host-fixture.js";

it("keeps the shared queue paused while an idle faulted Session is closed and restored", async () => {
  const f = createFixture();
  const closeGate = Promise.withResolvers<undefined>();
  try {
    const threadId = await startPiThread(f);
    const session = f.adapter.sessions[0];
    if (!session) throw new Error("Missing native Session");
    const close = session.close.bind(session);
    const closing = vi.spyOn(session, "close").mockImplementation(async () => {
      await closeGate.promise;
      await close();
    });
    const realOpen = f.adapter.open.bind(f.adapter);
    let restored: FakeHarnessSession | undefined;
    const open = vi.spyOn(f.adapter, "open").mockImplementation(async (input) => {
      if (input.kind !== "resume") return realOpen(input);
      restored = new FakeHarnessSession(
        f.adapter.harnessId,
        f.adapter.catalog,
        undefined,
        input.nativeRef,
      );
      f.adapter.sessions.push(restored);
      vi.spyOn(restored, "execute");
      return { ok: true, value: restored };
    });
    expect(
      await f.host.handleClientRequest("thread/queue/add", {
        threadId,
        clientUserMessageId: "queued-before-fault",
        input: [{ type: "text", text: "do not replay automatically" }],
      }),
    ).not.toHaveProperty("error");

    session.fault({ code: "nativeFailure", message: "Native Session faulted", retryable: false });
    await vi.waitFor(() => expect(closing).toHaveBeenCalledOnce());
    const reconnect = f.host.handleClientRequest("thread/queue/list", { threadId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(open).not.toHaveBeenCalled();
    closeGate.resolve(undefined);
    expect(await reconnect).not.toHaveProperty("error");
    expect(open).toHaveBeenCalledOnce();
    if (!restored) throw new Error("Missing restored Session");
    expect(restored.initialState.nativeRef).toEqual(session.initialState.nativeRef);
    expect(restored.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.start" }),
    );
    const snapshot = await f.host.clientSnapshot(threadId);
    expect(snapshot.queue).toMatchObject({
      pausedReason: "outcome-unknown",
      items: [{ clientUserMessageId: "queued-before-fault" }],
    });
    const queued = snapshot.queue?.items[0];
    if (!queued) throw new Error("Lost queued input");
    expect(
      await f.host.handleClientRequest("thread/queue/start", {
        threadId,
        queuedSubmissionId: queued.id,
      }),
    ).not.toHaveProperty("error");
    expect(restored.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.start",
        input: [{ type: "text", text: "do not replay automatically" }],
      }),
    );
    expect((await f.host.clientSnapshot(threadId)).queue?.items).toEqual([]);
    restored.succeedTurn();
  } finally {
    closeGate.resolve(undefined);
    await stopFixture(f);
    vi.restoreAllMocks();
  }
});
