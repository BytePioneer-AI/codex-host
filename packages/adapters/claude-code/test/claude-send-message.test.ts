import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ClaudeCodeAdapter } from "../src/index.js";
import { ClaudeSdkTransport } from "../src/sdk-transport.js";
import { mapClaudeSnapshot } from "../src/claude-history.js";
import type { ClaudeAdapterDependencies } from "../src/transport.js";
import { FakeQuery } from "./fake-sdk-query.js";

type HostEvent = Extract<HarnessOutput, { kind: "event" }>["event"];
const sessionId = "00000000-0000-4000-8000-000000000001";

function message(type: "assistant" | "user", uuid: string, content: unknown) {
  return {
    type,
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: type, content },
  };
}

function toolCall(name: string, id: string, input: Record<string, unknown>) {
  return message("assistant", `call-${id}`, [{ type: "tool_use", name, id, input }]);
}

function toolResult(
  id: string,
  native: Record<string, unknown>,
  isError = false,
  text = JSON.stringify(native),
) {
  return {
    ...message("user", `result-${id}`, [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [{ type: "text", text }],
        ...(isError ? { is_error: true } : {}),
      },
    ]),
    tool_use_result: native,
  };
}

function notification(agentId: string) {
  return message(
    "user",
    `notification-${agentId}`,
    `<task-notification><task-id>${agentId}</task-id><tool-use-id>spawn-${agentId}</tool-use-id><status>completed</status><summary>Agent finished</summary></task-notification>`,
  );
}

function answer(uuid: string) {
  const value = message("assistant", uuid, [{ type: "text", text: "Root finished" }]);
  return { ...value, message: { ...value.message, stop_reason: "end_turn" } };
}

