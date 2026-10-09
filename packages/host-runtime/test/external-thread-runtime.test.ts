import type {
  HarnessAdapter,
  HarnessInspection,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  encodeHarnessPluginRoute,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import {
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

  it("uses live OMP state instead of stale persisted configuration", async () => {
    const ompHarnessId = harnessIdSchema.parse("omp");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "always-ask", label: "Always ask" },
        { id: "write", label: "Write" },
        { id: "yolo", label: "Full access" },
      ],
      defaultModeId: "yolo",
    });
    const catalog = new FakeHarnessAdapter(ompHarnessId).catalog;
    const adapter = new FakeHarnessAdapter(
      ompHarnessId,
      catalog,
      true,
      true,
      null,
      permissionModes,
    );
    const writeMode = harnessPermissionModeIdSchema.parse("write");
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: writeMode,
    });
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
    const effectiveTransportModelId = encodeHarnessPluginRoute({
      harnessId: ompHarnessId,
      model: actualModel,
      thinkingOptionId: actualThinking,
      permissionModeId: writeMode,
    });
    expect(resolved.thread.record.transportModelId).toBe(effectiveTransportModelId);
    expect(setTransportModelId).toHaveBeenCalledWith(hostThreadId, effectiveTransportModelId);

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
    expect(resolved.thread.transportModelId).toBe(
      encodeHarnessPluginRoute({ harnessId: ompHarnessId, model: actualModel }),
    );

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
      encodeHarnessPluginRoute({
        harnessId: ompHarnessId,
        model: actualModel,
        thinkingOptionId: actualThinking,
      }),
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
    const route = encodeHarnessPluginRoute({
      harnessId: adapter.harnessId,
      model,
      permissionModeId: askMode,
      ...(liveThinking ? { thinkingOptionId: liveThinking } : {}),
    });
    expect(resolved.thread.transportModelId).toBe(route);
    expect(setTransportModelId).toHaveBeenCalledWith(hostThreadId, route);

    await adapter.close();
  });

  it.each(["auto", "always-approve"] as const)(
    "restores a Grok Thread whose mapping stores %s Permission Mode",
    async (storedModeId) => {
      const grokHarnessId = harnessIdSchema.parse("grok");
      const permissionModes = harnessPermissionModeCatalogSchema.parse({
        modes: [
          { id: "ask", label: "Ask" },
          { id: "auto", label: "Auto" },
          { id: "always-approve", label: "Always approve", dangerous: true },
        ],
        defaultModeId: "ask",
      });
      const defaultMode = harnessPermissionModeIdSchema.parse("ask");
      const storedMode = harnessPermissionModeIdSchema.parse(storedModeId);
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
      if (!(session instanceof FakeHarnessSession)) {
        throw new Error("Fake Grok Session did not expose snapshot state");
      }
      const stored: StoredThreadRecordV1 = {
        ...record(),
        harnessId: grokHarnessId,
        nativeSessionRef: created.value.initialState.nativeRef,
        title: "Grok Thread",
        transportModelId: encodeGrokTransportModel(model, storedMode),
      } as StoredThreadRecordV1;
      const execute = vi.spyOn(session, "execute");
      const repository = {
        find: async () => stored,
        alignSnapshot: async () => ({ record: stored, turns: [] }),
        sessionTreeId: async () => hostThreadId,
      } as unknown as ExternalThreadRepository;
      const open = vi.fn(async (input: OpenSessionInput) => {
        if (input.kind === "resume" && input.permissionModeId) {
          session.setStateForSnapshot({
            ...session.state,
            effectivePermissionModeId: input.permissionModeId,
          });
        }
        return adapter.open(input);
      });
      const restoringAdapter: HarnessAdapter = {
        harnessId: adapter.harnessId,
        inspect: (input): Promise<HarnessInspection> => adapter.inspect(input),
        open,
        close: () => adapter.close(),
      };
      const runtime = new ExternalThreadRuntime({
        adapters: new Map([["grok", restoringAdapter]]),
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
      expect(resolved.thread.stateObserver.state.effectivePermissionModeId).toBe(storedMode);
      expect(resolved.thread.record.transportModelId).toBe(
        encodeGrokTransportModel(model, storedMode),
      );
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionModeId: storedMode,
          environment: expect.objectContaining({
            CODEXHOST_CLI_PATH: "/opt/codexhost",
            CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
            CODEXHOST_RUNTIME_TOKEN: "token",
            CODEXHOST_THREAD_ID: hostThreadId,
          }),
        }),
      );

      await adapter.close();
    },
  );
});

