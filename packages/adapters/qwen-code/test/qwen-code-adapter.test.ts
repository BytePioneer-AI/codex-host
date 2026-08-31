import type {
  InitializeResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  QwenCodeOpenResult,
  QwenCodePermissionRequest,
  QwenCodeTransportEvent,
} from "../src/acp-transport.js";
import type { QwenCodeAcpTransportLike } from "../src/qwen-code-adapter.js";
import { QwenCodeAdapter } from "../src/qwen-code-adapter.js";
import type { HarnessSession } from "@codexhost/harness-adapter";

const SESSION_MODELS = {
  currentModelId: "GLM-5.3-flash(openai)",
  availableModels: [
    {
      modelId: "GLM-5.3-flash(openai)",
      name: "[Z.AI] GLM-5.3-flash",
      _meta: { contextLimit: 1_000_000 },
    },
    { modelId: "deepseek-v3.2(openai)", name: "DeepSeek v3.2", _meta: { contextLimit: 131_072 } },
  ],
};

class FakeTransport implements QwenCodeAcpTransportLike {
  sessionId = "qwen-session-1";
  stderrTail = "";
  openResult: QwenCodeOpenResult;
  runTurnImplementation:
    | ((
        onEvent: (event: QwenCodeTransportEvent) => void,
        onPermission: (request: QwenCodePermissionRequest) => Promise<RequestPermissionResponse>,
      ) => Promise<PromptResponse>)
    | null = null;
  readonly setModelCalls: string[] = [];
  readonly setModeCalls: HarnessPermissionModeId[] = [];
  closed = false;

  constructor(openResult: Partial<QwenCodeOpenResult> = {}) {
    this.openResult = {
      initialize: {} as InitializeResponse,
      session: {} as QwenCodeOpenResult["session"],
      sessionId: this.sessionId,
      replay: [],
      resumed: false,
      models: SESSION_MODELS,
      ...openResult,
    };
  }

  async inspect(): Promise<{ initialize: InitializeResponse; models: unknown }> {
    return { initialize: {} as InitializeResponse, models: SESSION_MODELS };
  }

  async open(): Promise<QwenCodeOpenResult> {
    return this.openResult;
  }

  runTurn(
    _text: string,
    onEvent: (event: QwenCodeTransportEvent) => void,
    onPermission: (request: QwenCodePermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse> {
    if (!this.runTurnImplementation) {
      throw new Error("FakeTransport has no Turn implementation");
    }
    return this.runTurnImplementation(onEvent, onPermission);
  }

  async setModel(nativeModelId: string): Promise<void> {
    this.setModelCalls.push(nativeModelId);
  }

  async setPermissionMode(permissionModeId: HarnessPermissionModeId): Promise<void> {
    this.setModeCalls.push(permissionModeId);
  }

  async cancel(): Promise<void> {
    this.runTurnImplementation = null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createAdapter(transport: FakeTransport): {
  adapter: QwenCodeAdapter;
  events: Array<{ kind: string; event?: { type?: string }; interaction?: unknown }>;
} {
  const records: Array<Record<string, unknown>> = [];
  const adapter = new QwenCodeAdapter(
    {},
    {
      createTransport: () => transport,
      randomUUID: (() => {
        let sequence = 0;
        return () => `item-${++sequence}`;
      })(),
    },
  );
  return {
    adapter,
    events: records as Array<{ kind: string; event?: { type?: string }; interaction?: unknown }>,
  };
}

async function collectOutputs(
  session: HarnessSession,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  void (async () => {
    for await (const output of session.outputs) records.push(output as Record<string, unknown>);
  })();
}

function hostEvents(records: Array<Record<string, unknown>>): Array<{ type?: string }> {
  return records
    .filter((record) => record.kind === "event")
    .map((record) => record.event as { type?: string });
}

describe("QwenCodeAdapter", () => {
  it("inspects the CLI into a ready Harness Inspection", async () => {
    const transport = new FakeTransport();
    const { adapter } = createAdapter(transport);
    const inspection = await adapter.inspect();
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") return;
    expect(inspection.catalog.models.map(({ ref }) => ref.id)).toEqual([
      "GLM-5.3-flash-openai",
      "deepseek-v3.2-openai",
    ]);
    expect(inspection.permissionModes?.modes.map(({ id }) => id)).toEqual([
      "plan",
      "default",
      "auto-edit",
      "auto",
      "yolo",
    ]);
    expect(inspection.capabilities).toEqual({
      configuration: {
        selectModel: true,
        selectThinkingOption: false,
        selectPermissionMode: true,
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    });
    expect(transport.closed).toBe(true);
  });

  it("opens a create Session with the requested Model and Permission Mode", async () => {
    const transport = new FakeTransport();
    const { adapter } = createAdapter(transport);
    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      model: harnessModelRefSchema.parse({ id: "deepseek-v3.2-openai" }),
      permissionModeId: "plan" as HarnessPermissionModeId,
    });
    expect(opened).toEqual({ ok: true, value: expect.anything() });
    if (!opened.ok) return;
    expect(transport.setModelCalls).toEqual(["deepseek-v3.2(openai)"]);
    expect(transport.setModeCalls).toEqual(["plan"]);
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { harnessId: "qwen-code", nativeSessionId: "qwen-session-1", formatVersion: 1 },
      effectiveModel: { id: "deepseek-v3.2-openai" },
      effectivePermissionModeId: "plan",
    });
    expect(opened.value.capabilities.configuration.selectThinkingOption).toBe(false);
    await opened.value.close();
  });
  it("uses yolo for unattended creates without an explicit Permission Mode", async () => {
    const transport = new FakeTransport();
    const { adapter } = createAdapter(transport);
    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      executionPolicy: "unattended-full-access",
    });
    expect(opened).toEqual({ ok: true, value: expect.anything() });
    expect(transport.setModeCalls).toEqual(["yolo"]);
    if (opened.ok) await opened.value.close();
  });

