import { expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, type JsonObject } from "@codexhost/protocol-core";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";

import {
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Dependencies = NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[1]>;
type Transport = ReturnType<Dependencies["createTransport"]>;
type AutonomousHandler = Parameters<Transport["setAutonomousTurnHandler"]>[0];

function message(
  sessionId: string,
  type: "user" | "assistant",
  uuid: string,
  content: string,
): JsonObject {
  return {
    type,
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: type, content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) },
  };
}

it("preserves a live Claude continuation identity through refresh, reload and exact Fork", async () => {
  const histories = new Map<string, JsonObject[]>();
  let autonomous: AutonomousHandler | undefined;
  let nativeSessionId = "";
  const forkSession = vi.fn<Dependencies["forkSession"]>(
    async ({ sourceSessionId, checkpointId }) => {
      const source = histories.get(sourceSessionId) ?? [];
      const cutoff = source.findIndex(({ uuid }) => uuid === checkpointId);
      if (cutoff < 0) throw new Error("Unknown native Fork cut");
      const sessionId = "derived-session";
      histories.set(
        sessionId,
        source.slice(0, cutoff + 1).map((entry) => ({
          ...entry,
          uuid: `copy-${String(entry.uuid)}`,
          session_id: sessionId,
        })),
      );
      return { sessionId };
    },
  );
  const dependencies: Dependencies = {
    randomUUID: (() => {
      let id = 0;
      return () => `claude-continuation-${++id}`;
    })(),
    bypassPermissionsAvailable: () => true,
    inspectInstallation: () => undefined,
    createInspector: () => ({
      close: async () => undefined,
      inspect: async () => ({
        models: [{ value: "default", displayName: "Default" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      }),
    }),
    deleteSession: async () => undefined,
    forkSession,
    getSessionInfo: async () => ({ cwd: "/synthetic" }),
    readSessionMessages: async ({ sessionId }) => structuredClone(histories.get(sessionId) ?? []),
    readSubagentMessages: async () => [],
    createTransport: (input) => {
      nativeSessionId = input.sessionId;
      let permissionMode = input.permissionMode;
      return {
        sessionId: input.sessionId,
        setAutonomousTurnHandler: (handler) => {
          autonomous = handler;
        },
        setIdleTurnHandler: () => undefined,
        setThreadEventHandler: () => undefined,
        setIdleLive: () => undefined,
        hasBackgroundTasks: () => false,
        stopBackgroundTask: async () => undefined,
        stopTasks: async () => undefined,
        start: async () => undefined,
        getContextUsage: async () => ({ usedTokens: 10, maxTokens: 200, model: "default" }),
        getPermissionMode: () => permissionMode,
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        setPermissionMode: async (mode) => {
          permissionMode = mode;
        },
        compact: async () => ({ status: "succeeded" }),
        init: async () => ({ status: "succeeded" }),
        recap: async () => ({ status: "succeeded" }),
        runTurn: async (text, userId, onEvent) => {
          histories.set(input.sessionId, [
            message(input.sessionId, "user", userId, text),
            message(input.sessionId, "assistant", "requested-answer", "Started background Bash"),
          ]);
          onEvent({
            type: "text.delta",
            messageId: "requested-answer",
            delta: "Started background Bash",
          });
          onEvent({
            type: "message.completed",
            messageId: "requested-answer",
            checkpointId: "requested-answer",
          });
          return { status: "succeeded" };
        },
        steer: async () => {
          throw new Error("Unexpected steer in the continuation fixture");
        },
        respondToInteraction: async () => undefined,
        abort: async () => undefined,
        abortContinuation: async () => undefined,
        close: async () => undefined,
      };
    },
  };
  const adapter = new ClaudeCodeAdapter({ closeTimeoutMs: 50 }, dependencies);
  const fixtureAdapter = new FakeHarnessAdapter(adapter.harnessId);
  vi.spyOn(fixtureAdapter, "open").mockImplementation((input) => adapter.open(input));
  vi.spyOn(fixtureAdapter, "inspect").mockImplementation((input) => adapter.inspect(input));
  vi.spyOn(fixtureAdapter, "close").mockImplementation(() => adapter.close());
  const fixture = createFixture({ externalAdapters: new Map([["claude-code", fixtureAdapter]]) });
  try {
    const threadId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "start Bash" }] },
    });
    const requested = await fixture.collector.waitFor((entry) => entry.method === "turn/completed");
    const requestedTurnId = ((requested.params as JsonObject).turn as JsonObject).id;
    if (!autonomous) throw new Error("Claude transport was not started");
    const source = histories.get(nativeSessionId);
    if (!source) throw new Error("Native history missing");
    source.push(
      {
        ...message(
          nativeSessionId,
          "user",
          "task-notification",
          "<task-notification><task-id>bash-1</task-id><status>completed</status></task-notification>",
        ),
        origin: { kind: "task-notification" },
      },
      message(nativeSessionId, "assistant", "continuation-answer", "Bash finished"),
    );
    autonomous.start("task-notification", "task-notification");
    autonomous.onEvent({
      type: "text.delta",
      messageId: "continuation-answer",
      delta: "Bash finished",
    });
    autonomous.onEvent({
      type: "message.completed",
      messageId: "continuation-answer",
      checkpointId: "continuation-answer",
    });
    autonomous.onTerminal({ status: "succeeded" });
    const completed = await fixture.collector.waitFor(
      (entry) =>
        entry.method === "turn/completed" &&
        ((entry.params as JsonObject)?.turn as JsonObject)?.id !== requestedTurnId,
    );
    const lastTurnId = ((completed.params as JsonObject).turn as JsonObject).id;
    if (typeof lastTurnId !== "string") throw new Error("Continuation has no Host Turn ID");

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(fixture.collector.waitFor((entry) => requestId(entry, 3))).resolves.toMatchObject({
      result: { thread: { turns: [{}, { id: lastTurnId }] } },
    });
    const saved = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(saved?.turnMappings).toMatchObject([
      { nativeCheckpointRef: { checkpointId: "requested-answer" } },
      {
        hostTurnId: lastTurnId,
        nativeTurnRef: { nativeTurnKey: "task-notification" },
        nativeCheckpointRef: { checkpointId: "continuation-answer" },
      },
    ]);
    const reopened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: { harnessId: adapter.harnessId, nativeSessionId, formatVersion: 1 },
    });
    if (!reopened.ok) throw new Error(reopened.error.message);
    await expect(reopened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {},
          {
            nativeTurnRef: { nativeTurnKey: "task-notification" },
            checkpoint: { checkpointId: "continuation-answer" },
          },
        ],
      },
    });
    await reopened.value.close();

    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "thread/fork",
      params: { threadId, lastTurnId },
    });
    await expect(fixture.collector.waitFor((entry) => requestId(entry, 4))).resolves.toMatchObject({
      result: { thread: { forkedFromId: threadId, turns: [{}, {}] } },
    });
    expect(forkSession).toHaveBeenCalledWith({
      sourceSessionId: nativeSessionId,
      checkpointId: "continuation-answer",
      cwd: "/synthetic",
    });
  } finally {
    await stopFixture(fixture);
  }
});
