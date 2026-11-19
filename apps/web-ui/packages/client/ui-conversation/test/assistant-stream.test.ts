import { LlmAttemptId, MessageId } from "@deepseek-ai/dsh-llm/brand";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";
import { expect, it } from "vitest";
import type { SessionLiveEventEntry } from "../../../api/session-controller/src/client/contract/events.ts";
import { ClientAssistantStream } from "../../../api/session-controller/src/client/sessions/assistant-stream.ts";
import type { ChatNode } from "../../ui-chat/src/client/contract/chat-nodes.ts";
import { assistantDefinition } from "../../ui-chat/src/client/conversation-nodes/assistant.ts";
import { chatViewDefinition } from "../../ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts";
import { ConversationNodeAssembler } from "../src/client/conversation/assembler.ts";

it.each([
  { path: "live frames", baselineSize: 0 },
  { path: "a reconnect baseline and live frames", baselineSize: 6_000 },
])("keeps every fragment of a long Web reply from $path", ({ baselineSize }) => {
  const origin = 2 ** 40;
  const turn = 2;
  const step = 1;
  const attemptId = LlmAttemptId("long-reply");
  const startedAfterSeq = SessionSeq(origin + 1);
  const entries: SessionLiveEventEntry[] = [
    {
      type: "event",
      event: { type: "turn/start", seq: SessionSeq(origin), time: 1, data: { turn } },
    },
    {
      type: "event",
      event: { type: "step/start", seq: startedAfterSeq, time: 2, data: { turn, step } },
    },
  ];
  const texts = Array.from({ length: 12_000 }, (_, index) => ` ${index}`);
  const expected = texts.join("");
  const stream = new ClientAssistantStream();
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  );
  assembler.activateTarget("chat");

  if (baselineSize > 0) {
    assembler.replaceWindow(
      stream.replace(entries, {
        revision: baselineSize + 1,
        activeAttempt: {
          attemptId,
          startedAfterSeq,
          turn,
          step,
          nextIndex: baselineSize,
          stream: [
            {
              type: "text-chunks",
              index: 0,
              time0: 3,
              dt: Array.from({ length: baselineSize - 1 }, () => 1),
              texts: texts.slice(0, baselineSize),
            },
          ],
        },
      }),
      true,
    );
  } else {
    assembler.replaceWindow(stream.replace(entries), true);
    stream.acceptFrame({ type: "start", revision: 1, attemptId, startedAfterSeq, turn, step });
  }
  for (let index = baselineSize; index < texts.length; index++) {
    const result = stream.acceptFrame({
      type: "chunk",
      revision: index + 2,
      attemptId,
      index,
      time: index + 3,
      chunk: { type: "text-delta", index: 0, text: texts[index]! },
    });
    if (result?.type !== "transient") throw new Error("Expected a live assistant chunk");
    assembler.append(result.entry);
  }

  function reply() {
    assembler.flush();
    const chat = assembler.get("chat");
    const node = chat?.nodes.values().find((node) => node.kind === "assistant-step") as
      ChatNode<"assistant-step"> | undefined;
    if (!node) throw new Error("Expected the assistant reply in the Chat snapshot");
    const text = node.data.blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("");
    return { text, status: node.data.status, anchor: node.anchorSeq };
  }
  const live = reply();
  expect(live.text.length).toBe(expected.length);
  expect(live).toMatchObject({ text: expected, status: "running" });

  assembler.prepend(
    [
      {
        type: "event",
        event: { type: "turn/start", seq: SessionSeq(origin - 2), time: 0, data: { turn: 1 } },
      },
      {
        type: "event",
        event: {
          type: "turn/end",
          seq: SessionSeq(origin - 1),
          time: 0,
          data: { turn: 1, reason: { kind: "completed" } },
        },
      },
    ],
    false,
  );
  expect(reply()).toEqual(live);
  expect(assembler.get("chat")?.timeline.turns.get(turn)?.steps[0]?.start?.seq).toBe(
    startedAfterSeq,
  );

  const messageSeq = SessionSeq(origin + 2);
  stream.acceptDurable({
    type: "event",
    event: {
      type: "assistant/message",
      seq: messageSeq,
      time: texts.length + 3,
      surfaceOp: "append",
      data: {
        turn,
        step,
        stream: [],
        message: {
          id: MessageId("reply"),
          role: "assistant",
          source: { kind: "model", provider: "test", model: "test" },
          content: [{ type: "text", text: expected }],
        },
      },
    },
  });
  const result = stream.acceptFrame({
    type: "end",
    revision: texts.length + 2,
    attemptId,
    index: texts.length,
    outcome: { kind: "committed", eventType: "assistant/message", seq: messageSeq },
  });
  if (result?.type !== "publish") throw new Error("Expected a settled assistant reply");
  assembler.append(result.entry);
  expect(reply()).toEqual({ ...live, status: "settled" });

  const closed = stream.acceptDurable({
    type: "event",
    event: {
      type: "step/end",
      seq: SessionSeq(origin + 3),
      time: texts.length + 4,
      data: { turn, step },
    },
  });
  if (closed?.type !== "publish" || closed.retireAttemptId !== attemptId) {
    throw new Error("Expected the completed step to retire the live attempt");
  }
  assembler.append(closed.entry);
  assembler.settleAssistant(closed.retireAttemptId);
  expect(reply()).toMatchObject({ text: expected, status: "settled" });
});
