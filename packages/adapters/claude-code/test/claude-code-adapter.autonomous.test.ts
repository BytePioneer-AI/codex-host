import { describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ClaudeCodeAdapter } from "../src/index.js";
import { ClaudeSdkTransport } from "../src/sdk-transport.js";
import type { ClaudeAdapterDependencies } from "../src/transport.js";
import { FakeQuery } from "./fake-sdk-query.js";

type HostEvent = Extract<HarnessOutput, { kind: "event" }>["event"];

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

/** A real Claude Adapter over the real SDK Transport; only the native Query is scripted. */
async function liveSession() {
  const fakeQuery = new FakeQuery();
  const history: unknown[] = [];
  let uuid = 0;
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID: () => (++uuid === 1 ? SESSION_ID : `claude-id-${uuid}`),
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
    readSessionMessages: async () => structuredClone(history),
    readSubagentMessages: async () => [],
    createTransport: (input) =>
      new ClaudeSdkTransport({
        ...input,
        sessionId: SESSION_ID,
        command: process.execPath,
        closeTimeoutMs: 100,
        queryFactory: () => fakeQuery as unknown as Query,
      }),
  };
  const adapter = new ClaudeCodeAdapter(
    { closeTimeoutMs: 100, continuationQuiescenceMs: 50, cancelTimeoutMs: 5_000 },
    dependencies,
  );
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session: HarnessSession = opened.value;
  const events: HostEvent[] = [];
  const drained = (async () => {
    for await (const output of session.outputs) {
      if (output.kind === "event") events.push(output.event);
    }
  })();
  return {
    events,
    fakeQuery,
    history,
    session,
    async close() {
      await session.close();
      await drained;
    },
  };
}

function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

function push(fakeQuery: FakeQuery, message: Record<string, unknown>): void {
  fakeQuery.push({ session_id: SESSION_ID, ...message } as unknown as SDKMessage);
}

function assistantText(fakeQuery: FakeQuery, uuid: string, text: string): void {
  push(fakeQuery, {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { id: `message-${uuid}`, content: [{ type: "text", text }] },
  });
}

function result(fakeQuery: FakeQuery, terminalReason = "completed"): void {
  push(fakeQuery, {
    type: "result",
    subtype: terminalReason === "completed" ? "success" : "error_during_execution",
    is_error: terminalReason !== "completed",
    terminal_reason: terminalReason,
  });
}

/** Claude moves a Bash command to the background, then ends the requested Root Segment. */
function backgroundCommandTurn(fakeQuery: FakeQuery, callId: string, taskId: string): void {
  push(fakeQuery, {
    type: "assistant",
    uuid: `assistant-${callId}`,
    parent_tool_use_id: null,
    message: {
      id: `message-${callId}`,
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "Bash",
          input: { command: "npm test", run_in_background: true },
        },
      ],
    },
  });
  push(fakeQuery, {
    type: "user",
    uuid: `result-${callId}`,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          content: `Command running in background with ID: ${taskId}.`,
          is_error: false,
        },
      ],
    },
    tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId },
  });
  assistantText(fakeQuery, `assistant-${callId}-reply`, "Tests are running in the background.");
  result(fakeQuery);
}

/** The background command ends and Claude starts answering its notification on its own. */
function commandNotification(fakeQuery: FakeQuery, uuid: string, callId: string, taskId: string) {
  push(fakeQuery, {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: callId,
    status: "completed",
    summary: "Background command completed",
  });
  push(fakeQuery, {
    type: "user",
    uuid,
    parent_tool_use_id: null,
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content: `<task-notification><task-id>${taskId}</task-id><tool-use-id>${callId}</tool-use-id><status>completed</status><summary>Background command completed</summary></task-notification>`,
    },
  });
}

function turnTexts(events: readonly HostEvent[], turnId: string): string[] {
  return events.flatMap((event) =>
    event.type === "item.updated" && event.turnId === turnId && event.update.type === "text.append"
      ? [event.update.text]
      : [],
  );
}

function autonomousTurnIds(events: readonly HostEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "turn.autonomous.started" ? [event.turnId] : [],
  );
}

function completion(events: readonly HostEvent[], turnId: string) {
  return events.find((event) => event.type === "turn.completed" && event.turnId === turnId);
}

