import { describe, expect, it } from "vitest";

import { CodexTurnProjector } from "@codexhost/protocol-core";
import type { JsonObject } from "@codexhost/protocol-core";

import { ExternalTurnProjection } from "../src/external-turn-projection.js";
import type { ExternalThread, ProjectedTurn } from "../src/external-thread-runtime.js";

function stubThread(turnId: string): ExternalThread {
  const projection: ProjectedTurn = {
    projector: new CodexTurnProjector({
      threadId: "thread-1",
      turnId,
      cwd: "/tmp",
      startedAtMs: 1,
    }),
  };
  return {
    id: "thread-1",
    cwd: "/tmp",
    harnessId: "codex",
    sessionId: "session-1",
    record: { state: "provisional", hostThreadId: "thread-1" } as ExternalThread["record"],
    stateObserver: {} as ExternalThread["stateObserver"],
    thread: { id: "thread-1", turns: [] } as JsonObject,
    turns: [],
    historicalPlans: new Map(),
    historyHydrated: true,
    running: true,
    activeTurnId: turnId,
    projectedTerminalTurnId: null,
    latestUsage: null,
    livePlan: null,
    usageTurnId: null,
    usageMeter: {} as ExternalThread["usageMeter"],
    projectedTurns: new Map([[turnId, projection]]),
    responseGates: new Map(),
    pendingSteerProjections: new Set(),
    ephemeralTurnIds: new Set(),
    ignoredInteractionIds: new Set(),
    persistenceError: null,
    sessionUnavailable: false,
    steeredTurnIds: new Set(),
    unsubmittedPrewarm: false,
    outputTask: Promise.resolve(),
    session: {} as ExternalThread["session"],
  } as ExternalThread;
}

describe("External Turn projection announce handshake", () => {
  it("publishes an unannounced Thread before its first projected Turn event", async () => {
    const turnId = "turn-1" as ExternalThread["activeTurnId"] & string;
    const written: JsonObject[] = [];
    const order: string[] = [];
    const host = {
      writeJson: async (value: JsonObject) => {
        order.push(String((value as { method?: string }).method));
        written.push(value);
      },
      ensureExternalThreadAnnounced: async () => {
        order.push("thread/started");
      },
      steering: { hasPending: () => false, terminal: () => null },
      queue: { pause: () => false },
      manualCompactionTurns: new WeakMap(),
      foldSettledItem: (turn: JsonObject) => turn,
      outputFailed: () => undefined,
      submitPrewarm: async () => false,
      notifyExternalThreadStarted: async () => order.push("notify"),
      touchThread: async () => undefined,
      persistTerminalIdentity: async () => null,
      retainFailedTurn: async () => undefined,
      captureCompletedPreview: async () => undefined,
      resolveDesktopApproval: async () => undefined,
      resolveDesktopQuestion: async () => undefined,
      retireSharedQuestions: () => undefined,
      setThreadStatus: async () => undefined,
      forgetQueuedTurnStart: () => undefined,
      signalActiveWorkChanged: () => undefined,
      hasRunningSubagents: () => false,
      publishExternalQueue: async () => undefined,
      startNextQueuedExternalTurn: async () => undefined,
      repository: {
        getDelegationByChild: async () => null,
        setDelegationStatus: async () => undefined,
      },
    };
    const projection = new ExternalTurnProjection(
      host as unknown as ConstructorParameters<typeof ExternalTurnProjection>[0],
    );
    await projection.project(stubThread(turnId), {
      type: "turn.started",
      turnId,
      input: [{ type: "text", text: "hello" }],
    } as never);
    expect(order[0]).toBe("thread/started");
    expect(order[1]).toBe("turn/started");
    expect(
      written.some((message) => (message as { method?: string }).method === "turn/started"),
    ).toBe(true);
  });
});
