import type { AttachmentId, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { WEB_ACTIVE_TURN_PROJECTION } from "@codexhost/shared-contracts";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { MessageId } from "@deepseek-ai/dsh-llm/brand";
import { expect, it, vi } from "vitest";
import { TYPERT_REMOTE } from "../generated/remote.js";
import { ProjectionValueStore } from "../src/client/sessions/projection-store.ts";
import type { SessionRemotes } from "../src/client/sessions/remotes.ts";
import { Session } from "../src/client/sessions/session.ts";

// The browser export is a loader bundle. Load the same Gateway source in Node.
vi.mock("@deepseek-ai/dsh-api-gateway/client", () => import("../../gateway/src/client/index.ts"));

const sessionId = SessionId("thread");
const text = "Steer the visible Turn";
const content = [{ type: "text" as const, text }];

function fixture(id = sessionId) {
  const prompt = vi
    .fn<SessionRemotes["session"]["prompt"]>()
    .mockResolvedValue({ ok: true, value: { accepted: true } });
  const projections = new ProjectionValueStore();
  const session = new Session(id, { session: { prompt } } as unknown as SessionRemotes, {
    projections,
  });
  return { prompt, projections, session };
}

it("rejects a prepared steer after its Session retires the submission", async () => {
  const { prompt, projections, session } = fixture();
  projections.apply(WEB_ACTIVE_TURN_PROJECTION, "original-turn", SessionSeq(1));
  const onRetire = vi.fn();
  const submission = session.beginSubmission({ mode: "steer", text, attachments: [], onRetire });

  await session.dispose();
  projections.apply(WEB_ACTIVE_TURN_PROJECTION, "replacement-turn", SessionSeq(2));

  await expect(
    session.prompt(content, "steer", undefined, submission.requestId),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "remote/turn-changed" },
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(onRetire).toHaveBeenCalledExactlyOnceWith({ reason: "failed" });
});

it.each(["original-turn", null])(
  "sends the registered target %s even when the projection has changed",
  async (target) => {
    const { prompt, projections, session } = fixture();
    projections.apply(WEB_ACTIVE_TURN_PROJECTION, target, SessionSeq(1));
    const submission = session.beginSubmission({ mode: "steer", text, attachments: [] });
    projections.apply(WEB_ACTIVE_TURN_PROJECTION, "replacement-turn", SessionSeq(2));

    await session.prompt(content, "steer", undefined, submission.requestId);
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedTurnId: target }),
      undefined,
    );
    await session.dispose();
  },
);

it("uses the current projection for a direct steer without a registered submission", async () => {
  const { prompt, projections, session } = fixture();
  projections.apply(WEB_ACTIVE_TURN_PROJECTION, "current-turn", SessionSeq(1));

  await session.prompt(content, "steer");
  expect(prompt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ expectedTurnId: "current-turn" }),
    undefined,
  );
  await session.dispose();
});

it("keeps the first echo across canonical binding and draft disposal", async () => {
  const { session: draft } = fixture(SessionId("draft-thread"));
  const { session: canonical } = fixture(SessionId("canonical-thread"));
  const retired: unknown[] = [];
  const submission = draft.beginSubmission({
    mode: "queue",
    text: "First message",
    attachments: [],
    onRetire: (result) => retired.push(result),
  });
  const echo = draft.getSnapshot().pendingSubmissions[0];

  draft.handoffSubmissions(canonical);
  draft.handoffSubmissions(canonical);
  expect(draft.getSnapshot().pendingSubmissions).toEqual([echo]);
  expect(canonical.getSnapshot().pendingSubmissions).toEqual([echo]);
  await draft.dispose();
  expect(canonical.getSnapshot().pendingSubmissions).toEqual([echo]);
  expect(retired).toEqual([]);

  // A pre-prompt failure still reaches the new owner, including after draft disposal.
  submission.abandon();
  expect(canonical.getSnapshot().pendingSubmissions).toEqual([]);
  expect(retired).toEqual([{ reason: "failed" }]);
  await canonical.dispose();
  expect(retired).toHaveLength(1);
});

it("routes an in-flight prompt rejection to its canonical echo", async () => {
  const { session: draft, prompt } = fixture(SessionId("draft-thread"));
  const { session: canonical } = fixture(SessionId("canonical-thread"));
  let reject!: (value: Awaited<ReturnType<typeof prompt>>) => void;
  prompt.mockReturnValue(
    new Promise((resolve) => {
      reject = resolve;
    }),
  );
  const submission = draft.beginSubmission({ mode: "queue", text, attachments: [] });
  const sending = draft.prompt(content, "queue", undefined, submission.requestId);
  draft.handoffSubmissions(canonical);
  await draft.dispose();

  reject({ ok: false, error: new RemoteError("test/rejected", "Rejected", {}) });
  await sending;
  expect(canonical.getSnapshot().pendingSubmissions).toEqual([]);
  expect(canonical.getSnapshot().promptError?.error.code).toBe("test/rejected");
  await canonical.dispose();
});

