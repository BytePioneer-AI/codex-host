import { expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import { SessionManager } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/manager.ts";
import { SessionEventStream } from "../../../apps/web-ui/packages/api/session-controller/src/client/transport.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionFollowFrame,
  SessionHistoryRecord,
} from "../../../apps/web-ui/packages/api/session-controller/src/types.ts";

it("appends to the owned journal without per-event snapshots, while captured views stay detached", async () => {
  const capture = vi.spyOn(SessionEventStream.prototype, "capture");
  const first = Promise.withResolvers<SessionFollowFrame>();
  const second = Promise.withResolvers<SessionFollowFrame>();
  const online = { generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } };
  const event = (seq: number) =>
    ({
      type: "event",
      event: { type: "test/content", seq, time: 1, data: { text: String(seq) }, ignorable: true },
    }) as SessionHistoryRecord;
  const remote = {
    $stream: (options: ConstructorParameters<typeof RemoteStream>[1]) =>
      new RemoteStream(online as never, options),
    session: {
      async *follow(_request: unknown, signal: AbortSignal) {
        yield {
          type: "snapshot",
          epoch: "owned",
          header: { version: 4, id: SessionId("s"), createdAt: 1, isSeeded: false },
          cursor: 0,
          records: [event(0)],
          hasMore: false,
          projections: { asOfSeq: 0, values: {} },
          assistantStream: { revision: 0 },
        } as SessionFollowFrame;
        yield await first.promise;
        yield await second.promise;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    },
  } as unknown as SessionRemotes;
  const manager = new SessionManager(remote);
  try {
    const session = manager.get(SessionId("s"));
    await session.open();
    // Array identity is the performance invariant: append must not enumerate/copy its prefix.
    const stream = (session as unknown as { events: { journal: { records: unknown[] } } }).events;
    const owned = stream.journal.records;
    expect(capture).not.toHaveBeenCalled();
    const snapshot = session.captureView()?.journal;
    expect(snapshot?.records).not.toBe(owned);
    first.resolve(event(1));
    await vi.waitFor(() => expect(session.eventSource.getSnapshot().entries).toHaveLength(2));
    second.resolve(event(2));
    await vi.waitFor(() => expect(session.eventSource.getSnapshot().entries).toHaveLength(3));
    expect(stream.journal.records).toBe(owned);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(snapshot?.records).toHaveLength(1);
    expect(snapshot?.cursor).toBe(0);
    expect(session.captureView()?.journal?.records).toHaveLength(3);
  } finally {
    first.resolve(event(1));
    second.resolve(event(2));
    await manager.dispose();
    capture.mockRestore();
  }
});
