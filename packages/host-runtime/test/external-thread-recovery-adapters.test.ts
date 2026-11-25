import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import { ZcodeAdapter, type ZcodeAdapterOptions } from "@codexhost/adapter-zcode";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import {
  createFixture,
  startExternalThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
  requestId,
} from "./app-server-host-fixture.js";

type ClaudeDependencies = NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[1]>;
type ClaudeTransport = ReturnType<ClaudeDependencies["createTransport"]>;
type ZcodeTransport = ReturnType<NonNullable<ZcodeAdapterOptions["createTransport"]>>;
function deferred() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, resolve: () => resolve(undefined) };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

it("retries the real Claude Session's failed close before starting a same-native replacement", async () => {
  const history: unknown[] = [];
  const inputs: Parameters<ClaudeDependencies["createTransport"]>[0][] = [];
  const transports: ClaudeTransport[] = [];
  const failed = deferred();
  const gate = deferred();
  const closing = deferred();
  const retrying = deferred();
  let oldClosed = false;
  let uuid = 0;
  const dependencies: ClaudeDependencies = {
    randomUUID: () => `claude-recovery-${++uuid}`,
    bypassPermissionsAvailable: () => true,
    inspectInstallation: () => undefined,
    createInspector: () => ({
      close: async () => undefined,
      inspect: async () => ({
        models: [
          {
            value: "default",
            displayName: "Default",
            resolvedModel: "runtime-default",
            supportsAutoMode: true,
          },
        ],
        canSelectModel: true,
        canSelectPermissionMode: true,
      }),
    }),
    deleteSession: async () => undefined,
    forkSession: async () => ({ sessionId: "unused-fork" }),
    getSessionInfo: async () => ({ cwd: "/synthetic" }),
    readSessionMessages: async () => structuredClone(history),
    readSubagentMessages: async () => [],
    createTransport: vi.fn((input) => {
      const first = inputs.length === 0;
      inputs.push(input);
      if (!first) expect(oldClosed).toBe(true);
      let permissionMode = input.permissionMode;
      const pending = () =>
        Promise.withResolvers<Awaited<ReturnType<ClaudeTransport["runTurn"]>>>().promise;
      const transport: ClaudeTransport = {
        sessionId: input.sessionId,
        setAutonomousTurnHandler: () => undefined,
        setIdleTurnHandler: () => undefined,
        setThreadEventHandler: () => undefined,
        setIdleLive: () => undefined,
        hasBackgroundTasks: () => false,
        stopBackgroundTask: async () => undefined,
        stopTasks: async () => undefined,
        start: async () => undefined,
        getContextUsage: async () => null,
        getPermissionMode: () => permissionMode,
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        setPermissionMode: async (value) => {
          permissionMode = value;
        },
        compact: pending,
        init: pending,
        recap: pending,
        runTurn: vi.fn((_text, userMessageId) => {
          history.push({
            type: "user",
            uuid: userMessageId,
            session_id: input.sessionId,
            message: { role: "user", content: [{ type: "text", text: "synthetic" }] },
          });
          return pending();
        }),
        steer: async () => undefined,
        respondToInteraction: async () => undefined,
        abort: async () => undefined,
        abortContinuation: async () => undefined,
        close: first
          ? vi
              .fn(async () => {
                retrying.resolve();
                await gate.promise;
                oldClosed = true;
              })
              .mockImplementationOnce(async () => {
                closing.resolve();
                await failed.promise;
                throw new Error("native shutdown not yet confirmed");
              })
          : async () => undefined,
      };
      transports.push(transport);
      return transport;
    }),
  };
  const real = new ClaudeCodeAdapter({ closeTimeoutMs: 5_000 }, dependencies);
  // Reuse the Host fixture without changing its Fake-specific helpers. All Session operations
  // and inspection here go to the production Adapter; only its native Transport is synthetic.
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  vi.spyOn(adapter, "open").mockImplementation((input) => real.open(input));
  vi.spyOn(adapter, "inspect").mockImplementation((input) => real.inspect(input));
  vi.spyOn(adapter, "close").mockImplementation(() => real.close());
  const f = createFixture({ externalAdapters: new Map([["claude-code", adapter]]) });
  try {
    const id = await startExternalThread(f, "codexhost/claude-code-native");
    const turn = await startPiTurn(f, id, 510);
    const input = inputs[0];
    const old = transports[0];
    if (!input || !old) throw new Error("Missing initial Claude Transport");
    input.onFault(new Error("native protocol fault while the process still needs shutdown"));
    await closing.promise;
    await f.collector.waitFor((message) => turnEvent(message, "turn/completed", turn));
    // Whether the Host's discard is already waiting on close or retries after it rejects,
    // the old Session remains the owner until a close attempt actually succeeds.
    await flush();
    expect(transports).toHaveLength(1);
    const session = await vi.mocked(adapter.open).mock.results[0]?.value;
    if (!session?.ok) throw new Error("Expected the original Claude Session");
    const firstClose = session.value.close();
    failed.resolve();
    await expect(firstClose).rejects.toThrow("could not stop safely");
    expect(transports).toHaveLength(1);
    writeRequest(f.desktopInput, {
      id: 513,
      method: "turn/start",
      params: { threadId: id, input: [{ type: "text", text: "retry" }] },
    });
    await retrying.promise;
    await flush();
    expect(f.collector.messages.some((message) => requestId(message, 513))).toBe(false);
    expect(transports).toHaveLength(1);
    gate.resolve();
    const response = await f.collector.waitFor((message) => requestId(message, 513));
    expect(response).toHaveProperty("result");
    expect(response).not.toHaveProperty("error");
    expect(transports).toHaveLength(2);
    expect(transports[1]?.sessionId).toBe(old.sessionId);
    expect(transports[1]?.runTurn).toHaveBeenCalledOnce();
  } finally {
    failed.resolve();
    gate.resolve();
    await stopFixture(f);
    vi.restoreAllMocks();
  }
});

