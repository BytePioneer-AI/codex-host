import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { questionDecision, NativeInteractions } = require("../assets/companion/interactions.cjs");
const { DesktopService } = require("../assets/companion/service.cjs");
const questions = [
  {
    header: "验收",
    question: "是否继续？",
    options: [{ label: "继续" }, { label: "停止" }],
    multiSelect: false,
  },
];
const plan = {
  id: "plan",
  task_id: "task",
  confirm_info: {
    confirm_status: "unconfirmed",
    auto_confirm: false,
    interaction_instance_id: "instance",
  },
  tool_call_info: {
    name: "AskUserQuestion",
    params: { questions, answers: [{ selected_options: ["继续"] }] },
  },
};
const reply = {
  chat_session_id: "session",
  message_id: "assistant",
  role: "assistant",
  status: "in_progress",
  reply_to_message_id: "user",
  content: JSON.stringify({ messages: [{ type: "plan_item", plan_item: plan }] }),
};
const snapshot = { sessionId: "session", messageId: "user", plan };
const input = {
  kind: "question",
  sessionId: "session",
  messageId: "user",
  planItemId: "plan",
  interactionId: "instance",
  answers: [["停止"]],
};

describe("TRAE CN native question response validation", () => {
  it("constructs the native decision from event-owned state and the explicit reply", () => {
    const data = questionDecision(snapshot, input);
    expect(data).toMatchObject({
      chat_session_id: "session",
      plan_item_id: "plan",
      interaction_instance_id: "instance",
      type: "tool_confirm",
      tool_name: "AskUserQuestion",
      decision: "confirm",
    });
    expect(JSON.parse(data.params)).toEqual({
      questions,
      answers: [{ selected_options: ["停止"] }],
    });
  });

  it("maps one free-form other answer using the native menu convention", () => {
    const data = questionDecision(snapshot, { ...input, answers: [["稍后再验收"]] });
    expect(JSON.parse(data.params).answers).toEqual([
      { selected_options: ["__other__"], custom_input: "稍后再验收" },
    ]);
  });

  it("skips the question explicitly without submitting prefilled native answers", () => {
    expect(questionDecision(snapshot, { ...input, cancelled: true, answers: undefined })).toEqual({
      chat_session_id: "session",
      plan_item_id: "plan",
      interaction_instance_id: "instance",
      type: "tool_confirm",
      tool_name: "AskUserQuestion",
      decision: "skip",
    });
  });

  it("preserves multiple native selections", () => {
    const current = {
      ...snapshot,
      plan: {
        ...plan,
        tool_call_info: {
          ...plan.tool_call_info,
          params: { questions: [{ ...questions[0], multiSelect: true }] },
        },
      },
    };
    const data = questionDecision(current, { ...input, answers: [["继续", "停止"]] });
    expect(JSON.parse(data.params).answers).toEqual([{ selected_options: ["继续", "停止"] }]);
  });

  it("rejects superseded instances, foreign messages and completed native tasks", () => {
    expect(() => questionDecision(snapshot, { ...input, interactionId: "stale" })).toThrow(
      "superseded",
    );
    expect(() => questionDecision(snapshot, { ...input, messageId: "another" })).toThrow(
      "no longer active",
    );
    expect(() => questionDecision(undefined, input)).toThrow("no longer active");
  });

  it("rejects empty answers, duplicate choices and multiple answers for a single choice", () => {
    for (const answers of [[], [[]], [["继续", "继续"]], [["继续", "停止"]]])
      expect(() => questionDecision(snapshot, { ...input, answers })).toThrow();
  });
});

function setup() {
  const call = vi.fn<(service: string, method: string, data?: unknown) => Promise<unknown>>(
    async (_service, method) => {
      if (method === "get_chat_session")
        return { chat_session_id: "session", local_project_id: "project", status: 3 };
      if (method === "get_or_create_project_v2")
        return { project_id: "project", workspace_folders: ["/workspace"] };
      if (method === "get_messages") return { items: [reply] };
      return undefined;
    },
  );
  const service = new DesktopService({ call }, { name: "Trae CN" }, ["/workspace"]);
  service.interactions.observe("session", {
    event: "plan_item",
    payload: { ...plan, reply_to_message_id: "user" },
  });
  return { call, service };
}

describe("TRAE CN question response admission", () => {
  it("allows only one write for concurrent answers to the same instance", async () => {
    const { call, service } = setup();
    const results = await Promise.allSettled([
      service.call("respond", input),
      service.call("respond", input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(call.mock.calls.filter((args) => args[1] === "send_user_decision")).toHaveLength(1);
  });

  it("does not reopen an instance after an uncertain response receipt", async () => {
    const { call, service } = setup();
    const original = call.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    call.mockImplementation(async (...args) => {
      if (args[1] === "send_user_decision")
        throw Object.assign(new Error("Receipt lost"), { code: "unavailable" });
      return original(...args);
    });
    await expect(service.call("respond", input)).rejects.toThrow("Receipt lost");
    await expect(service.call("respond", input)).rejects.toMatchObject({ code: "invalidState" });
    expect(call.mock.calls.filter((args) => args[1] === "send_user_decision")).toHaveLength(1);
  });
});

describe("TRAE CN native live interaction ownership", () => {
  it("invalidates the previous instance on replacement, task completion and observer transport loss", () => {
    const interactions = new NativeInteractions();
    const event = { event: "plan_item", payload: { ...plan, reply_to_message_id: "user" } };
    interactions.observe("session", event);
    expect(questionDecision(interactions.current("session", "user", "plan"), input).decision).toBe(
      "confirm",
    );
    interactions.observe("session", {
      ...event,
      payload: {
        ...event.payload,
        confirm_info: { ...plan.confirm_info, interaction_instance_id: "new-instance" },
      },
    });
    expect(() => questionDecision(interactions.current("session", "user", "plan"), input)).toThrow(
      "superseded",
    );
    interactions.observe("session", { event: "done", payload: { status: "completed" } });
    expect(interactions.current("session", "user", "plan")).toBeUndefined();
    interactions.observe("session", event);
    interactions.expire("session");
    expect(interactions.current("session", "user", "plan")).toBeUndefined();
  });

  it("does not retain native account/context data and clears auto-confirmed requests", () => {
    const interactions = new NativeInteractions();
    interactions.observe("session", {
      event: "metadata",
      payload: { reply_to_message_id: "user", user_message_context: { token: "private-context" } },
    });
    interactions.observe("session", {
      event: "plan_item",
      payload: { ...plan, reply_to_message_id: "user", native_account: "private-account" },
    });
    expect(JSON.stringify(interactions.current("session", "user", "plan"))).not.toMatch(
      /private-context|private-account/,
    );
    interactions.observe("session", {
      event: "plan_item",
      payload: {
        ...plan,
        reply_to_message_id: "user",
        confirm_info: { ...plan.confirm_info, auto_confirm: true },
      },
    });
    expect(interactions.current("session", "user", "plan")).toBeUndefined();
  });
});
