import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { encodeGrokTransportModel } from "@codexhost/protocol-core";
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
