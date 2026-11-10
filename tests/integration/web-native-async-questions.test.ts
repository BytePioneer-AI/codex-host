import { expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { jsonValueSchema } from "@codexhost/shared-contracts";
import { ClientChannelEvents } from "../../packages/host-runtime/src/client-channel-events.js";
import {
  NativeClientChannel,
  type NativeClientReply,
} from "../../packages/host-runtime/src/native-client-channel.js";
import { ChInteractions } from "../../packages/web-server/src/ch-interactions.ts";
import { EventHub } from "../../packages/web-server/src/transport.ts";

const threadId = "native-async";
const questionId = JSON.stringify(["request_user_input_async", "call-native-question", 0]);

function fixture() {
  const items: JsonObject[] = [
    {
      id: "call-native-question",
      type: "agentMessage",
      delivery: "async",
      text: "Which direction?\n- Keep\n- Replace",
      questions: [{ title: "Which direction?", options: ["Keep", "Replace"] }],
    },
  ];
  const request = vi.fn(async (method: string, params: JsonObject): Promise<NativeClientReply> => {
    if (method === "thread/resume" || method === "thread/read")
      return {
        result: {
          thread: {
            id: threadId,
            cwd: "/synthetic",
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 1,
            status: { type: "active" },
          },
        },
      };
    if (method === "thread/turns/list")
      return {
        result: {
          data: [{ id: "active-turn", status: "inProgress", items: structuredClone(items) }],
          nextCursor: null,
        },
      };
    if (method === "turn/steer") return { result: { turnId: params.expectedTurnId ?? null } };
    throw new Error(`Unexpected native request ${method}`);
  });
  const native = new NativeClientChannel({
    events: new ClientChannelEvents(),
    request,
    respond: async () => {
      throw new Error("Async answers are user messages");
    },
  });
  const events = new EventHub("/synthetic");
  const invoke = vi.spyOn(events, "invoke");
  const error = vi.fn();
  const web = new ChInteractions(
    {
      subscribe: () => () => {},
      request: async <T>(method: string, params: Record<string, unknown>) => {
        const reply = await native.request(method, jsonValueSchema.parse(params) as JsonObject);
        if ("error" in reply) throw new Error(reply.error.message);
        return reply.result as T;
      },
      snapshot: (id, options = {}) => native.snapshot(id, options),
      respond: async (input) => ({
        resolved: await native.respond(
          input.requestId,
          input.threadId,
          jsonValueSchema.parse(input.result),
        ),
      }),
    },
    events,
    error,
  );
  return { items, request, native, events, invoke, error, web };
}

it.each(["Keep", "Use the existing behavior"])(
  "delivers the Web answer '%s' through the native async-question protocol",
  async (answer) => {
    const { native, events, invoke, request, web, error } = fixture();
    try {
      web.update(await native.snapshot(threadId, {}));
      expect(invoke).toHaveBeenCalledWith("user-questions/request", threadId, {
        questions: [
          {
            id: questionId,
            question: "Which direction?",
            options: [
              { label: "Keep", description: "" },
              { label: "Replace", description: "" },
            ],
            multiSelect: false,
            allowOther: true,
          },
        ],
      });
      const invocation = invoke.mock.results[0]?.value as
        ReturnType<EventHub["invoke"]> | undefined;
      if (!invocation) throw new Error("Web did not present the native question");
      events.settle({
        eventId: invocation.eventId,
        outcome: {
          kind: "resolved",
          value: {
            answers: [
              {
                id: questionId,
                ...(answer === "Keep" ? { selected: [answer] } : { custom: answer }),
              },
            ],
          },
        },
      });
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1),
      );
      const sent = request.mock.calls.find(([method]) => method === "turn/steer")?.[1];
      expect(sent).toMatchObject({ threadId, expectedTurnId: "active-turn" });
      const text = (sent?.input as JsonObject[])[0]?.text;
      expect(text).toBe(
        `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questionId, question: "Which direction?", answer }])}\n</send_user_message_question_reply>\n`,
      );
      web.update(await native.snapshot(threadId, {}));
      expect(invoke).toHaveBeenCalledOnce();
      expect(error.mock.calls.every(([, message]) => message === null)).toBe(true);
    } finally {
      web.clear();
    }
  },
);

it("skips a Web question without sending native input or reopening the card", async () => {
  const { native, events, invoke, request, web, error } = fixture();
  try {
    web.update(await native.snapshot(threadId, {}));
    const invocation = invoke.mock.results[0]?.value as ReturnType<EventHub["invoke"]> | undefined;
    if (!invocation) throw new Error("Web did not present the native question");
    events.settle({
      eventId: invocation.eventId,
      outcome: {
        kind: "resolved",
        value: { answers: [{ id: questionId, selected: [] }] },
      },
    });
    await vi.waitFor(() => expect(native.interactions(threadId)).toEqual([]));
    web.update(await native.snapshot(threadId, {}));
    expect(invoke).toHaveBeenCalledOnce();
    expect(
      request.mock.calls.some(([method]) => method === "turn/steer" || method === "turn/start"),
    ).toBe(false);
    expect(error.mock.calls.every(([, message]) => message === null)).toBe(true);
  } finally {
    web.clear();
  }
});

it("withdraws a Web card when the same async question is answered in Desktop", async () => {
  const { native, items, invoke, web } = fixture();
  try {
    web.update(await native.snapshot(threadId, {}));
    const invocation = invoke.mock.results[0]?.value as ReturnType<EventHub["invoke"]> | undefined;
    if (!invocation) throw new Error("Web did not present the native question");
    const cancelled = expect(invocation.result).rejects.toThrow("cancelled");
    items.push({
      id: "desktop-answer",
      type: "userMessage",
      content: [
        {
          type: "text",
          text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questionId, question: "Which direction?", answer: "Keep" }])}\n</send_user_message_question_reply>\n`,
        },
      ],
    });
    web.update(await native.snapshot(threadId, {}));
    await cancelled;
    expect(invoke).toHaveBeenCalledOnce();
  } finally {
    web.clear();
  }
});