describe("ExternalThreadRuntime unavailable Session recovery", () => {
  it("restores after a faulted idle Session instead of reusing it", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;
    if (!(session instanceof FakeHarnessSession)) throw new Error("expected FakeHarnessSession");
    const nativeRef = session.initialState.nativeRef;
    if (!nativeRef) throw new Error("missing nativeRef");

    const stored: StoredThreadRecordV1 = {
      ...record(),
      nativeSessionRef: nativeRef,
    };
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId: async (_threadId: string, transportModelId: string) => ({
        ...stored,
        transportModelId,
      }),
    } as unknown as ExternalThreadRepository;
    // Fake Adapter resumes the same object; real adapters reopen a process.
    const realOpen = adapter.open.bind(adapter);
    const open = vi.spyOn(adapter, "open").mockImplementation(async (input) => {
      if (input.kind === "resume") {
        return realOpen({
          kind: "create",
          cwd: input.cwd,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.thinkingOptionId !== undefined
            ? { thinkingOptionId: input.thinkingOptionId }
            : {}),
          ...(input.permissionModeId !== undefined
            ? { permissionModeId: input.permissionModeId }
            : {}),
        });
      }
      return realOpen(input);
    });
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const first = await runtime.resolve(hostThreadId);
    expect(first.kind).toBe("external");
    if (first.kind !== "external") return;
    expect(first.historyFresh).toBe(true);
    const opensAfterFirst = open.mock.calls.length;
    const live = first.thread.session;
    if (!(live instanceof FakeHarnessSession)) throw new Error("expected FakeHarnessSession");

    live.fault({
      code: "processExited",
      message: "Claude Code Session became unavailable",
      retryable: false,
    });
    runtime.markSessionUnavailable(first.thread);
    await runtime.discardUnavailableIdle(first.thread);
    expect(runtime.get(hostThreadId)).toBeUndefined();

    const second = await runtime.resolve(hostThreadId);
    expect(second.kind).toBe("external");
    if (second.kind !== "external") return;
    expect(second.historyFresh).toBe(true);
    expect(second.thread).not.toBe(first.thread);
    expect(second.thread.sessionUnavailable).toBe(false);
    expect(open.mock.calls.length).toBeGreaterThan(opensAfterFirst);
    await expect(runtime.refresh(second.thread)).resolves.toBeNull();

    await adapter.close();
  });

  it("revives in place from refresh when readSnapshot returns invalidState", async () => {
    const adapter = new FakeHarnessAdapter(harnessId);
    const created = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;
    if (!(session instanceof FakeHarnessSession)) throw new Error("expected FakeHarnessSession");
    const nativeRef = session.initialState.nativeRef;
    if (!nativeRef) throw new Error("missing nativeRef");

    const stored: StoredThreadRecordV1 = {
      ...record(),
      nativeSessionRef: nativeRef,
    };
    const repository = {
      find: async () => stored,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => hostThreadId,
      setTransportModelId: async (_threadId: string, transportModelId: string) => ({
        ...stored,
        transportModelId,
      }),
    } as unknown as ExternalThreadRepository;
    const realOpen = adapter.open.bind(adapter);
    vi.spyOn(adapter, "open").mockImplementation(async (input) => {
      if (input.kind === "resume") {
        return realOpen({
          kind: "create",
          cwd: input.cwd,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.thinkingOptionId !== undefined
            ? { thinkingOptionId: input.thinkingOptionId }
            : {}),
          ...(input.permissionModeId !== undefined
            ? { permissionModeId: input.permissionModeId }
            : {}),
        });
      }
      return realOpen(input);
    });
    const runtime = new ExternalThreadRuntime({
      adapters: new Map([["pi", adapter]]),
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });

    const resolved = await runtime.resolve(hostThreadId);
    expect(resolved.kind).toBe("external");
    if (resolved.kind !== "external") return;
    const thread = resolved.thread;
    const live = thread.session;
    if (!(live instanceof FakeHarnessSession)) throw new Error("expected FakeHarnessSession");
    live.fault({ code: "processExited", message: "gone", retryable: false });

    await expect(runtime.refresh(thread)).resolves.toBeNull();
    expect(thread.sessionUnavailable).toBe(false);
    expect(thread.session).not.toBe(live);
    expect(runtime.get(hostThreadId)).toBe(thread);

    await adapter.close();
  });
});
