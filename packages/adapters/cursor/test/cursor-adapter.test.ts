import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CursorAdapter,
  CursorTransportError,
  type CursorAcpTransportLike,
  type CursorOpenInput,
  type CursorOpenResult,
  type CursorPermissionRequest,
  type CursorTransportEvent,
} from "../src/index.js";

const initialize: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
};

class FakeCursorTransport implements CursorAcpTransportLike {
  sessionId = "cursor-session";
  loadSessionSupported = true;
  stderrTail = "";
  readonly openCalls: CursorOpenInput[] = [];
  readonly cancel = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  replay: CursorTransportEvent[] = [];
  inspectResult: InitializeResponse = initialize;
  #onEvent: ((event: CursorTransportEvent) => void) | null = null;
  #onPermission: ((request: CursorPermissionRequest) => Promise<RequestPermissionResponse>) | null =
    null;
  #resolve: ((response: PromptResponse) => void) | null = null;
  #reject: ((error: Error) => void) | null = null;

  async inspect(): Promise<InitializeResponse> {
    return this.inspectResult;
  }

  async open(input: CursorOpenInput): Promise<CursorOpenResult> {
    this.openCalls.push(input);
    if (input.kind === "resume") {
      if (
        !this.loadSessionSupported ||
        this.inspectResult.agentCapabilities?.loadSession !== true
      ) {
        throw new CursorTransportError(
          "protocolError",
          "Cursor ACP does not advertise session/load",
        );
      }
      this.sessionId = input.sessionId;
    }
    return {
      initialize: this.inspectResult,
      session: { sessionId: this.sessionId },
      sessionId: this.sessionId,
      loadSessionSupported: this.loadSessionSupported,
      replay: [...this.replay],
    };
  }

  async getHistory(): Promise<CursorTransportEvent[]> {
    return [...this.replay];
  }

