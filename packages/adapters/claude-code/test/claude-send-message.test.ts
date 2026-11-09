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

function toolResult(id: string, native: Record<string, unknown>, isError = false) {
  return {
    ...message("user", `result-${id}`, [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [{ type: "text", text: JSON.stringify(native) }],
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

function spawn(agentId: string) {
  return [
    toolCall("Agent", `spawn-${agentId}`, { prompt: "work", run_in_background: true }),
    toolResult(`spawn-${agentId}`, { isAsync: true, agentId }),
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

describe("Claude SendMessage occupancy", () => {
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
