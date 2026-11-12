import { afterEach, expect, it, vi } from "vitest";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import { Session } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/session.ts";
import type { SessionRemotes } from "../../../apps/web-ui/packages/api/session-controller/src/client/sessions/remotes.ts";

const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

function fixture(running = false, mode: "queue" | "steer" = "queue") {
  const session = new Session(SessionId("thread"), {} as SessionRemotes);
  sessions.push(session);
  session.handleRunning(running);
  const onRetire = vi.fn();
  const submission = session.beginSubmission({ mode, text: "是apec", attachments: [], onRetire });
  const message = {
    id: "native-queue-item",
    role: "user",
    content: [{ type: "text", text: "是apec" }],
    source: { kind: "user", rpcId: submission.requestId },
  };
  return { session, onRetire, submission, message };
}

it.each(["queue", "steer"] as const)(
  "hands an optimistic idle %s send to the actual next-turn queue without leaving a running echo",
  async (mode) => {
    const { session, onRetire, submission, message } = fixture(false, mode);
    expect(session.getSnapshot().pendingSubmissions[0]?.placement).toBe("transcript");
    session.projections.applyLive(
      "inbox",
      { "next-turn": [message], "next-step": [] },
      SessionSeq(5),
    );
    await vi.waitFor(() => expect(session.getSnapshot().pendingSubmissions).toEqual([]));
    expect(session.getSnapshot().running).toBe(false);
    expect(session.projections.get("inbox")).toEqual({ "next-turn": [message], "next-step": [] });
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: "observed", attachments: [] });
    submission.abandon();
    expect(onRetire).toHaveBeenCalledTimes(1);
  },
);

it("still retires busy queued echoes when Host confirms their queue entry", async () => {
  const { session, onRetire, message } = fixture(true);
  expect(session.getSnapshot().pendingSubmissions[0]?.placement).toBe("queued");
  session.projections.applyLive(
    "inbox",
    { "next-turn": [message], "next-step": [] },
    SessionSeq(5),
  );
  await vi.waitFor(() => expect(session.getSnapshot().pendingSubmissions).toEqual([]));
  expect(session.getSnapshot().running).toBe(true);
  expect(onRetire).toHaveBeenCalledTimes(1);
});

it("keeps a steering echo until admission, rather than retiring it on next-step delivery", async () => {
  const { session, onRetire, submission, message } = fixture(true, "steer");
  session.projections.applyLive(
    "inbox",
    { "next-turn": [], "next-step": [message] },
    SessionSeq(5),
  );
  // Drain the projection notification and its possible frame retirement.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(session.getSnapshot().pendingSubmissions[0]?.requestId).toBe(submission.requestId);
  expect(onRetire).not.toHaveBeenCalled();
});

it("does not retire a local echo when another client's message is queued", async () => {
  const { session, onRetire, submission, message } = fixture();
  session.projections.applyLive(
    "inbox",
    {
      "next-turn": [{ ...message, source: { kind: "user", rpcId: "desktop-message" } }],
      "next-step": [],
    },
    SessionSeq(5),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(session.getSnapshot().pendingSubmissions[0]?.requestId).toBe(submission.requestId);
  expect(onRetire).not.toHaveBeenCalled();
});
