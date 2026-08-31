import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
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
import { encodeGrokTransportModel } from "@codexhost/protocol-core";
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

  it("reapplies a persisted Grok Permission Mode before reading restored history", async () => {
    const grokHarnessId = harnessIdSchema.parse("grok");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "auto", label: "Auto" },
      ],
      defaultModeId: "default",
    });
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const autoMode = harnessPermissionModeIdSchema.parse("auto");
    const adapter = new FakeHarnessAdapter(
      grokHarnessId,
      undefined,
      true,
      true,
      null,
      permissionModes,
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
      transportModelId: encodeGrokTransportModel(model, autoMode),
    } as StoredThreadRecordV1;
    const execute = vi.spyOn(session, "execute");
    const readSnapshot = vi.spyOn(session, "readSnapshot");
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
    expect(execute).toHaveBeenCalledWith({
      type: "permissionMode.select",
      permissionModeId: autoMode,
    });
    const executeOrder = execute.mock.invocationCallOrder[0];
    const readOrder = readSnapshot.mock.invocationCallOrder[0];
    if (executeOrder === undefined || readOrder === undefined) {
      throw new Error("Restore did not select Permission Mode before reading history");
    }
    expect(executeOrder).toBeLessThan(readOrder);
    expect(resolved.thread.stateObserver.state.effectivePermissionModeId).toBe(autoMode);
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