  runTurn(
    _text: string,
    onEvent: (event: CursorTransportEvent) => void,
    onPermission: (request: CursorPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse> {
    this.#onEvent = onEvent;
    this.#onPermission = onPermission;
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  event(event: CursorTransportEvent): void {
    this.#onEvent?.(event);
  }

  finish(response: PromptResponse = { stopReason: "end_turn" }): void {
    this.#resolve?.(response);
    this.#resolve = null;
    this.#reject = null;
  }

  fail(error: Error): void {
    this.#reject?.(error);
    this.#resolve = null;
    this.#reject = null;
  }

  permission(): Promise<RequestPermissionResponse> {
    if (!this.#onPermission) throw new Error("No active Cursor Prompt");
    return this.#onPermission({
      request: {
        sessionId: this.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Read file" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
  }
}

async function nextEvent(
  iterator: AsyncIterator<HarnessOutput>,
): Promise<Extract<HarnessOutput, { kind: "event" }>["event"]> {
  const result = await iterator.next();
  if (result.done) throw new Error("Cursor output ended unexpectedly");
  if (result.value.kind !== "event") throw new Error("Expected Cursor Event");
  return result.value.event;
}

function turnId(suffix: string) {
  return hostTurnIdSchema.parse(`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`);
}

describe("Cursor Adapter", () => {
  it("inspects without creating a user Session", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      catalog: { models: [], thinkingOptions: [] },
      capabilities: {
        configuration: {
          selectModel: false,
          selectThinkingOption: false,
          selectPermissionMode: false,
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    });
    expect(transport.openCalls).toEqual([]);
    await adapter.close();
  });

  it("passes spawn cwd and delegation environment to the transport", async () => {
    const transport = new FakeCursorTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new CursorAdapter({}, { randomUUID: () => "id", createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_TOKEN: "token",
      },
    });
    expect(opened.ok).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/synthetic",
        environment: expect.objectContaining({
          CODEXHOST_CLI_PATH: "/opt/codexhost",
          CODEXHOST_RUNTIME_TOKEN: "token",
        }),
      }),
    );
    await adapter.close();
  });

  it("streams assistant text and completes a Turn with a stable Native Turn Ref", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "cursor-item", createTransport: () => transport },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const id = turnId("1");
    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId: id,
        input: [{ type: "text", text: "hi" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: id } });
    expect((await nextEvent(outputs)).type).toBe("turn.started");
    transport.event({ type: "agent.text", text: "hello" });
    expect((await nextEvent(outputs)).type).toBe("item.started");
    expect((await nextEvent(outputs)).type).toBe("item.updated");
    transport.finish();
    expect((await nextEvent(outputs)).type).toBe("item.completed");
    const completed = await nextEvent(outputs);
    expect(completed).toMatchObject({
      type: "turn.completed",
      turnId: id,
      nativeTurnRef: {
        harnessId: "cursor",
        nativeSessionId: "cursor-session",
        nativeTurnKey: "cursor-session:1",
      },
      outcome: { status: "succeeded" },
    });
    await adapter.close();
  });

  it("emits only the delta from cumulative command output updates", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "cursor-tool-item", createTransport: () => transport },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await opened.value.execute({
      type: "turn.start",
      turnId: turnId("8"),
      input: [{ type: "text", text: "run" }],
    });
    expect((await nextEvent(outputs)).type).toBe("turn.started");
    transport.event({
      type: "tool.call",
      callId: "command-1",
      title: "Run command",
      kind: "execute",
      status: "pending",
      rawInput: { command: "printf ab" },
    });
    expect((await nextEvent(outputs)).type).toBe("item.started");
    transport.event({
      type: "tool.update",
      callId: "command-1",
      status: "in_progress",
      rawOutput: "a",
    });
    await expect(nextEvent(outputs)).resolves.toMatchObject({
      type: "item.updated",
      update: { type: "output.append", text: "a" },
    });
    transport.event({
      type: "tool.update",
      callId: "command-1",
      status: "in_progress",
      rawOutput: "ab",
    });
    await expect(nextEvent(outputs)).resolves.toMatchObject({
      type: "item.updated",
      update: { type: "output.append", text: "b" },
    });
    transport.event({
      type: "tool.update",
      callId: "command-1",
      status: "completed",
      rawOutput: "ab",
    });
    expect((await nextEvent(outputs)).type).toBe("item.completed");
    transport.finish();
    expect((await nextEvent(outputs)).type).toBe("turn.completed");
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.items[0]?.item).toMatchObject({
      type: "commandExecution",
      output: "ab",
    });
    await adapter.close();
  });

  it("rejects a second Turn while one is active", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.execute({
      type: "turn.start",
      turnId: turnId("2"),
      input: [{ type: "text", text: "first" }],
    });
    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId: turnId("3"),
        input: [{ type: "text", text: "second" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy", retryable: true } });
    transport.finish();
    await adapter.close();
  });

  it("cancels the active Turn", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const id = turnId("4");
    await opened.value.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "cancel me" }],
    });
    expect((await nextEvent(outputs)).type).toBe("turn.started");
    await expect(opened.value.execute({ type: "turn.cancel", turnId: id })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.cancel).toHaveBeenCalledOnce();
    transport.finish({ stopReason: "cancelled" });
    await expect(nextEvent(outputs)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await adapter.close();
  });

  it("faults the Session on an abnormal transport exit", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await opened.value.execute({
      type: "turn.start",
      turnId: turnId("5"),
      input: [{ type: "text", text: "crash" }],
    });
    expect((await nextEvent(outputs)).type).toBe("turn.started");
    transport.fail(
      new CursorTransportError("processExited", "Cursor ACP exited (code=3, signal=null)"),
    );
    await expect(nextEvent(outputs)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "processExited" } },
    });
    await adapter.close();
  });

  it("resumes the same Native Session and snapshot", async () => {
    const live = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "cursor-item", createTransport: () => live },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await opened.value.execute({
      type: "turn.start",
      turnId: turnId("6"),
      input: [{ type: "text", text: "before" }],
    });
    expect((await nextEvent(outputs)).type).toBe("turn.started");
    live.event({ type: "agent.text", text: "answer" });
    expect((await nextEvent(outputs)).type).toBe("item.started");
    expect((await nextEvent(outputs)).type).toBe("item.updated");
    live.finish();
    expect((await nextEvent(outputs)).type).toBe("item.completed");
    const completed = await nextEvent(outputs);
    if (completed.type !== "turn.completed" || !completed.nativeTurnRef) {
      throw new Error("Live Cursor Turn has no Native identity");
    }
    await adapter.close();

    const resumedTransport = new FakeCursorTransport();
    resumedTransport.replay = [
      { type: "user.text", text: "before" },
      { type: "agent.text", text: "answer" },
    ];
    const resumedAdapter = new CursorAdapter(
      {},
      { randomUUID: () => "resume-id", createTransport: () => resumedTransport },
    );
    const resumed = await resumedAdapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor",
        nativeSessionId: "cursor-session",
        formatVersion: 1,
      }),
    });
    if (!resumed.ok) throw new Error(resumed.error.message);
    const snapshot = await resumed.value.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual(completed.nativeTurnRef);
    expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "before" }]);
    await resumedAdapter.close();
  });

  it("preserves chunked user input and tool ordering in resumed history", async () => {
    const transport = new FakeCursorTransport();
    transport.replay = [
      { type: "user.text", text: "be", messageId: "user-1" },
      { type: "user.text", text: "fore", messageId: "user-1" },
      { type: "agent.text", text: "first" },
      {
        type: "tool.call",
        callId: "command-1",
        title: "Run command",
        kind: "execute",
        status: "pending",
        rawInput: { command: "printf done" },
      },
      {
        type: "tool.update",
        callId: "command-1",
        status: "completed",
        rawOutput: "done",
      },
      { type: "agent.text", text: "after" },
    ];
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "resume-item", createTransport: () => transport },
    );
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor",
        nativeSessionId: "cursor-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns).toHaveLength(1);
    expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "before" }]);
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "agentMessage",
      "commandExecution",
      "agentMessage",
    ]);
    expect(snapshot.value.turns[0]?.items[1]?.item).toMatchObject({
      type: "commandExecution",
      output: "done",
    });
    await adapter.close();
  });

  it("returns unsupported when ACP does not advertise resume", async () => {
    const transport = new FakeCursorTransport();
    transport.loadSessionSupported = false;
    transport.inspectResult = { protocolVersion: 1, agentCapabilities: { loadSession: false } };
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/synthetic",
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "cursor",
        nativeSessionId: "cursor-session",
        formatVersion: 1,
      }),
    });
    expect(opened).toMatchObject({ ok: false, error: { code: "unsupported" } });
    await adapter.close();
  });

  it("rejects unattended-full-access and projects ACP permission requests", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "approval-id", createTransport: () => transport },
    );
    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        executionPolicy: "unattended-full-access",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const id = turnId("7");
    await opened.value.execute({
      type: "turn.start",
      turnId: id,
      input: [{ type: "text", text: "need permission" }],
    });
    expect((await nextEvent(outputs)).type).toBe("turn.started");
    const permission = transport.permission();
    const interaction = await outputs.next();
    if (interaction.done || interaction.value.kind !== "interaction") {
      throw new Error("Expected Cursor Approval");
    }
    expect(interaction.value.interaction).toMatchObject({
      type: "approval",
      title: "Read file",
    });
    await opened.value.execute({
      type: "interaction.respond",
      interactionId: interaction.value.interaction.interactionId,
      response: { type: "approval", actionId: "native-1" },
    });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    transport.finish();
    await adapter.close();
  });

  it("rejects fork and rollback as unsupported", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "cursor",
      nativeSessionId: "cursor-session",
      formatVersion: 1,
    });
    await expect(
      adapter.open({
        kind: "fork",
        sourceRef: nativeRef,
        checkpoint: {
          harnessId: adapter.harnessId,
          nativeSessionId: "cursor-session",
          checkpointId: "1",
          formatVersion: 1,
        },
        cwd: "/synthetic",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      adapter.open({ kind: "rollbackLastTurn", sourceRef: nativeRef, cwd: "/synthetic" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await adapter.close();
  });

  it("keeps concurrent Sessions isolated", async () => {
    const first = new FakeCursorTransport();
    first.sessionId = "session-a";
    const second = new FakeCursorTransport();
    second.sessionId = "session-b";
    const transports = [first, second];
    const adapter = new CursorAdapter(
      {},
      {
        randomUUID: () => "id",
        createTransport: () => transports.shift() ?? new FakeCursorTransport(),
      },
    );
    const a = await adapter.open({ kind: "create", cwd: "/one" });
    const b = await adapter.open({ kind: "create", cwd: "/two" });
    if (!a.ok || !b.ok) throw new Error("expected two Cursor Sessions");
    expect(a.value.initialState.nativeRef?.nativeSessionId).toBe("session-a");
    expect(b.value.initialState.nativeRef?.nativeSessionId).toBe("session-b");
    await adapter.close();
  });

  it("closes the transport when the Adapter closes", async () => {
    const transport = new FakeCursorTransport();
    const adapter = new CursorAdapter(
      {},
      { randomUUID: () => "id", createTransport: () => transport },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    await adapter.close();
    await adapter.close();
    expect(transport.close).toHaveBeenCalled();
  });
});
