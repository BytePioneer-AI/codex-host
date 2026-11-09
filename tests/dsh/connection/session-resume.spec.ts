import { expect, it } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { RemoteStream } from "@deepseek-ai/dsh-api-gateway/client";
import { SessionManager } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/manager.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";
import type {
  SessionFollowFrame,
  SessionFollowRequest,
} from "../../../apps/web-ui/packages/api/session-controller/src/types.ts";

it("resumes the confirmed durable cache, replaces transient baselines, and falls back after rewriting", async () => {
  const requests: SessionFollowRequest[] = [];
  let epoch = "first";
  let count = 2;
  let chunks = 1;
  let active = true;
  const online = { generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } };
  const remote = {
    $stream: (options: ConstructorParameters<typeof RemoteStream>[1]) =>
      new RemoteStream(online as never, options),
    session: {
      async *follow(request: SessionFollowRequest, signal: AbortSignal) {
        requests.push(request);
        const resume = request.resume?.epoch === epoch ? request.resume : undefined;
        const records = Array.from({ length: count }, (_, seq) => ({
          type: "event",
          event: {
            type: "test/content",
            seq,
            time: 1,
            data: { text: `${epoch}:${seq}` },
            ignorable: true,
          },
        }));
        yield {
          type: "snapshot",
          epoch,
          ...(resume ? { resumedAfter: resume.cursor } : {}),
          header: { version: 4, id: SessionId("a"), createdAt: 1, isSeeded: false },
          cursor: count - 1,
          records: resume ? records.slice(resume.cursor + 1) : records,
          hasMore: resume ? false : true,
          projections: {
            asOfSeq: count - 1,
            values: { codexhostToolOutput: { tool: `output ${chunks}` } },
          },
          assistantStream: {
            revision: chunks,
            ...(active
              ? {
                  activeAttempt: {
                    attemptId: "attempt",
                    startedAfterSeq: count - 1,
                    turn: 0,
                    step: 0,
                    nextIndex: chunks,
                    stream: Array.from({ length: chunks }, (_, i) => ({
                      type: "chunk",
                      time: 1,
                      chunk: { type: "text-delta", index: 0, text: `chunk ${i}` },
                    })),
                  },
                }
              : {}),
          },
        } as unknown as SessionFollowFrame;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    },
  } as unknown as SessionRemotes;
  const manager = new SessionManager(remote);
  const id = SessionId("a");
  let session = manager.get(id);
  await session.open();
  expect(session.captureView()?.journal?.cursor).toBe(1);
  expect(
    session.eventSource.getSnapshot().entries.filter((e) => e.type === "transient"),
  ).toHaveLength(1);
  await manager.drop(id, session);
  chunks = 3;
  session = manager.get(id);
  await session.open();
  expect(requests.at(-1)?.resume).toEqual({ epoch: "first", cursor: 1 });
  expect(session.eventSource.getSnapshot().entries.filter((e) => e.type === "event")).toHaveLength(
    2,
  );
  expect(
    session.eventSource.getSnapshot().entries.filter((e) => e.type === "transient"),
  ).toHaveLength(3);
  expect(session.projections.get("codexhostToolOutput")).toEqual({ tool: "output 3" });
  expect(session.getSnapshot().hasMore).toBe(true);
  await manager.drop(id, session);
  count = 4;
  active = false;
  session = manager.get(id);
  await session.open();
  expect(session.eventSource.getSnapshot().entries).toHaveLength(4);
  expect(session.captureView()?.journal?.cursor).toBe(3);
  await manager.drop(id, session);
  epoch = "rewritten";
  chunks = 5;
  count = 1;
  session = manager.get(id);
  await session.open();
  expect(session.eventSource.getSnapshot().entries).toHaveLength(1);
  expect(session.eventSource.getSnapshot().entries[0]?.event.data).toEqual({ text: "rewritten:0" });
  expect(session.projections.get("codexhostToolOutput")).toEqual({ tool: "output 5" });
  await manager.dispose();
});
