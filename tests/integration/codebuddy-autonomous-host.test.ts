import { expect, it, vi } from "vitest";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import type { JsonValue } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../../packages/adapters/codebuddy/src/codebuddy-adapter.js";
import { fixture } from "../../packages/adapters/codebuddy/test/fixtures.js";
import { ExternalThreadRuntime } from "../../packages/host-runtime/src/external-thread-runtime.js";
import type { ExternalThreadRepository } from "../../packages/host-runtime/src/external-thread-repository.js";
import {
  ExternalTurnProjection,
  type ExternalTurnProjectionHost,
} from "../../packages/host-runtime/src/external-turn-projection.js";

it("projects a real CodeBuddy autonomous completion through the Host without persisting identity or pausing the queue", async () => {
  const native = fixture(),
    adapter = new CodeBuddyAdapter(native);
  const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
  if (!opened.ok) throw Error(opened.error.message);
  try {
    const harnessId = harnessIdSchema.parse("codebuddy"),
      threadId = hostThreadIdSchema.parse("codebuddy-live");
    const record = {
      formatVersion: 1,
      revision: 1,
      hostThreadId: threadId,
      createRequestId: "create-live",
      harnessId,
      state: "ready",
      cwd: process.cwd(),
      title: "CodeBuddy",
      nativeSessionRef: nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: "native-session",
        formatVersion: 1,
      }),
      archived: false,
      transportModelId: "native/model",
      ephemeral: false,
      historyMode: "legacy",
      turnMappings: [],
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    } as StoredThreadRecordV1;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["codebuddy", adapter]]),
      repository: {} as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: (error) => {
        throw error;
      },
    });
    const thread = runtime.register({
      record,
      session: opened.value,
      sessionId: threadId,
      thread: { id: threadId },
      turns: [],
    });
    const messages: JsonValue[] = [];
    const host: ExternalTurnProjectionHost = {
      writeJson: async (message) => {
        messages.push(message);
      },
      repository: { getDelegationByChild: async () => null, setDelegationStatus: vi.fn() },
      steering: { hasPending: () => false, terminal: vi.fn() },
      queue: { pause: vi.fn(() => false) },
      manualCompactionTurns: new WeakMap(),
      foldSettledItem: (turn) => turn,
      outputFailed: vi.fn(),
      submitPrewarm: async () => false,
      notifyExternalThreadStarted: async () => undefined,
      touchThread: async () => undefined,
      persistTerminalIdentity: vi.fn((current, event) =>
        runtime.persistTerminalIdentity(current, event),
      ),
      retainFailedTurn: async () => undefined,
      captureCompletedPreview: async () => undefined,
      resolveDesktopApproval: async () => undefined,
      resolveDesktopQuestion: async () => undefined,
      retireSharedQuestions: vi.fn(),
      setThreadStatus: async () => undefined,
      forgetQueuedTurnStart: vi.fn(),
      signalActiveWorkChanged: vi.fn(),
      hasRunningSubagents: () => false,
      publishExternalQueue: async () => undefined,
      startNextQueuedExternalTurn: vi.fn(async () => undefined),
    };
    const projection = new ExternalTurnProjection(host),
      client = native.clients[0];
    if (!client) throw Error("Missing fixture client");
    client.update({
      sessionUpdate: "session_info_update",
      _meta: { "codebuddy.ai/unsolicitedTurn": { requestId: "live", reason: "background_drain" } },
    });
    client.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "live answer" },
    });
    client.update({ sessionUpdate: "session_end", stopReason: "end_turn" });
    await opened.value.close();
    for await (const output of opened.value.outputs) {
      if (
        output.kind === "event" &&
        "turnId" in output.event &&
        output.event.type !== "usage.request.timing"
      )
        await projection.project(thread, output.event);
    }
    expect(messages).toContainEqual(
      expect.objectContaining({
        method: "turn/completed",
        params: expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }),
      }),
    );
    expect(host.persistTerminalIdentity).not.toHaveBeenCalled();
    expect(host.outputFailed).not.toHaveBeenCalled();
    expect(host.queue.pause).not.toHaveBeenCalled();
    expect(host.startNextQueuedExternalTurn).toHaveBeenCalledOnce();
    expect(thread.turns).toEqual([]);
    expect(thread.running).toBe(false);
    expect(thread.activeTurnId).toBeNull();
  } finally {
    await adapter.close();
  }
});