describe("Claude live autonomous continuation (issue #495)", () => {
  it.each([false, true])(
    "reads history after a failed autonomous Turn using only transcript message IDs (user UUID: %s)",
    async (hasUserMessage) => {
      const live = await liveSession();
      try {
        await live.session.execute(textTurn("run-tests"));
        backgroundCommandTurn(live.fakeQuery, "bash-call-1", "bash-task-1");
        await vi.waitFor(() => expect(completion(live.events, "run-tests")).toBeDefined());

        const userMessageId = "00000000-0000-4000-8000-0000000000a1";
        const checkpointId = "00000000-0000-4000-8000-0000000000a2";
        if (hasUserMessage) {
          commandNotification(live.fakeQuery, userMessageId, "bash-call-1", "bash-task-1");
        } else {
          // Native quota failures can answer a task notification without a streamed User UUID.
          push(live.fakeQuery, {
            type: "system",
            subtype: "task_notification",
            task_id: "bash-task-1",
            tool_use_id: "bash-call-1",
            status: "failed",
            summary: "Background command timed out",
          });
        }
        assistantText(live.fakeQuery, checkpointId, "You've hit your session limit");
        result(live.fakeQuery, "error_during_execution");
        await vi.waitFor(() => expect(autonomousTurnIds(live.events)).toHaveLength(1));
        const [turnId] = autonomousTurnIds(live.events);
        if (!turnId) throw new Error("Autonomous Turn did not start");
        await vi.waitFor(() =>
          expect(completion(live.events, turnId)).toMatchObject({
            nativeTurnRef: {
              nativeTurnKey: hasUserMessage ? userMessageId : expect.stringMatching(/^autonomous-/),
            },
            outcome: { status: "failed", checkpoint: { checkpointId } },
          }),
        );

        // A real Assistant checkpoint still must reach native history before a read succeeds.
        await expect(live.session.readSnapshot()).resolves.toMatchObject({
          ok: false,
          error: { code: "sessionBusy" },
        });
        live.history.push({
          type: "assistant",
          uuid: checkpointId,
          session_id: SESSION_ID,
          message: { role: "assistant", content: "You've hit your session limit" },
        });
        if (hasUserMessage) {
          await expect(live.session.readSnapshot()).resolves.toMatchObject({
            ok: false,
            error: { code: "sessionBusy" },
          });
          live.history.unshift({
            type: "user",
            uuid: userMessageId,
            session_id: SESSION_ID,
            message: { role: "user", content: "Background command completed" },
          });
        }
        const snapshot = await live.session.readSnapshot();
        expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ ok: true });
        await expect(live.session.readSnapshot()).resolves.toMatchObject({ ok: true });
        await expect(live.session.execute(textTurn("continue"))).resolves.toMatchObject({
          ok: true,
        });
      } finally {
        await live.close();
      }
    },
  );

  it("preserves pending transcript IDs when an autonomous failure has no checkpoint", async () => {
    const live = await liveSession();
    try {
      await live.session.execute(textTurn("start"));
      assistantText(live.fakeQuery, "start-checkpoint", "Started");
      result(live.fakeQuery);
      await vi.waitFor(() => expect(completion(live.events, "start")).toBeDefined());
      const started = completion(live.events, "start");
      if (started?.type !== "turn.completed" || !started.nativeTurnRef) {
        throw new Error("Requested Turn has no native identity");
      }
      result(live.fakeQuery, "error_during_execution");
      await vi.waitFor(() => expect(autonomousTurnIds(live.events)).toHaveLength(1));
      const [turnId] = autonomousTurnIds(live.events);
      if (!turnId) throw new Error("Autonomous Turn did not start");
      await vi.waitFor(() =>
        expect(completion(live.events, turnId)).toMatchObject({ outcome: { status: "failed" } }),
      );
      await expect(live.session.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      live.history.push({
        type: "user",
        uuid: started.nativeTurnRef.nativeTurnKey,
        session_id: SESSION_ID,
        message: { role: "user", content: "start" },
      });
      await expect(live.session.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      live.history.push({
        type: "assistant",
        uuid: "start-checkpoint",
        session_id: SESSION_ID,
        message: { role: "assistant", content: "Started" },
      });
      await expect(live.session.readSnapshot()).resolves.toMatchObject({ ok: true });
    } finally {
      await live.close();
    }
  });

  it("shows a background command continuation live and keeps each Segment in its own Turn", async () => {
    const live = await liveSession();
    try {
      await expect(live.session.execute(textTurn("run-tests"))).resolves.toMatchObject({
        ok: true,
      });
      backgroundCommandTurn(live.fakeQuery, "bash-call-1", "bash-task-1");
      await vi.waitFor(() =>
        expect(completion(live.events, "run-tests")).toMatchObject({
          outcome: { status: "succeeded" },
        }),
      );

      commandNotification(
        live.fakeQuery,
        "00000000-0000-4000-8000-0000000000a1",
        "bash-call-1",
        "bash-task-1",
      );
      assistantText(live.fakeQuery, "00000000-0000-4000-8000-0000000000a2", "PART-A");
      // The continuation is visible before its native Result.
      await vi.waitFor(() => expect(autonomousTurnIds(live.events)).toHaveLength(1));
      const [first] = autonomousTurnIds(live.events);
      if (!first) throw new Error("Autonomous Turn did not start");
      await vi.waitFor(() => expect(turnTexts(live.events, first)).toEqual(["PART-A"]));
      expect(completion(live.events, first)).toBeUndefined();

      // A message sent meanwhile waits instead of absorbing the continuation.
      await expect(live.session.execute(textTurn("follow-up"))).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });

      assistantText(live.fakeQuery, "00000000-0000-4000-8000-0000000000a3", "PART-B");
      result(live.fakeQuery);
      await vi.waitFor(() =>
        expect(completion(live.events, first)).toMatchObject({
          outcome: { status: "succeeded" },
          nativeTurnRef: { nativeTurnKey: "00000000-0000-4000-8000-0000000000a1" },
        }),
      );
      expect(turnTexts(live.events, first)).toEqual(["PART-A", "PART-B"]);

      await expect(live.session.execute(textTurn("follow-up"))).resolves.toMatchObject({
        ok: true,
      });
      assistantText(live.fakeQuery, "00000000-0000-4000-8000-0000000000b2", "ANSWER");
      result(live.fakeQuery);
      await vi.waitFor(() => expect(completion(live.events, "follow-up")).toBeDefined());
      expect(turnTexts(live.events, "follow-up")).toEqual(["ANSWER"]);

      // A later continuation gets its own identity and none of the earlier output.
      commandNotification(
        live.fakeQuery,
        "00000000-0000-4000-8000-0000000000c1",
        "bash-call-1",
        "bash-task-2",
      );
      assistantText(live.fakeQuery, "00000000-0000-4000-8000-0000000000c2", "PART-C");
      result(live.fakeQuery);
      await vi.waitFor(() => expect(autonomousTurnIds(live.events)).toHaveLength(2));
      const second = autonomousTurnIds(live.events)[1];
      if (!second) throw new Error("Second autonomous Turn did not start");
      await vi.waitFor(() =>
        expect(completion(live.events, second)).toMatchObject({
          nativeTurnRef: { nativeTurnKey: "00000000-0000-4000-8000-0000000000c1" },
        }),
      );
      expect(turnTexts(live.events, second)).toEqual(["PART-C"]);
      expect(live.events.some((event) => event.type === "session.faulted")).toBe(false);
    } finally {
      await live.close();
    }
  });

  it("cancels a live continuation through the native interrupt", async () => {
    const live = await liveSession();
    try {
      await live.session.execute(textTurn("run-tests"));
      backgroundCommandTurn(live.fakeQuery, "bash-call-1", "bash-task-1");
      await vi.waitFor(() => expect(completion(live.events, "run-tests")).toBeDefined());

      commandNotification(
        live.fakeQuery,
        "00000000-0000-4000-8000-0000000000a1",
        "bash-call-1",
        "bash-task-1",
      );
      assistantText(live.fakeQuery, "00000000-0000-4000-8000-0000000000a2", "PART-A");
      await vi.waitFor(() => expect(autonomousTurnIds(live.events)).toHaveLength(1));
      const [turnId] = autonomousTurnIds(live.events);
      if (!turnId) throw new Error("Autonomous Turn did not start");

      await expect(
        live.session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse(turnId) }),
      ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
      expect(live.fakeQuery.interrupt).toHaveBeenCalledOnce();
      result(live.fakeQuery, "aborted_streaming");
      await vi.waitFor(() =>
        expect(completion(live.events, turnId)).toMatchObject({
          outcome: { status: "cancelled" },
        }),
      );
      // The interrupt answered, so the native process keeps running for the next request.
      await expect(live.session.execute(textTurn("next"))).resolves.toMatchObject({ ok: true });
      expect(live.events.some((event) => event.type === "session.faulted")).toBe(false);
    } finally {
      await live.close();
    }
  });
});