  it("passes a delegated Session environment into create and resume transports", async () => {
    const transports = [new FakeTransport(), new FakeTransport()];
    const createTransport = vi.fn(() => {
      const transport = transports.shift();
      if (!transport) throw new Error("Missing FakeTransport");
      return transport;
    });
    const adapter = new QwenCodeAdapter({}, { createTransport, randomUUID: () => "item-1" });
    const environment = { CODEXHOST_DELEGATION_THREAD_ID: "child-thread-1" };
    const created = await adapter.open({ kind: "create", cwd: "/tmp", environment });
    if (!created.ok) throw new Error("create failed");
    await created.value.close();
    const resumed = await adapter.open({
      kind: "resume",
      cwd: "/tmp",
      environment,
      nativeRef: {
        harnessId: harnessIdSchema.parse("qwen-code"),
        nativeSessionId: "qwen-session-1",
        formatVersion: 1,
      },
    });
    if (!resumed.ok) throw new Error("resume failed");
    await resumed.value.close();
    expect(createTransport).toHaveBeenNthCalledWith(1, expect.objectContaining({ environment }));
    expect(createTransport).toHaveBeenNthCalledWith(2, expect.objectContaining({ environment }));
  });

  it("streams a Turn into Host Items, Usage, and a snapshot Turn", async () => {
    const transport = new FakeTransport();
    transport.runTurnImplementation = (onEvent) => {
      onEvent({ type: "agent.thought", text: "think" });
      onEvent({ type: "agent.text", text: "OK" });
      onEvent({
        type: "agent.text",
        text: "!",
        metadata: { usage: { inputTokens: 100, outputTokens: 4, totalTokens: 104 } },
      });
      onEvent({
        type: "usage",
        metadata: { usage: { inputTokens: 100, outputTokens: 4, totalTokens: 104 } },
      });
      onEvent({
        type: "usage",
        update: { sessionUpdate: "usage_update", used: 104, size: 1_000_000 } as never,
      });
      return Promise.resolve({ stopReason: "end_turn" } as PromptResponse);
    };
    const { adapter, events } = createAdapter(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    await collectOutputs(opened.value, events);
    const accepted = await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hi" }],
    });
    expect(accepted).toEqual({ ok: true, value: { turnId: "turn-1" } });
    await vi.waitFor(() => {
      expect(hostEvents(events).some(({ type }) => type === "turn.completed")).toBe(true);
    });
    const eventsByType = hostEvents(events).map(({ type }) => type);
    expect(eventsByType).toEqual([
      "turn.started",
      "item.started",
      "item.updated",
      "item.completed",
      "item.started",
      "item.updated",
      "item.updated",
      "session.usage.changed",
      "item.completed",
      "turn.completed",
    ]);
    const snapshot = await opened.value.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.turns).toHaveLength(1);
    expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual({
      harnessId: harnessIdSchema.parse("qwen-code"),
      nativeSessionId: "qwen-session-1",
      nativeTurnKey: "qwen-turn-0",
      formatVersion: 1,
    });
    expect(snapshot.value.turns[0]?.outcome).toEqual({ status: "succeeded" });
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "reasoning",
      "agentMessage",
    ]);
    const agentText = snapshot.value.turns[0]?.items.find(
      ({ item }) => item.type === "agentMessage",
    );
    expect(agentText?.item).toMatchObject({ text: "OK!" });
    await opened.value.close();
  });

  it("routes tool approvals through Host interactions", async () => {
    const transport = new FakeTransport();
    const permissionRequest: QwenCodePermissionRequest = {
      request: {
        sessionId: "qwen-session-1",
        toolCall: { toolCallId: "call-1", title: "Run git status" },
        options: [
          { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
          { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
        ],
      } as unknown as RequestPermissionRequest,
      options: [
        { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
        { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
      ] as PermissionOption[],
    };
    transport.runTurnImplementation = (onEvent, onPermission) =>
      onPermission(permissionRequest).then((response) => {
        expect(response).toEqual({ outcome: { outcome: "selected", optionId: "opt-allow" } });
        onEvent({
          type: "tool.call",
          callId: "call-1",
          title: "Run git status",
          kind: "execute",
          status: "completed",
          rawInput: { command: "git status" },
        });
        return { stopReason: "end_turn" } as PromptResponse;
      });
    const { adapter, events } = createAdapter(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    await collectOutputs(opened.value, events);
    void opened.value
      .execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "check status" }],
      })
      .then(() => undefined);
    await vi.waitFor(() => {
      expect(events.some(({ kind }) => kind === "interaction")).toBe(true);
    });
    const interaction = events.find(({ kind }) => kind === "interaction")?.interaction as {
      interactionId: string;
      actions: Array<{ id: string; effect: string }>;
    };
    expect(interaction.actions).toEqual([
      { id: "native-1", label: "Allow", effect: "allowOnce" },
      { id: "native-2", label: "Deny", effect: "deny" },
    ]);
    const responded = await opened.value.execute({
      type: "interaction.respond",
      interactionId: hostInteractionIdSchema.parse(interaction.interactionId),
      response: { type: "approval", actionId: "native-1" },
    });
    expect(responded).toEqual({ ok: true, value: { accepted: true } });
    await vi.waitFor(() => {
      expect(hostEvents(events).some(({ type }) => type === "turn.completed")).toBe(true);
    });
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "commandExecution",
    ]);
    await opened.value.close();
  });

  it("propagates native mode changes during a Turn", async () => {
    const transport = new FakeTransport();
    transport.runTurnImplementation = (onEvent) => {
      onEvent({ type: "mode.changed", modeId: "plan" });
      onEvent({ type: "agent.text", text: "planning" });
      return Promise.resolve({ stopReason: "end_turn" } as PromptResponse);
    };
    const { adapter, events } = createAdapter(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    await collectOutputs(opened.value, events);
    void opened.value
      .execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "plan" }],
      })
      .then(() => undefined);
    await vi.waitFor(() => {
      expect(hostEvents(events).some(({ type }) => type === "session.state.changed")).toBe(true);
    });
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.state?.effectivePermissionModeId).toBe("plan");
    await opened.value.close();
  });

  it("rebuilds snapshot Turns and Usage from replay on resume", async () => {
    const transport = new FakeTransport({
      resumed: true,
      replay: [
        { type: "user.text", text: "past question" },
        { type: "agent.text", text: "past answer" },
        {
          type: "usage",
          metadata: { usage: { inputTokens: 50, outputTokens: 2, totalTokens: 52 } },
        },
      ],
    });
    const { adapter } = createAdapter(transport);
    const knownTurnRef = {
      harnessId: harnessIdSchema.parse("qwen-code"),
      nativeSessionId: "qwen-session-1",
      nativeTurnKey: "qwen-turn-0",
      formatVersion: 1 as const,
    };
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/tmp",
      nativeRef: {
        harnessId: harnessIdSchema.parse("qwen-code"),
        nativeSessionId: "qwen-session-1",
        formatVersion: 1,
      },
      knownTurnRefs: [knownTurnRef],
    });
    if (!opened.ok) throw new Error("open failed");
    expect(opened.value.initialUsage).toEqual({
      inputTokens: 50,
      outputTokens: 2,
      totalTokens: 52,
      contextUsedTokens: 52,
      contextWindowTokens: 1_000_000,
    });
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "qwen-turn-0",
    ]);
    expect(snapshot.value.turns[0]?.outcome.status).toBe("unknown");
    await opened.value.close();
  });

  it("rejects Fork, rollback, foreign Sessions, and unknown Models", async () => {
    const transport = new FakeTransport();
    const { adapter } = createAdapter(transport);
    const forked = await adapter.open({
      kind: "fork",
      cwd: "/tmp",
      sourceRef: {
        harnessId: harnessIdSchema.parse("qwen-code"),
        nativeSessionId: "qwen-session-1",
        formatVersion: 1,
      },
      checkpoint: {
        harnessId: harnessIdSchema.parse("qwen-code"),
        nativeSessionId: "qwen-session-1",
        checkpointId: "0",
        formatVersion: 1,
      },
    });
    expect(forked).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const rolled = await adapter.open({
      kind: "rollbackLastTurn",
      cwd: "/tmp",
      sourceRef: {
        harnessId: harnessIdSchema.parse("qwen-code"),
        nativeSessionId: "qwen-session-1",
        formatVersion: 1,
      },
    });
    expect(rolled).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const foreign = await adapter.open({
      kind: "resume",
      cwd: "/tmp",
      nativeRef: {
        harnessId: harnessIdSchema.parse("grok"),
        nativeSessionId: "other",
        formatVersion: 1,
      },
    });
    expect(foreign).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    const selected = await opened.value.execute({
      type: "model.select",
      model: harnessModelRefSchema.parse({ id: "missing" }),
    });
    expect(selected).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const thinking = await opened.value.execute({
      type: "thinking.select",
      thinkingOptionId: "balanced" as never,
    });
    expect(thinking).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await opened.value.close();
  });

  it("cancels an active Turn and resolves pending approvals", async () => {
    const transport = new FakeTransport();
    const permissionRequest: QwenCodePermissionRequest = {
      request: {
        sessionId: "qwen-session-1",
        toolCall: { toolCallId: "call-1", title: "Run git status" },
        options: [{ optionId: "opt-allow", name: "Allow", kind: "allow_once" }],
      } as unknown as RequestPermissionRequest,
      options: [{ optionId: "opt-allow", name: "Allow", kind: "allow_once" }] as PermissionOption[],
    };
    transport.runTurnImplementation = (onEvent, onPermission) =>
      onPermission(permissionRequest).then((response) => {
        expect(response).toEqual({ outcome: { outcome: "cancelled" } });
        return { stopReason: "cancelled" } as PromptResponse;
      });
    const { adapter, events } = createAdapter(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    await collectOutputs(opened.value, events);
    void opened.value
      .execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "check status" }],
      })
      .then(() => undefined);
    await vi.waitFor(() => {
      expect(events.some(({ kind }) => kind === "interaction")).toBe(true);
    });
    const cancelResult = await opened.value.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("turn-1"),
    });
    expect(cancelResult).toEqual({ ok: true, value: { cancellationRequested: true } });
    await vi.waitFor(() => {
      expect(hostEvents(events).some(({ type }) => type === "turn.completed")).toBe(true);
    });
    const completed = hostEvents(events).find(({ type }) => type === "turn.completed");
    expect(completed).toMatchObject({ outcome: { status: "cancelled" } });
    const closed = hostEvents(events).filter(({ type }) => type === "interaction.closed");
    expect(closed).toHaveLength(1);
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.turns[0]?.outcome).toMatchObject({ status: "cancelled" });
    await opened.value.close();
  });

  it("drops answered approvals and open tools at Turn end", async () => {
    const transport = new FakeTransport();
    transport.runTurnImplementation = (onEvent) => {
      onEvent({
        type: "tool.call",
        callId: "call-1",
        title: "long tool",
        kind: "execute",
        rawInput: { command: "sleep 100" },
      });
      return Promise.resolve({ stopReason: "end_turn" } as PromptResponse);
    };
    const { adapter, events } = createAdapter(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    await collectOutputs(opened.value, events);
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "run" }],
    });
    await vi.waitFor(() => {
      expect(hostEvents(events).some(({ type }) => type === "turn.completed")).toBe(true);
    });
    transport.runTurnImplementation = (onEvent) => {
      onEvent({ type: "agent.text", text: "clean turn" });
      return Promise.resolve({ stopReason: "end_turn" } as PromptResponse);
    };
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-2"),
      input: [{ type: "text", text: "again" }],
    });
    await vi.waitFor(() => {
      expect(hostEvents(events).filter(({ type }) => type === "turn.completed")).toHaveLength(2);
    });
    const snapshot = await opened.value.readSnapshot();
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.turns).toHaveLength(2);
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "commandExecution",
    ]);
    expect(snapshot.value.turns[1]?.items.map(({ item }) => item.type)).toEqual(["agentMessage"]);
    await opened.value.close();
  });

  it("rejects inspection after the Adapter is closed", async () => {
    const transport = new FakeTransport();
    const { adapter } = createAdapter(transport);
    const first = await adapter.inspect();
    expect(first.status).toBe("ready");
    await adapter.close();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});
