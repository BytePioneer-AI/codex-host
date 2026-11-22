import { WEB_ACTIVE_TURN_PROJECTION } from "@codexhost/shared-contracts";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
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

function fixture() {
  const prompt = vi
    .fn<SessionRemotes["session"]["prompt"]>()
    .mockResolvedValue({ ok: true, value: { accepted: true } });
  const projections = new ProjectionValueStore();
  const session = new Session(sessionId, { session: { prompt } } as unknown as SessionRemotes, {
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