it("retires a transferred echo once when the canonical history already contains its message", async () => {
  const { session: draft, prompt } = fixture(SessionId("draft-thread"));
  const { session: canonical } = fixture(SessionId("canonical-thread"));
  let complete!: (value: Awaited<ReturnType<typeof prompt>>) => void;
  prompt.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const retired: unknown[] = [];
  const submission = draft.beginSubmission({
    mode: "queue",
    text,
    attachments: [],
    onRetire: (result) => retired.push(result),
  });
  const sending = draft.prompt(content, "queue", undefined, submission.requestId);
  canonical.eventSource.replace(
    [
      {
        type: "event",
        event: {
          type: "user/message",
          seq: SessionSeq(0),
          time: 1,
          data: {
            id: MessageId("message"),
            role: "user",
            content,
            source: { kind: "user", rpcId: submission.requestId },
          },
        },
      },
    ],
    false,
  );

  draft.handoffSubmissions(canonical);
  await draft.dispose();
  await vi.waitFor(() => expect(canonical.getSnapshot().pendingSubmissions).toEqual([]));
  expect(retired).toEqual([{ reason: "observed", attachments: [] }]);
  canonical.eventSource.replace([], false);
  complete({ ok: false, error: new RemoteError("remote/outcome-unknown", "Disconnected", {}) });
  await expect(sending).resolves.toEqual({ ok: true, value: { accepted: true } });
  expect(canonical.getSnapshot().promptError).toBeNull();
  submission.abandon();
  await canonical.dispose();
  expect(retired).toHaveLength(1);
});

it("preserves the remote delivery fields in the strict prompt wire codecs", () => {
  const prompt = TYPERT_REMOTE.descriptors.find(
    (descriptor) => descriptor.namespace === "session" && descriptor.method === "prompt",
  );
  const request = prompt?.parameters[0]?.codec;
  const receipt = prompt?.result;
  if (request?.mode !== "strict" || receipt?.mode !== "strict") throw new Error("missing codec");

  const input = { requestId: "request", sessionId, mode: "steer", content };
  expect(request.create().parse(input)).toEqual(input);
  expect(request.create().parse({ ...input, expectedTurnId: "original-turn" })).toEqual({
    ...input,
    expectedTurnId: "original-turn",
  });
  expect(request.create().parse({ ...input, expectedTurnId: null })).toEqual({
    ...input,
    expectedTurnId: null,
  });
  const idle = { ...input, mode: "queue", sendWhenIdle: true };
  expect(request.create().parse(idle)).toEqual(idle);
  expect(receipt.create().parse({ accepted: true, queueStartUnconfirmed: true })).toEqual({
    accepted: true,
    queueStartUnconfirmed: true,
  });
});

it("fires onObserved synchronously on durable user/message before the echo retirement frame", async () => {
  const frames: FrameRequestCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;

  const peerAttachment: ImageAttachmentRef = {
    attachmentId: "peer-image:sha256-deadbeef" as AttachmentId,
    name: "image-1.webp",
    mediaType: "image/png",
    bytes: 0,
    width: 64,
    height: 64,
  };

  let deliverLive!: (event: unknown) => void;
  let releaseStream!: () => void;
  const liveEvent = new Promise<unknown>((resolve) => {
    deliverLive = resolve;
  });
  const keepOpen = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });

  const makeStream = <Frame>(open: (signal: AbortSignal) => AsyncIterable<Frame>) => {
    const controller = new AbortController();
    return {
      async *[Symbol.asyncIterator]() {
        for await (const value of open(controller.signal)) {
          yield { value, generation: 1, accept: () => {} };
        }
      },
      dispose: vi.fn(async () => {
        controller.abort();
      }),
    };
  };

  const session = new Session(sessionId, {
    $stream: ({ open }: { open: (signal: AbortSignal) => AsyncIterable<unknown> }) =>
      makeStream(open),
    session: {
      prompt: vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
      follow: async function* (_req: unknown, signal: AbortSignal) {
        yield {
          type: "snapshot",
          epoch: "ep-1",
          cursor: -1,
          records: [],
          hasMore: false,
          assistantStream: { revision: 0, blocks: [] },
        };
        const event = await liveEvent;
        yield {
          type: "event",
          event,
        };
        await Promise.race([
          keepOpen,
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      },
    },
  } as unknown as SessionRemotes);

  try {
    await session.open();
    const onObserved = vi.fn();
    const onRetire = vi.fn();
    const submission = session.beginSubmission({
      mode: "queue",
      text: "check remote image",
      attachments: [],
      onObserved,
      onRetire,
    });

    deliverLive({
      type: "user/message",
      seq: SessionSeq(0),
      time: 2,
      surfaceOp: "append",
      data: {
        id: MessageId("msg-peer-1"),
        role: "user",
        content: [
          { type: "image", attachment: peerAttachment },
          { type: "text", text: "check remote image" },
        ],
        source: { kind: "user", rpcId: submission.requestId },
      },
    });

    await vi.waitFor(() => {
      expect(session.eventSource.getSnapshot().entries).toHaveLength(1);
    });

    // Before the scheduled retirement animation frame runs, onObserved has already fired
    // synchronously while the echo remains in pendingSubmissions until onRetire.
    expect(onObserved).toHaveBeenCalledExactlyOnceWith([peerAttachment]);
    expect(onRetire).not.toHaveBeenCalled();
    expect(session.getSnapshot().pendingSubmissions).toHaveLength(1);
    expect(frames.length).toBeGreaterThanOrEqual(1);

    // Flushing animation frames retires the echo once without firing onObserved a second time.
    while (frames.length > 0) frames.shift()!(16);
    expect(onObserved).toHaveBeenCalledTimes(1);
    expect(onRetire).toHaveBeenCalledExactlyOnceWith({
      reason: "observed",
      attachments: [peerAttachment],
    });
    expect(session.getSnapshot().pendingSubmissions).toEqual([]);
  } finally {
    releaseStream();
    await session.dispose();
    globalThis.requestAnimationFrame = originalRaf;
  }
});
