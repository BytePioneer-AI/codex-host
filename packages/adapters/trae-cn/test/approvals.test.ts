import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { NativeInteractions } from "../src/interactions.js";
const { approvalDecision } = createRequire(import.meta.url)("../assets/companion/interactions.cjs");

const plan = {
  id: "plan",
  task_id: "task",
  reply_to_message_id: "user",
  confirm_info: {
    confirm_status: "unconfirmed",
    interaction_instance_id: "instance",
    auto_confirm: false,
    permission_request_reason: "sandbox_execute_failure",
  },
  tool_call_info: { name: "RunCommand", params: { command: "echo acceptance", cwd: "/workspace" } },
};
const current = { sessionId: "session", messageId: "user", plan };
const input = {
  kind: "approval",
  sessionId: "session",
  messageId: "user",
  planItemId: "plan",
  interactionId: "instance",
  action: "allowOnce",
};

describe("TRAE CN command approvals", () => {
  it("uses the native execution-only decision without granting persistent permissions", () => {
    expect(approvalDecision(current, input)).toEqual({
      chat_session_id: "session",
      task_id: "task",
      plan_item_id: "plan",
      tool_name: "RunCommand",
      interaction_instance_id: "instance",
      type: "tool_confirm",
      decision: "confirm",
      permission_scope: "execution",
    });
    expect(approvalDecision(current, { ...input, action: "deny" })).toMatchObject({
      decision: "skip",
      permission_scope: "none",
    });
    for (const change of [
      { action: "allowAlways" },
      { interactionId: "stale" },
      { messageId: "other" },
      { sessionId: "other" },
      { planItemId: "other" },
    ])
      expect(() => approvalDecision(current, { ...input, ...change })).toThrow();
    expect(() => approvalDecision(undefined, input)).toThrow();
    expect(() =>
      approvalDecision({ ...current, plan: { ...plan, task_id: undefined } }, input),
    ).toThrow("task identity");
    expect(() =>
      approvalDecision(
        {
          ...current,
          plan: { ...plan, confirm_info: { ...plan.confirm_info, confirm_status: "confirmed" } },
        },
        input,
      ),
    ).toThrow();
  });
  it("publishes once, validates the action and closes once after a native response", async () => {
    const outputs: HarnessOutput[] = [];
    const call = vi.fn(async () => ({ accepted: true }));
    const interactions = new NativeInteractions(
      { sessionId: "session", messageId: "user", turnId: hostTurnIdSchema.parse("turn") },
      { call },
      (o) => outputs.push(o),
    );
    interactions.observe(plan);
    interactions.observe(plan);
    const output = outputs[0];
    if (output?.kind !== "interaction") throw new Error("No approval");
    expect(output.interaction).toMatchObject({
      type: "approval",
      description: "echo acceptance\ncwd: /workspace\nsandbox_execute_failure",
      actions: [
        { id: "allowOnce", effect: "allowOnce" },
        { id: "deny", effect: "deny" },
      ],
    });
    const command = {
      type: "interaction.respond" as const,
      interactionId: output.interaction.interactionId,
      response: { type: "approval" as const, actionId: "allowAlways" },
    };
    expect(await interactions.respond(command)).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(call).not.toHaveBeenCalled();
    expect(
      await interactions.respond({
        ...command,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).toEqual({ ok: true, value: { accepted: true } });
    expect(call).toHaveBeenCalledExactlyOnceWith("respond", {
      kind: "approval",
      sessionId: "session",
      messageId: "user",
      planItemId: "plan",
      interactionId: "instance",
      action: "allowOnce",
    });
    interactions.observe(plan);
    interactions.close("expired");
    expect(outputs).toHaveLength(2);
    expect(outputs[1]).toMatchObject({
      event: { type: "interaction.closed", reason: "responded" },
    });
    expect(await interactions.respond(command)).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
  it("expires on native skip and refuses unimplemented confirmation kinds", () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new NativeInteractions(
      { sessionId: "session", messageId: "user", turnId: hostTurnIdSchema.parse("turn") },
      { call: vi.fn() },
      (o) => outputs.push(o),
    );
    interactions.observe(plan);
    interactions.observe({
      ...plan,
      confirm_info: { ...plan.confirm_info, confirm_status: "skipped" },
    });
    expect(outputs[1]).toMatchObject({
      event: { type: "interaction.closed", reason: "cancelled" },
    });
    expect(() =>
      interactions.observe({ ...plan, tool_call_info: { name: "unknown", params: {} } }),
    ).toThrow("not implemented");
  });
});