it("waits for the real ZCode Adapter to release exclusive native ownership before resume", async () => {
  const cwd = process.cwd();
  const nativeRef = nativeSessionRefSchema.parse({
    harnessId: "zcode",
    nativeSessionId: "recovery-native",
    formatVersion: 1,
    locator: { backend: "local-service", cwd },
  });
  const snapshot = {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: nativeRef.nativeSessionId,
      workspace: { workspacePath: cwd, workspaceKey: "recovery" },
      title: "",
      status: "idle",
      mode: "build",
      createdAt: 0,
      updatedAt: 0,
      sessionKind: "main",
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: { status: "idle", contextUsed: 0, contextWindow: 0 },
    messages: [],
    runtime: {},
  };
  const gate = deferred();
  const closing = deferred();
  const transports: ZcodeTransport[] = [];
  const adapter = new ZcodeAdapter({
    createTransport: (options) => {
      const first = transports.length === 0;
      const transport = {
        options,
        locator: { backend: "local-service", cwd },
        onFault: undefined,
        start: async () => undefined,
        listen: async () => async () => undefined,
        request: async () => snapshot,
        close: async () => {
          if (first) {
            closing.resolve();
            await gate.promise;
          }
        },
      } as unknown as ZcodeTransport;
      transports.push(transport);
      return transport;
    },
  });
  const open = vi.spyOn(adapter, "open");
  const id = hostThreadIdSchema.parse("recovery-zcode");
  const record = {
    formatVersion: 1,
    revision: 1,
    hostThreadId: id,
    createRequestId: "recovery",
    harnessId: adapter.harnessId,
    state: "ready",
    nativeSessionRef: nativeRef,
    cwd,
    title: "Recovery",
    archived: false,
    transportModelId: "codexhost/zcode-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as StoredThreadRecordV1;
  const runtime = new ExternalThreadRuntime({
    adapters: new Map([["zcode", adapter]]),
    repository: {
      find: async () => record,
      alignSnapshot: async (current: StoredThreadRecordV1) => ({ record: current, turns: [] }),
      sessionTreeId: async () => id,
    } as unknown as ExternalThreadRepository,
    diagnose: () => undefined,
    consumeOutputs: async (thread) => {
      for await (const output of thread.session.outputs) {
        if (output.kind === "event" && output.event.type === "session.faulted") {
          runtime.markSessionUnavailable(thread);
          void runtime.discardUnavailableIdle(thread);
        }
      }
    },
  });
  try {
    expect((await runtime.resolve(id)).kind).toBe("external");
    const onFault = transports[0]?.onFault;
    if (!onFault) throw new Error("Missing ZCode fault callback");
    onFault(new Error("native service protocol fault"));
    await closing.promise;
    // Control: production Adapter still refuses a second owner before confirmed shutdown.
    expect(await adapter.open({ kind: "resume", nativeRef, cwd })).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    open.mockClear();
    const resolutions = [runtime.resolve(id), runtime.resolve(id)];
    await flush();
    expect(open).not.toHaveBeenCalled();
    gate.resolve();
    for (const result of await Promise.all(resolutions)) expect(result.kind).toBe("external");
    expect(open).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(2);
  } finally {
    gate.resolve();
    await runtime.drain();
    await adapter.close();
    vi.restoreAllMocks();
  }
});
