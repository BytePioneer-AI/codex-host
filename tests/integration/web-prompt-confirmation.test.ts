import { afterEach, expect, it, vi } from "vitest";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { Session } from "../../apps/web-ui/packages/api/session-controller/src/client/sessions/session.ts";
import type { SessionRemotes } from "../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPageRequest,
  SessionRequestId,
} from "../../apps/web-ui/packages/api/session-controller/src/types.ts";

const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

const unknown = () => ({
  ok: false as const,
  error: new RemoteError("remote/outcome-unknown", "Remote operation was not confirmed", {}),
});
const message = (requestId: string) => ({
  id: `message-${requestId}`,
  role: "user",
  content: [{ type: "text", text: "继续" }],
  source: { kind: "user", rpcId: requestId },
});

async function fixture() {
  const id = SessionId("remote-thread");
  const records: SessionHistoryRecord[] = [];
  let tailFrom = 0;
  let publish: (frame: SessionFollowFrame | undefined) => void = () => {};
  const prompt = vi.fn(async () => unknown());
  const cancel = vi.fn(async () => unknown());
  const onEngaged = vi.fn<(session: Session) => void>();
  const page = vi.fn(async (request: SessionPageRequest) => ({
    ok: true as const,
    value: {
      records: records.filter(({ event }) => event.seq < (request.beforeSeq ?? Infinity)),
      hasMore: false,
    },
  }));
  const online = { generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } };
  const remote = {
    $stream: (options: ConstructorParameters<typeof RemoteStream>[1]) =>
      new RemoteStream(online as never, options),
    session: {
      prompt,
      cancel,
      page,
      async *follow(_request: unknown, signal: AbortSignal) {
        let next = Promise.withResolvers<SessionFollowFrame | undefined>();
        publish = (frame) => next.resolve(frame);
        const abort = () => next.resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
        try {
          yield {
            type: "snapshot",
            epoch: "remote-epoch",
            header: { version: 4, id, createdAt: 1, isSeeded: false },
            cursor: records.length - 1,
            records: records.slice(tailFrom),
            hasMore: tailFrom > 0,
            projections: { asOfSeq: records.length - 1, values: {} },
            assistantStream: { revision: 0 },
          } as SessionFollowFrame;
          while (!signal.aborted) {
            const frame = await next.promise;
            next = Promise.withResolvers<SessionFollowFrame | undefined>();
            if (!frame) return;
            yield frame;
          }
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
    },
  } as unknown as SessionRemotes;
  const session = new Session(id, remote, { onEngaged });
  sessions.push(session);
  await session.open();
  const begin = () => session.beginSubmission({ mode: "queue", text: "继续", attachments: [] });
  const send = (requestId?: SessionRequestId) =>
    session.prompt([{ type: "text", text: "继续" }], "queue", undefined, requestId);
  const confirm = async (requestId: string, live = true) => {
    const frame = {
      type: "event",
      event: {
        type: "user/message",
        seq: records.length,
        time: Date.now(),
        data: message(requestId),
        surfaceOp: "append",
      },
    } as unknown as SessionHistoryRecord;
    records.push(frame);
    if (live) {
      publish(frame);
      await vi.waitFor(() =>
        expect(session.eventSource.getSnapshot().entries).toHaveLength(records.length),
      );
    }
  };
  const spliceInbox = async (requestIds: readonly string[], removedCount = 0, live = true) => {
    const frame = {
      type: "event",
      event: {
        type: "agent/inbox/spliced",
        seq: records.length,
        time: Date.now(),
        data: {
          target: "next-turn",
          start: 0,
          removedCount,
          inserted: requestIds.map(message),
          ...(removedCount > 0 ? { outcome: "canceled" } : {}),
        },
      },
    } as unknown as SessionHistoryRecord;
    records.push(frame);
    if (live) {
      publish(frame);
      await vi.waitFor(() =>
        expect(session.eventSource.getSnapshot().entries).toHaveLength(records.length),
      );
    }
  };
  return {
    session,
    prompt,
    page,
    onEngaged,
    begin,
    send,
    confirm,
    spliceInbox,
    showTailFrom: (index: number) => {
      tailFrom = index;
    },
  };
}

it("clears an unknown send only when its own message arrives, without sending again", async () => {
  const f = await fixture();
  const submission = f.begin();
  expect((await f.send(submission.requestId)).ok).toBe(false);
  expect(f.session.getSnapshot().pendingSubmissions).toEqual([]);
  f.session.handleRunning(true);
  await f.confirm("another-client");
  expect(f.session.getSnapshot().promptError?.error.code).toBe("remote/outcome-unknown");
  await f.confirm(submission.requestId);
  expect(f.session.getSnapshot().promptError).toBeNull();
  await f.session.resync();
  expect(f.session.getSnapshot().promptError).toBeNull();
  expect(f.prompt).toHaveBeenCalledTimes(1);
});

it("accepts a confirmed message even when its unknown-outcome reply arrives later", async () => {
  const f = await fixture();
  const reply = Promise.withResolvers<ReturnType<typeof unknown>>();
  f.prompt.mockReturnValueOnce(reply.promise);
  const submission = f.begin();
  const sending = f.send(submission.requestId);
  await f.confirm(submission.requestId);
  await vi.waitFor(() => expect(f.session.getSnapshot().pendingSubmissions).toEqual([]));
  reply.resolve(unknown());
  expect(await sending).toEqual({ ok: true, value: { accepted: true } });
  expect(f.session.getSnapshot().promptError).toBeNull();
  expect(f.prompt).toHaveBeenCalledTimes(1);
});

it("reconciles unknown sends from a fresh history baseline", async () => {
  const f = await fixture();
  const submission = f.begin();
  await f.send(submission.requestId);
  await f.confirm(submission.requestId, false);
  await f.session.resync();
  expect(f.session.getSnapshot().promptError).toBeNull();
});

it("uses the transmitted request identity when the caller did not create a local echo", async () => {
  const f = await fixture();
  await f.send();
  const request = (f.prompt.mock.calls[0] as unknown as [{ requestId: string }])[0];
  await f.confirm(request.requestId);
  expect(f.session.getSnapshot().promptError).toBeNull();
});

it("does not clear a newer unknown send when an earlier message is confirmed", async () => {
  const f = await fixture();
  const first = f.begin();
  await f.send(first.requestId);
  const second = f.begin();
  await f.send(second.requestId);
  await f.confirm(first.requestId);
  expect(f.session.getSnapshot().promptError?.error.code).toBe("remote/outcome-unknown");
  await f.confirm(second.requestId);
  expect(f.session.getSnapshot().promptError).toBeNull();
});

it("does not hide a definite rejection or a stop error after observing a message", async () => {
  const f = await fixture();
  f.prompt.mockResolvedValueOnce({
    ok: false,
    error: new RemoteError("session/writer-held", "Session is in use", {}),
  });
  const first = f.begin();
  await f.send(first.requestId);
  await f.confirm(first.requestId);
  expect(f.session.getSnapshot().promptError?.error.code).toBe("session/writer-held");
  const second = f.begin();
  await f.send(second.requestId);
  await f.session.cancel();
  await f.confirm(second.requestId);
  expect(f.session.getSnapshot().promptError?.op).toBe("stop");
});

it("reconciles a matching queue receipt after the failed local echo has retired", async () => {
  const f = await fixture();
  const submission = f.begin();
  await f.send(submission.requestId);
  f.session.projections.applyLive(
    "inbox",
    { "next-turn": [message(submission.requestId)], "next-step": [] },
    SessionSeq(5),
  );
  await vi.waitFor(() => expect(f.session.getSnapshot().promptError).toBeNull());
});

it.each([true, false])(
  "retains a transient receipt until the RPC settles, with local echo %s",
  async (echo) => {
    const f = await fixture();
    const reply = Promise.withResolvers<ReturnType<typeof unknown>>();
    f.prompt.mockReturnValueOnce(reply.promise);
    const sending = f.send(echo ? f.begin().requestId : undefined);
    const request = (f.prompt.mock.calls[0] as unknown as [{ requestId: SessionRequestId }])[0];
    f.session.projections.applyLive(
      "inbox",
      { "next-turn": [message(request.requestId)], "next-step": [] },
      SessionSeq(5),
    );
    await vi.waitFor(() => expect(f.session.getSnapshot().pendingSubmissions).toEqual([]));
    await Promise.resolve();
    f.session.projections.applyLive("inbox", { "next-turn": [], "next-step": [] }, SessionSeq(6));
    await Promise.resolve();
    reply.resolve(unknown());
    expect(await sending).toEqual({ ok: true, value: { accepted: true } });
    expect(f.session.getSnapshot().promptError).toBeNull();
    expect(f.onEngaged).toHaveBeenCalledTimes(1);
    // A completed RPC's transient receipt must not confirm a later invocation.
    expect((await f.send(request.requestId)).ok).toBe(false);
    expect(f.session.getSnapshot().promptError?.error.code).toBe("remote/outcome-unknown");
  },
);

it("engages a blank session once when a receipt arrives after the failed reply", async () => {
  const f = await fixture();
  f.onEngaged.mockImplementation((session) => {
    expect(session.getSnapshot().promptError).toBeNull();
    expect(session.getSnapshot().blank).toBe(false);
    session.handleBlank(false);
  });
  const submission = f.begin();
  await f.send(submission.requestId);
  expect(f.session.getSnapshot().blank).toBe(true);
  await f.confirm(submission.requestId);
  expect(f.session.getSnapshot().blank).toBe(false);
  expect(f.onEngaged).toHaveBeenCalledExactlyOnceWith(f.session);
  await f.confirm(submission.requestId);
  await f.session.resync();
  expect(f.onEngaged).toHaveBeenCalledTimes(1);
});

it("retains an event-only queue receipt for a send without an optimistic echo", async () => {
  const f = await fixture();
  const reply = Promise.withResolvers<ReturnType<typeof unknown>>();
  f.prompt.mockReturnValueOnce(reply.promise);
  const sending = f.send();
  const request = (f.prompt.mock.calls[0] as unknown as [{ requestId: SessionRequestId }])[0];
  await f.spliceInbox([request.requestId]);
  await f.spliceInbox([], 1);
  reply.resolve(unknown());
  expect(await sending).toEqual({ ok: true, value: { accepted: true } });
  expect(f.session.getSnapshot().promptError).toBeNull();
  expect(f.onEngaged).toHaveBeenCalledTimes(1);
});

it.each(["loadOlder", "loadThrough"] as const)(
  "confirms a send found outside the restored tail through %s",
  async (load) => {
    const f = await fixture();
    const submission = f.begin();
    await f.send(submission.requestId);
    await f.confirm(submission.requestId, false);
    await f.confirm("another-client", false);
    f.showTailFrom(1);
    await f.session.resync();
    expect(f.session.getSnapshot().promptError?.error.code).toBe("remote/outcome-unknown");
    if (load === "loadOlder") await f.session.loadOlder();
    else await f.session.loadThrough(SessionSeq(0));
    expect(f.page).toHaveBeenCalledTimes(1);
    expect(f.session.eventSource.getSnapshot().entries).toHaveLength(2);
    expect(f.session.getSnapshot().promptError).toBeNull();
    expect(f.session.getSnapshot().blank).toBe(false);
    expect(f.prompt).toHaveBeenCalledTimes(1);
  },
);

it.each(["loadOlder", "loadThrough"] as const)(
  "confirms a canceled queue receipt found through %s",
  async (load) => {
    const f = await fixture();
    const submission = f.begin();
    await f.send(submission.requestId);
    await f.spliceInbox([submission.requestId], 0, false);
    await f.spliceInbox([], 1, false);
    await f.confirm("another-client", false);
    f.showTailFrom(2);
    await f.session.resync();
    expect(f.session.getSnapshot().promptError?.error.code).toBe("remote/outcome-unknown");
    if (load === "loadOlder") await f.session.loadOlder();
    else await f.session.loadThrough(SessionSeq(0));
    expect(f.session.getSnapshot().promptError).toBeNull();
    expect(f.session.getSnapshot().blank).toBe(false);
    expect(f.onEngaged).toHaveBeenCalledTimes(1);
    expect(f.prompt).toHaveBeenCalledTimes(1);
  },
);

it("observes older queue acceptance without replaying its settlement side effects", async () => {
  const f = await fixture();
  const reply = Promise.withResolvers<ReturnType<typeof unknown>>();
  f.prompt.mockReturnValueOnce(reply.promise);
  const onRetire = vi.fn();
  const submission = f.session.beginSubmission({
    mode: "queue",
    text: "继续",
    attachments: [],
    onRetire,
  });
  const sending = f.send(submission.requestId);
  await f.spliceInbox([submission.requestId], 0, false);
  await f.spliceInbox([], 1, false);
  await f.confirm("another-client", false);
  f.showTailFrom(2);
  await f.session.resync();
  await f.session.loadOlder();
  expect(f.session.getSnapshot().pendingSubmissions).toHaveLength(1);
  expect(onRetire).not.toHaveBeenCalled();
  reply.resolve(unknown());
  expect(await sending).toEqual({ ok: true, value: { accepted: true } });
  expect(f.session.getSnapshot().promptError).toBeNull();
  expect(onRetire).not.toHaveBeenCalled();
});
