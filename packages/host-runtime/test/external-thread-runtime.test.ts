import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { HarnessResult, HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import {
  encodeAntigravityTransportModel,
  encodeGrokTransportModel,
  encodeOmpTransportModel,
  encodeOpenCodeTransportModel,
  type ExternalHarnessId,
} from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

const harnessId = harnessIdSchema.parse("pi");
const hostThreadId = hostThreadIdSchema.parse("thread-1");
const hostTurnId = hostTurnIdSchema.parse("thread-1");

function record(): StoredThreadRecordV1 {
  return {
    formatVersion: 1,
    revision: 1,
    hostThreadId,
    createRequestId: "create-1",
    harnessId,
    state: "ready",
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-1",
      formatVersion: 1,
    }),
    cwd: "/synthetic",
    title: "Pi Thread",
    archived: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
  } as StoredThreadRecordV1;
}

describe("ExternalThreadRuntime register", () => {
  it("restores Antigravity history from the local transcript when the CLI returns placeholders", async () => {
    const antigravityHarnessId = harnessIdSchema.parse("antigravity");
    const adapter = new FakeHarnessAdapter(antigravityHarnessId);
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake Antigravity catalog has no default Model");
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic", model });
    if (!opened.ok || !opened.value.initialState.nativeRef) {
      throw new Error("Fake Antigravity Session did not open");
    }
    const session = opened.value;
    const nativeSessionRef = opened.value.initialState.nativeRef;
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: antigravityHarnessId,
      nativeSessionId: nativeSessionRef.nativeSessionId,
      nativeTurnKey: "turn:1",
      formatVersion: 1,
    });
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: antigravityHarnessId,
      nativeSessionRef,
      turnMappings: [{ hostTurnId, nativeTurnRef }],
      history: [{ id: hostThreadId, items: [{ type: "userMessage" }] }],
    } as StoredThreadRecordV1;
    session.readSnapshot = vi.fn(async (): Promise<HarnessResult<HostThreadSnapshot>> => ({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef,
            input: [],
            items: [
              {
                item: {
                  itemId: hostItemIdSchema.parse("assistant"),
                  type: "agentMessage",
                  text: "output only",
                },
                outcome: { status: "succeeded" },
              },
            ],
            outcome: { status: "unknown", reason: "placeholder" },
          },
        ],
      },
    }));
    vi.spyOn(adapter, "open").mockResolvedValue({ ok: true, value: session });
    const repository = {
      find: async () => stored,
      alignSnapshot: async () => ({ record: stored, turns: [{ id: hostThreadId }] }),
      sessionTreeId: async () => hostThreadId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["antigravity", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") throw new Error("Antigravity Thread did not restore");
    expect(resolved.thread.turns).toEqual(stored.history);
    await adapter.close();
  });

  it("exposes the requested create Model before the Session publishes state", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const model = adapter.catalog.models[1]?.ref;
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      thinkingOptionId,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    Object.defineProperty(opened.value, "initialState", { configurable: true, value: {} });

    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository: { find: async () => null } as unknown as ExternalThreadRepository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const thread = runtime.register({
      record: record(),
      session: opened.value,
      sessionId: hostThreadId,
      thread: { id: hostThreadId },
      turns: [],
      requestedModel: model,
      requestedThinkingOptionId: thinkingOptionId,
    });

    expect(thread.stateObserver.state).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
    });
  });

  it("uses live OMP state instead of stale persisted model and Thinking selections", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const adapter = new FakeHarnessAdapter(ompHarnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);

    const nativeRef = created.value.initialState.nativeRef;
    const actualModel = created.value.initialState.effectiveModel;
    const actualThinking = created.value.initialState.effectiveThinkingOptionId;
    const staleModel = adapter.catalog.models[1]?.ref;
    if (!nativeRef || !actualModel || !actualThinking || !staleModel) {
      throw new Error("Fake OMP Session did not expose the expected configuration state");
    }

    let stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: ompHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: encodeOmpTransportModel(
        staleModel,
        harnessThinkingOptionIdSchema.parse("low"),
      ),
      historyMode: "legacy",
    };
    const setTransportModelId = vi.fn(
      async (_threadId: string, transportModelId: string): Promise<StoredThreadRecordV1> => {
        stored = { ...stored, transportModelId };
        return stored;
      },
    );
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["omp", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: actualModel,
      effectiveThinkingOptionId: actualThinking,
    });
    expect(resolved.thread.record.transportModelId).toBe(
      encodeOmpTransportModel(actualModel, actualThinking),
    );
    expect(setTransportModelId).toHaveBeenCalledWith(
      hostThreadId,
      encodeOmpTransportModel(actualModel, actualThinking),
    );

    await adapter.close();
  });

  it("hands the persisted Antigravity effort back to the Adapter on restore", async () => {
    const antigravityHarnessId = harnessIdSchema.parse("antigravity");
    const adapter = new FakeHarnessAdapter(antigravityHarnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);
    const nativeRef = created.value.initialState.nativeRef;
    const model = adapter.catalog.defaultModel;
    if (!nativeRef || !model) throw new Error("Fake Antigravity Session is missing state");

    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: antigravityHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: encodeAntigravityTransportModel(model, undefined, thinkingOptionId),
      historyMode: "legacy",
    };
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId: async () => stored,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["antigravity", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const open = vi.spyOn(adapter, "open");

    await runtime.resolve(hostThreadId);

    // The Antigravity CLI keeps no server-side effort, so a restore that drops
    // the persisted value would silently run the next Turn without --effort.
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resume", model, thinkingOptionId }),
    );

    open.mockRestore();
    await adapter.close();
  });

  it("does not restore persisted Thinking when live OMP state omits it", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const adapter = new FakeHarnessAdapter(ompHarnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);

    const session = created.value;
    const nativeRef = session.initialState.nativeRef;
    const actualModel = session.initialState.effectiveModel;
    const staleThinking = harnessThinkingOptionIdSchema.parse("low");
    if (!nativeRef || !actualModel || !(session instanceof FakeHarnessSession)) {
      throw new Error("Fake OMP Session did not expose the expected configuration state");
    }
    session.setStateForSnapshot({ nativeRef, effectiveModel: actualModel });

    const staleTransportModelId = encodeOmpTransportModel(actualModel, staleThinking);
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: ompHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: staleTransportModelId,
      historyMode: "legacy",
    } as StoredThreadRecordV1;
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId: async (_threadId: string, transportModelId: string) => ({
        ...stored,
        transportModelId,
      }),
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["omp", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: actualModel,
    });
    expect(resolved.thread.stateObserver.state.effectiveThinkingOptionId).toBeUndefined();
    expect(resolved.thread.requestedThinkingOptionId).toBeUndefined();
    expect(resolved.thread.transportModelId).toBe(encodeOmpTransportModel(actualModel));

    await adapter.close();
  });

  it("keeps OMP restore successful when live selection persistence fails", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const adapter = new FakeHarnessAdapter(ompHarnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);

    const nativeRef = created.value.initialState.nativeRef;
    const actualModel = created.value.initialState.effectiveModel;
    const actualThinking = created.value.initialState.effectiveThinkingOptionId;
    const staleModel = adapter.catalog.models[1]?.ref;
    if (!nativeRef || !actualModel || !actualThinking || !staleModel) {
      throw new Error("Fake OMP Session did not expose the expected configuration state");
    }

    const staleTransportModelId = encodeOmpTransportModel(
      staleModel,
      harnessThinkingOptionIdSchema.parse("low"),
    );
    const setTransportModelId = vi.fn(async () => {
      throw new Error("synthetic mapping persistence failure");
    });
    const diagnose = vi.fn();
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: ompHarnessId,
      nativeSessionRef: nativeRef,
      transportModelId: staleTransportModelId,
      historyMode: "legacy",
    } as StoredThreadRecordV1;
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["omp", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    expect(resolved.thread.stateObserver.state).toMatchObject({
      effectiveModel: actualModel,
      effectiveThinkingOptionId: actualThinking,
    });
    expect(resolved.thread.record.transportModelId).toBe(staleTransportModelId);
    expect(resolved.thread.transportModelId).toBe(
      encodeOmpTransportModel(actualModel, actualThinking),
    );
    expect(setTransportModelId).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledWith(expect.any(Error));

    await adapter.close();
  });

  it("uses live OpenCode Permission Mode when the persisted selection is stale", async () => {
    const openCodeHarnessId = harnessIdSchema.parse("opencode");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "ask", label: "Ask" },
      ],
      defaultModeId: "default",
    });
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const askMode = harnessPermissionModeIdSchema.parse("ask");
    const adapter = new FakeHarnessAdapter(
      openCodeHarnessId,
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake OpenCode catalog has no default Model");
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      permissionModeId: askMode,
    });
    if (
      !created.ok ||
      !created.value.initialState.nativeRef ||
      !(created.value instanceof FakeHarnessSession)
    ) {
      throw new Error("Fake OpenCode Session did not open");
    }
    created.value.rejectNextPermissionModeSelection({
      code: "nativeFailure",
      message: "OpenCode did not confirm the requested Permission Mode",
      retryable: false,
    });
    const execute = vi.spyOn(created.value, "execute");
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: openCodeHarnessId,
      nativeSessionRef: created.value.initialState.nativeRef,
      title: "OpenCode Thread",
      transportModelId: encodeOpenCodeTransportModel(model, defaultMode),
    } as StoredThreadRecordV1;
    const setTransportModelId = vi.fn(
      async (_threadId: string, transportModelId: string): Promise<StoredThreadRecordV1> => ({
        ...stored,
        transportModelId,
      }),
    );
    const repository = {
      find: async () => stored,
      alignSnapshot: async () => ({ record: stored, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId,
    } as unknown as ExternalThreadRepository;
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["opencode", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") throw new Error("OpenCode Thread did not restore");
    const liveThinking = created.value.initialState.effectiveThinkingOptionId;
    expect(execute).not.toHaveBeenCalled();
    expect(resolved.thread.stateObserver.state.effectivePermissionModeId).toBe(askMode);
    expect(resolved.thread.transportModelId).toBe(
      encodeOpenCodeTransportModel(model, askMode, liveThinking),
    );
    expect(setTransportModelId).toHaveBeenCalledWith(
      hostThreadId,
      encodeOpenCodeTransportModel(model, askMode, liveThinking),
    );

    await adapter.close();
  });

  it("opens a Grok Thread whose mapping stores a stale Permission Mode", async () => {
    const grokHarnessId = harnessIdSchema.parse("grok");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "auto", label: "Auto" },
        { id: "always-approve", label: "Always approve", dangerous: true },
      ],
      defaultModeId: "default",
    });
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const alwaysApprove = harnessPermissionModeIdSchema.parse("always-approve");
    const adapter = new FakeHarnessAdapter(
      grokHarnessId,
      undefined,
      true,
      true,
      null,
      permissionModes,
      false,
      "atCreate",
    );
    const model = adapter.catalog.defaultModel;
    if (!model) throw new Error("Fake Grok catalog has no default Model");
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model,
      permissionModeId: defaultMode,
    });
    if (!created.ok || !created.value.initialState.nativeRef) {
      throw new Error("Fake Grok Session did not open");
    }
    const session = created.value;
    const stored: StoredThreadRecordV1 = {
      ...record(),
      harnessId: grokHarnessId,
      nativeSessionRef: created.value.initialState.nativeRef,
      title: "Grok Thread",
      transportModelId: encodeGrokTransportModel(model, alwaysApprove),
    } as StoredThreadRecordV1;
    const execute = vi.spyOn(session, "execute");
    const repository = {
      find: async () => stored,
      alignSnapshot: async () => ({ record: stored, turns: [] }),
      sessionTreeId: async () => hostThreadId,
    } as unknown as ExternalThreadRepository;
    const open = vi.spyOn(adapter, "open");
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["grok", adapter]]),
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
      },
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);

    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") throw new Error("Grok Thread did not restore");
    expect(execute).not.toHaveBeenCalled();
    expect(session.capabilities.configuration.permissionModeScope).toBe("atCreate");
    expect(resolved.thread.stateObserver.state.effectivePermissionModeId).toBe(defaultMode);
    expect(resolved.thread.record.transportModelId).toBe(
      encodeGrokTransportModel(model, alwaysApprove),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEXHOST_CLI_PATH: "/opt/codexhost",
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
          CODEXHOST_RUNTIME_TOKEN: "token",
          CODEXHOST_THREAD_ID: hostThreadId,
        }),
      }),
    );

    await adapter.close();
  });
});
