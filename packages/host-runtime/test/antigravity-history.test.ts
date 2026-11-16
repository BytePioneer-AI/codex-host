import { expect, it, vi } from "vitest";
import { encodeHarnessPluginRoute, harnessPluginRouteSchema } from "@codexhost/shared-contracts";
import {
  AntigravityAdapter,
  type AntigravityAcpTransportLike,
} from "@codexhost/adapter-antigravity";
import { createExternalThreadRecordInput } from "../src/external-thread-repository.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

it("opens cold agy history with one load connection and resumes writing only on submission", async () => {
  const opens: Parameters<AntigravityAcpTransportLike["openSession"]>[0][] = [];
  const prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
  const closeSessions: ReturnType<typeof vi.fn>[] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  const nativeSessionId = "11111111-1111-4111-8111-111111111111";
  const secondNativeSessionId = "22222222-2222-4222-8222-222222222222";
  const createTransport = vi.fn((): AntigravityAcpTransportLike => {
    let currentSessionId: string | null = null;
    let config = [
      {
        id: "model",
        category: "model",
        name: "Model",
        currentValue: "native",
        options: [{ value: "native", name: "Native" }],
      },
      {
        id: "thought_level",
        category: "thought_level",
        name: "Thinking",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const closeSession = vi.fn(async () => {
      currentSessionId = null;
    });
    const close = vi.fn(async () => {
      currentSessionId = null;
    });
    closeSessions.push(closeSession);
    closes.push(close);
    return {
      get sessionId() {
        return currentSessionId;
      },
      isClosed: false,
      skipPermissions: false,
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      openSession: async (input) => {
        opens.push(input);
        const sessionId = input.sessionId ?? nativeSessionId;
        currentSessionId = sessionId;
        return {
          opened: {
            sessionId,
            configOptions: config,
            modes: { currentModeId: "default", availableModes: [] },
          },
          replayedEvents:
            input.kind === "load"
              ? Array.from({ length: 12 }, (_, index) => [
                  { type: "user.text" as const, text: `old question ${index}` },
                  { type: "agent.text" as const, text: `old answer ${index}` },
                ]).flat()
              : [],
        };
      },
      setSessionEventHandler: () => {},
      setMode: async () => {},
      setConfigOption: async (id, value) => {
        config = config.map((entry) =>
          entry.id === id ? { ...entry, currentValue: value } : entry,
        );
        return config;
      },
      prompt,
      cancel: async () => {},
      closeSession,
      close,
    };
  });
  const adapter = new AntigravityAdapter({ createTransport });
  const fixture = createFixture({ additionalAdapters: new Map([["antigravity", adapter]]) });
  await fixture.ready;
  try {
    const transportModelId = encodeHarnessPluginRoute(
      harnessPluginRouteSchema.parse({
        harnessId: "antigravity",
        model: { id: "native" },
        thinkingOptionId: "high",
        permissionModeId: "plan",
      }),
    );
    const record = await fixture.mappingStore.createProvisional(
      createExternalThreadRecordInput({
        harnessId: adapter.harnessId,
        cwd: fixture.mappingStoreDirectory,
        title: "Historical Session",
        transportModelId,
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    await fixture.mappingStore.commitReady({
      hostThreadId: record.hostThreadId,
      nativeSessionRef: { harnessId: adapter.harnessId, nativeSessionId, formatVersion: 1 },
    });
    const snapshot = await fixture.host.clientSnapshot(record.hostThreadId);
    expect(snapshot.turnsPage.data).toHaveLength(5);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(opens).toEqual([expect.objectContaining({ kind: "load", sessionId: nativeSessionId })]);
    expect(closeSessions[0]).toHaveBeenCalledOnce();
    expect(closes[0]).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(await fixture.mappingStore.getThread(record.hostThreadId)).toMatchObject({
      transportModelId,
    });
    expect(snapshot.configuration).toMatchObject({
      effectiveModel: { id: "native" },
      effectiveThinkingOptionId: "high",
      effectivePermissionModeId: "plan",
    });
    await fixture.host.clientSnapshot(record.hostThreadId);
    expect(createTransport).toHaveBeenCalledTimes(1);

    const secondRecord = await fixture.mappingStore.createProvisional(
      createExternalThreadRecordInput({
        harnessId: adapter.harnessId,
        cwd: fixture.mappingStoreDirectory,
        title: "Second Historical Session",
        transportModelId,
        ephemeral: false,
        historyMode: "paginated",
      }),
    );
    await fixture.mappingStore.commitReady({
      hostThreadId: secondRecord.hostThreadId,
      nativeSessionRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: secondNativeSessionId,
        formatVersion: 1,
      },
    });
    const secondSnapshot = await fixture.host.clientSnapshot(secondRecord.hostThreadId);
    expect(secondSnapshot.turnsPage.data).toHaveLength(5);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(opens).toEqual([
      expect.objectContaining({ kind: "load", sessionId: nativeSessionId }),
      expect.objectContaining({ kind: "load", sessionId: secondNativeSessionId }),
    ]);
    expect(closeSessions[0]).toHaveBeenCalledTimes(2);
    expect(closes[0]).not.toHaveBeenCalled();

    const started = await fixture.host.handleClientRequest("turn/start", {
      threadId: record.hostThreadId,
      input: [{ type: "text", text: "continue the conversation" }],
    });
    expect(started).toHaveProperty("result");
    await fixture.collector.waitFor((message) => message.method === "turn/completed");
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(opens[2]).toMatchObject({ kind: "resume", sessionId: nativeSessionId });
    expect(prompt).toHaveBeenCalledOnce();
    expect(closes[1]).not.toHaveBeenCalled();
    expect(await fixture.mappingStore.getThread(record.hostThreadId)).toMatchObject({
      nativeSessionRef: { nativeSessionId },
      turnMappings: expect.arrayContaining([
        expect.objectContaining({
          nativeTurnRef: expect.objectContaining({ nativeTurnKey: "turn-12" }),
        }),
      ]),
    });
  } finally {
    await stopFixture(fixture);
  }
  expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
});