function spawn(agentId: string, name?: string) {
  return [
    toolCall("Agent", `spawn-${agentId}`, {
      ...(name ? { name } : {}),
      prompt: "work",
      run_in_background: true,
    }),
    toolResult(
      `spawn-${agentId}`,
      { isAsync: true, status: "async_launched", agentId },
      false,
      `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
    ),
  ];
}

function textTurn(turnId: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(turnId),
    input: [{ type: "text" as const, text: "work" }],
  };
}

/** Real Adapter and SDK transport, with no CLI or model calls. */
async function liveSession() {
  const query = new FakeQuery();
  let uuid = 0;
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID: () => (++uuid === 1 ? sessionId : `claude-id-${uuid}`),
    bypassPermissionsAvailable: () => true,
    inspectInstallation: () => undefined,
    createInspector: () => ({
      close: async () => undefined,
      inspect: async () => ({
        models: [{ value: "default", displayName: "Default", description: "Default" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      }),
    }),
    deleteSession: async () => undefined,
    forkSession: async () => ({ sessionId: "derived-session" }),
    getSessionInfo: async () => ({ cwd: "/synthetic" }),
    readSessionMessages: async () => [],
    readSubagentMessages: async () => [],
    createTransport: (input) =>
      new ClaudeSdkTransport({
        ...input,
        sessionId,
        command: process.execPath,
        closeTimeoutMs: 100,
        queryFactory: () => query as unknown as Query,
      }),
  };
  const adapter = new ClaudeCodeAdapter(
    { closeTimeoutMs: 100, continuationQuiescenceMs: 20 },
    dependencies,
  );
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  const events: HostEvent[] = [];
  const drained = (async () => {
    for await (const output of session.outputs)
      if (output.kind === "event") events.push(output.event);
  })();
  return {
    session,
    events,
    push(...messages: unknown[]) {
      for (const value of messages) query.push(value as SDKMessage);
    },
    result() {
      query.push({
        type: "result",
        session_id: sessionId,
        subtype: "success",
        is_error: false,
        terminal_reason: "completed",
      } as unknown as SDKMessage);
    },
    async close() {
      await session.close();
      await drained;
    },
  };
}

function completions(events: HostEvent[]) {
  return events.filter((event) => event.type === "turn.completed" && event.turnId === "root");
}

const refusal = { success: false, message: "Agent was stopped by the user and won't be resumed." };

const resumedId = "a45fecc62e5c2aff6";
const queuedId = "ae463978a2c44bbd5";
const resumedText = {
  success: true,
  message: "Resuming agent worker",
  resumedAgentId: resumedId,
  pin: { id: resumedId, name: "worker", ref: "40dd34" },
};
const resumed = { ...resumedText, revivedAgentId: resumedId };
const queued = {
  success: true,
  message:
    "Message queued for delivery to worker at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.",
  pin: { id: queuedId, name: "worker", ref: "8cb3b3" },
};

function taskNotification(taskId: string) {
  return { type: "system", subtype: "task_notification", task_id: taskId, status: "completed" };
}

describe("Claude SendMessage occupancy", () => {
  it.each([
    { mode: "resumed", agentId: resumedId, result: resumed },
    { mode: "queued", agentId: queuedId, result: queued },
  ])("settles a named $mode send by native ID", async ({ mode, agentId, result }) => {
    const live = await liveSession();
    try {
      if (mode === "resumed") {
        await live.session.execute(textTurn("initial"));
        live.push(...spawn(agentId, "worker"), taskNotification(agentId), answer("initial-answer"));
        live.result();
        await vi.waitFor(() =>
          expect(live.events).toContainEqual(
            expect.objectContaining({ type: "turn.completed", turnId: "initial" }),
          ),
        );
      }
      await live.session.execute(textTurn("root"));
      // The queued Agent is running, but its name was not observed at launch.
      if (mode === "queued") live.push(...spawn(agentId));
      live.push(toolCall("SendMessage", "send", { to: "worker", message: "continue" }));
      if (mode === "resumed") {
        await vi.waitFor(() =>
          expect(live.events).toContainEqual(
            expect.objectContaining({
              type: "item.started",
              item: expect.objectContaining({
                operation: "send",
                subagents: [expect.objectContaining({ nativeSubagentId: agentId })],
              }),
            }),
          ),
        );
      }
      live.push(
        toolResult(
          "send",
          result,
          false,
          JSON.stringify(mode === "resumed" ? resumedText : queued),
        ),
        answer("root-answer"),
      );
      live.result();
      await vi.waitFor(() =>
        expect(live.events).toContainEqual(
          expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({
                operation: "send",
                subagents: [
                  expect.objectContaining({ nativeSubagentId: agentId, status: "running" }),
                ],
              }),
            }),
          }),
        ),
      );
      if (mode === "queued") {
        expect(live.events).toContainEqual({
          type: "subagent.state.changed",
          nativeSubagentId: "worker",
          status: "completed",
        });
      }
      await expect(live.session.execute(textTurn("early"))).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      live.push(taskNotification(agentId), answer("continuation"));
      live.result();
      await vi.waitFor(() => expect(completions(live.events)).toHaveLength(1));
      expect(live.events).toContainEqual(
        expect.objectContaining({
          type: "subagent.state.changed",
          nativeSubagentId: agentId,
          status: "completed",
        }),
      );
      await expect(live.session.execute(textTurn("next"))).resolves.toMatchObject({ ok: true });
      live.push(answer("next-answer"));
      live.result();
    } finally {
      await live.close();
    }
  });

  it("retires an unknown named send target on task_started before the tool result", async () => {
    const live = await liveSession();
    const callId = "toolu_named_send";
    try {
      await expect(live.session.execute(textTurn("root"))).resolves.toMatchObject({ ok: true });
      // Claude Code 2.1.328, resumed send with no cached name binding in this transport.
      live.push(
        toolCall("SendMessage", callId, {
          to: "worker",
          message: "Reply PONG.",
          type: "message",
          recipient: "worker",
          recipient_kind: "name",
          content: "Reply PONG.",
        }),
        {
          type: "system",
          subtype: "task_started",
          session_id: sessionId,
          task_id: resumedId,
          tool_use_id: callId,
        },
      );
      await vi.waitFor(() =>
        expect(live.events).toContainEqual(
          expect.objectContaining({
            type: "item.updated",
            update: {
              type: "subagents.replace",
              subagents: [
                expect.objectContaining({ nativeSubagentId: resumedId, status: "running" }),
              ],
            },
          }),
        ),
      );
      expect(live.events).toContainEqual(
        expect.objectContaining({
          type: "item.started",
          item: expect.objectContaining({
            operation: "send",
            subagents: [expect.objectContaining({ nativeSubagentId: "worker", status: "running" })],
          }),
        }),
      );
      const retiredName = {
        type: "subagent.state.changed",
        nativeSubagentId: "worker",
        status: "completed",
      };
      // No tool result has been delivered, so completion cannot retire the provisional child.
      expect(live.events).toContainEqual(retiredName);

      live.push(toolResult(callId, resumed, false, JSON.stringify(resumedText)), answer("sent"));
      live.result();
      live.push({ ...taskNotification(resumedId), tool_use_id: callId }, answer("continuation"));
      live.result();
      await vi.waitFor(() => expect(completions(live.events)).toHaveLength(1));
      expect(live.events.filter((event) => event.type === "subagent.state.changed")).toEqual([
        retiredName,
        expect.objectContaining({ nativeSubagentId: resumedId, status: "completed" }),
      ]);
    } finally {
      await live.close();
    }
  });

  it.each([resumedText, queued])(
    "replays name bindings from a text-only $message result",
    (result) => {
      const agentId = result.pin.id;
      const firstSend = toolResult("send", result);
      const snapshot = mapClaudeSnapshot(
        [
          message("user", "first", "continue"),
          toolCall("SendMessage", "send", { to: "worker", message: "work" }),
          { ...firstSend, tool_use_result: undefined },
          notification(agentId),
          answer("first-answer"),
          message("user", "second", "again"),
          toolCall("SendMessage", "again", { to: "worker", message: "work" }),
          toolResult("again", { success: true }),
          answer("second-answer"),
          { ...notification(agentId), uuid: "second-notification" },
          answer("continuation"),
          notification("unrelated"),
          answer("autonomous"),
        ],
        sessionId,
      );
      expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
        "first",
        "second",
        "notification-unrelated",
      ]);
      expect(snapshot.turns[1]?.checkpoint?.checkpointId).toBe("continuation");
    },
  );

  it.each(
    (["none", "same-running", "other-running", "same-notified"] as const).flatMap((existing) =>
      [false, true].map((isError) => ({ existing, isError })),
    ),
  )(
    "does not manufacture or erase background work when a send fails ($existing, is_error=$isError)",
    async ({ existing, isError }) => {
      const live = await liveSession();
      try {
        await live.session.execute(textTurn("root"));
        const other = existing === "other-running";
        const agentId = other ? "other-agent" : "target-agent";
        if (existing !== "none") live.push(...spawn(agentId));
        if (existing === "same-notified") live.push(notification(agentId));
        live.push(
          toolCall("SendMessage", "send", { to: "target-agent", message: "continue" }),
          toolResult(
            "send",
            isError ? { message: "Delivery failed", agentId: "target-agent" } : refusal,
            isError,
          ),
          answer("root-answer"),
        );
        live.result();
        await vi.waitFor(() =>
          expect(live.events).toContainEqual(
            expect.objectContaining({
              type: "item.completed",
              snapshot: expect.objectContaining({
                item: expect.objectContaining({ type: "subagentDelegation", operation: "send" }),
                outcome: expect.objectContaining({ status: "failed" }),
              }),
            }),
          ),
        );
        if (existing === "same-running" || other) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          expect(completions(live.events)).toHaveLength(0);
          await expect(live.session.execute(textTurn("too-early"))).resolves.toMatchObject({
            ok: false,
            error: { code: "sessionBusy" },
          });
          live.push(notification(agentId), answer("continuation"));
          live.result();
        }
        await vi.waitFor(() => expect(completions(live.events)).toHaveLength(1));
        expect(completions(live.events)[0]).toMatchObject({ outcome: { status: "succeeded" } });
        await expect(live.session.execute(textTurn("next"))).resolves.toMatchObject({ ok: true });
        live.push(answer("next-answer"));
        live.result();
        await vi.waitFor(() =>
          expect(live.events).toContainEqual(
            expect.objectContaining({ type: "turn.completed", turnId: "next" }),
          ),
        );
        expect(completions(live.events)).toHaveLength(1);
      } finally {
        await live.close();
      }
    },
  );

  it.each([false, true])(
    "waits for a successful send's new work (previously notified=%s)",
    async (notified) => {
      const live = await liveSession();
      try {
        await live.session.execute(textTurn("root"));
        if (notified) live.push(...spawn("target-agent"), notification("target-agent"));
        live.push(
          toolCall("SendMessage", "send", { to: "target-agent", message: "continue" }),
          toolResult("send", { success: true }),
          answer("root-answer"),
        );
        live.result();
        await vi.waitFor(() =>
          expect(live.events).toContainEqual(
            expect.objectContaining({
              type: "item.completed",
              snapshot: expect.objectContaining({
                item: expect.objectContaining({ type: "subagentDelegation", operation: "send" }),
                outcome: { status: "succeeded" },
              }),
            }),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(completions(live.events)).toHaveLength(0);
        live.push(notification("target-agent"), answer("continuation"));
        live.result();
        await vi.waitFor(() => expect(completions(live.events)).toHaveLength(1));
      } finally {
        await live.close();
      }
    },
  );

  it.each([false, true])(
    "keeps successful send continuations in history (previously notified=%s)",
    (notified) => {
      const snapshot = mapClaudeSnapshot(
        [
          message("user", "root", "work"),
          ...(notified ? [...spawn("target-agent"), notification("target-agent")] : []),
          toolCall("SendMessage", "send", { to: "target-agent", message: "continue" }),
          toolResult("send", { success: true }),
          answer("root-answer"),
          { ...notification("target-agent"), uuid: "new-notification" },
          answer("continuation"),
          message("user", "next", "next"),
          answer("next-answer"),
        ],
        sessionId,
      );
      expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
        "root",
        "next",
      ]);
      expect(snapshot.turns[0]?.checkpoint?.checkpointId).toBe("continuation");
    },
  );

  it.each([false, true])(
    "keeps history continuation boundaries after a refused send (existing task=%s)",
    (existing) => {
      const history = [
        message("user", "root", "work"),
        ...(existing ? spawn("target-agent") : []),
        toolCall("SendMessage", "send", { to: "target-agent", message: "continue" }),
        toolResult("send", refusal),
        answer("root-answer"),
        notification("target-agent"),
        answer("continuation"),
      ];
      const snapshot = mapClaudeSnapshot(history, sessionId);
      expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual(
        existing ? ["root"] : ["root", "notification-target-agent"],
      );
      expect(snapshot.turns[0]?.items).toContainEqual(
        expect.objectContaining({
          item: expect.objectContaining({ type: "toolExecution", toolName: "SendMessage" }),
          outcome: expect.objectContaining({ status: "failed" }),
        }),
      );
    },
  );
});
