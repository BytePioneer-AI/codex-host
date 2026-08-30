import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "../src/index.js";
import { projectClaudePlanLimitToCredits } from "../src/claude-code-adapter.js";
import { ClaudeCodeExecutableError } from "../src/command.js";
import { CLAUDE_DEFAULT_MODEL_REF, encodeClaudeModelRef } from "../src/model-catalog.js";
import type { ClaudePermissionMode } from "../src/permission-modes.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeApprovalRequest,
  ClaudeAutonomousTurn,
  ClaudeIdleTurnHandler,
  ClaudeInteractionResponse,
  ClaudePlanLimitEvent,
  ClaudeQuestionRequest,
  ClaudeTransportContextUsage,
  ClaudeTransportTurnResult,
  ClaudeTurnEvent,
  ClaudeTurnTransport,
} from "../src/transport.js";

class FakeClaudeTransport implements ClaudeTurnTransport {
  readonly sessionId: string;
  autonomousTurnHandler: ((turn: ClaudeAutonomousTurn) => void) | null = null;
  idleHandler: ClaudeIdleTurnHandler | null = null;
  idleLive = false;
  setAutonomousTurnHandler(handler: (turn: ClaudeAutonomousTurn) => void): void {
    this.autonomousTurnHandler = handler;
  }
  setIdleTurnHandler(handler: ClaudeIdleTurnHandler | null): void {
    this.idleHandler = handler;
  }
  setIdleLive(live: boolean): void {
    this.idleLive = live;
  }
  readonly abort = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  contextUsage: ClaudeTransportContextUsage | null = null;
  permissionMode: ClaudePermissionMode;
  readonly #onPermissionModeChanged: (permissionMode: ClaudePermissionMode) => void;
  readonly getContextUsage = vi.fn(
    async (): Promise<ClaudeTransportContextUsage | null> => this.contextUsage,
  );
  readonly setModel = vi.fn(async () => undefined);
  readonly setThinkingOption = vi.fn(async () => undefined);
  readonly getPermissionMode = vi.fn(() => this.permissionMode);
  readonly setPermissionMode = vi.fn(async (permissionMode: ClaudePermissionMode) => {
    this.permissionMode = permissionMode;
  });
  readonly respondToInteraction = vi.fn(async (response: ClaudeInteractionResponse) => {
    this.event({
      type: "interaction.closed",
      requestId: response.requestId,
      reason: "cancelled" in response ? "cancelled" : "responded",
    });
  });
  readonly start = vi.fn(async () => undefined);
  readonly compactCalls: Array<{ userMessageId: string; customInstructions: string | undefined }> =
    [];
  readonly initCalls: string[] = [];
  readonly recapCalls: string[] = [];
  readonly turns: Array<{ text: string; userMessageId: string }> = [];
  #assistantMessageId: string | null = null;
  #active:
    | {
        onEvent(event: ClaudeTurnEvent): void;
        resolve(result: ClaudeTransportTurnResult): void;
        reject(error: unknown): void;
      }
    | undefined;

  readonly #onPlanLimit: (planLimit: ClaudePlanLimitEvent) => void;

  constructor(
    sessionId: string,
    permissionMode: ClaudePermissionMode,
    onPermissionModeChanged: (permissionMode: ClaudePermissionMode) => void,
    onPlanLimit: (planLimit: ClaudePlanLimitEvent) => void,
  ) {
    this.sessionId = sessionId;
    this.permissionMode = permissionMode;
    this.#onPermissionModeChanged = onPermissionModeChanged;
    this.#onPlanLimit = onPlanLimit;
  }

  changePermissionMode(permissionMode: ClaudePermissionMode): void {
    this.permissionMode = permissionMode;
    this.#onPermissionModeChanged(permissionMode);
  }

  planLimit(planLimit: ClaudePlanLimitEvent): void {
    this.#onPlanLimit(planLimit);
  }

  compact(
    userMessageId: string,
    customInstructions: string | undefined,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.compactCalls.push({ userMessageId, customInstructions });
    return this.#beginCommandTurn(onEvent);
  }

  init(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.initCalls.push(userMessageId);
    return this.#beginCommandTurn(onEvent);
  }

  recap(
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.recapCalls.push(userMessageId);
    return this.#beginCommandTurn(onEvent);
  }

  #beginCommandTurn(onEvent: (event: ClaudeTurnEvent) => void): Promise<ClaudeTransportTurnResult> {
    this.#assistantMessageId = null;
    return new Promise((resolve, reject) => {
      this.#active = { onEvent, resolve, reject };
    });
  }

  runTurn(
    text: string,
    userMessageId: string,
    onEvent: (event: ClaudeTurnEvent) => void,
  ): Promise<ClaudeTransportTurnResult> {
    this.turns.push({ text, userMessageId });
    this.#assistantMessageId = null;
    return new Promise((resolve, reject) => {
      this.#active = { onEvent, resolve, reject };
    });
  }

  event(event: ClaudeTurnEvent): void {
    if (this.#active) {
      this.#active.onEvent(event);
      return;
    }
    if (this.idleLive && this.idleHandler) {
      this.idleHandler.onEvent(event);
      return;
    }
    throw new Error("No active fake Claude Turn");
  }

  approval(request: ClaudeApprovalRequest): void {
    this.event({ type: "interaction.requested", request });
  }

  question(request: ClaudeQuestionRequest): void {
    this.event({ type: "interaction.requested", request });
  }

  delta(text: string, messageId = this.#assistantMessageId ?? "synthetic-assistant"): void {
    this.#assistantMessageId = messageId;
    this.event({ type: "text.delta", messageId, delta: text });
  }

  reasoning(messageId: string, delta: string): void {
    this.#assistantMessageId = messageId;
    this.event({ type: "reasoning.delta", messageId, delta });
  }

  completeReasoning(messageId: string): void {
    this.event({ type: "reasoning.completed", messageId });
  }

  finish(result: ClaudeTransportTurnResult): void {
    if (this.#active) {
      this.#active.resolve(result);
      this.#active = undefined;
      this.#assistantMessageId = null;
      return;
    }
    if (this.idleLive && this.idleHandler) {
      this.idleHandler.onTerminal(result);
      this.#assistantMessageId = null;
      return;
    }
    throw new Error("No active fake Claude Turn");
  }

  fault(error: unknown): void {
    this.#active?.reject(error);
    this.#active = undefined;
    this.#assistantMessageId = null;
  }
}

function fixture(options: ClaudeCodeAdapterOptions = {}) {
  const history: unknown[] = [];
  const transports: FakeClaudeTransport[] = [];
  const inspectors: Array<{
    close: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
  }> = [];
  const inspectInstallation = vi.fn();
  let uuid = 0;
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID: () => `claude-id-${++uuid}`,
    inspectInstallation,
    createInspector: vi.fn(() => {
      const inspector = {
        close: vi.fn(async () => undefined),
        inspect: vi.fn(async () => ({
          models: [
            {
              value: "default",
              displayName: "Default",
              description: "ignored",
              resolvedModel: "runtime-default",
              supportsAutoMode: true,
            },
            {
              value: "sonnet",
              displayName: "Family alias",
              description: "ignored",
              resolvedModel: "runtime-custom",
              supportedEffortLevels: ["low", "adaptive-v2", "high"],
            },
          ],
          canSelectModel: true,
          canSelectPermissionMode: true,
        })),
      };
      inspectors.push(inspector);
      return inspector;
    }),
    deleteSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: "derived-session" })),
    getSessionInfo: vi.fn(async () => ({ cwd: "/synthetic" })),
    readSessionMessages: vi.fn(async () => structuredClone(history)),
    readSubagentMessages: vi.fn(async () => []),
    createTransport: vi.fn((input) => {
      const transport = new FakeClaudeTransport(
        input.sessionId,
        input.permissionMode,
        input.onPermissionModeChanged,
        input.onPlanLimit,
      );
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = new ClaudeCodeAdapter(
    { closeTimeoutMs: 50, continuationQuiescenceMs: 50, ...options },
    dependencies,
  );
  return { adapter, dependencies, history, inspectors, inspectInstallation, transports };
}

async function openSession(
  adapter: ClaudeCodeAdapter,
  environment?: NodeJS.ProcessEnv,
): Promise<HarnessSession> {
  const opened = await adapter.open({
    kind: "create",
    cwd: "/synthetic",
    ...(environment ? { environment } : {}),
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function textTurn(id: string) {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: id }],
  };
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await iterator.next();
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "event") throw new Error("Expected a Harness event output");
  return output.value.event;
}

async function nextInteraction(iterator: AsyncIterator<HarnessOutput>) {
  const output = await iterator.next();
  if (output.done) throw new Error("Harness output ended unexpectedly");
  if (output.value.kind !== "interaction") throw new Error("Expected a Harness Interaction");
  return output.value.interaction;
}

describe("projectClaudePlanLimitToCredits", () => {
  it("returns null when nothing has been observed", () => {
    expect(projectClaudePlanLimitToCredits(null)).toBeNull();
    expect(projectClaudePlanLimitToCredits({})).toBeNull();
  });

  it("leads with the five-hour window and folds the seven-day window into productUsage", () => {
    expect(
      projectClaudePlanLimitToCredits({
        fiveHour: { utilizationPercent: 62, resetsAtUnix: 1_756_130_400 },
        sevenDay: { utilizationPercent: 18, resetsAtUnix: 1_756_648_800 },
      }),
    ).toEqual({
      usedPercent: 62,
      periodType: "five_hour",
      resetsAt: new Date(1_756_130_400 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          usagePercent: 18,
          resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
        },
      ],
    });
  });

  it("omits resetsAt and productUsage when neither is available", () => {
    expect(projectClaudePlanLimitToCredits({ fiveHour: { utilizationPercent: 8 } })).toEqual({
      usedPercent: 8,
      periodType: "five_hour",
    });
  });

  it("falls back to the seven-day window alone", () => {
    expect(
      projectClaudePlanLimitToCredits({
        sevenDay: { utilizationPercent: 41, resetsAtUnix: 1_756_648_800 },
      }),
    ).toEqual({
      usedPercent: 41,
      periodType: "seven_day",
      resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
    });
  });
});

describe("Claude Code HarnessAdapter", () => {
  it("passes per-Session delegation environment to the SDK transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter, {
      CODEXHOST_CLI_PATH: "/opt/codexhost",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
      CODEXHOST_RUNTIME_TOKEN: "token",
      CODEXHOST_THREAD_ID: "thread-1",
    });
    await session.execute(textTurn("environment-turn"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          CODEXHOST_CLI_PATH: "/opt/codexhost",
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
          CODEXHOST_RUNTIME_TOKEN: "token",
          CODEXHOST_THREAD_ID: "thread-1",
        }),
      }),
    );
    await adapter.close();
  });
  it("opens and closes unused Sessions without creating a Transport", async () => {
    const { adapter, dependencies } = fixture();
    const session = await openSession(adapter);

    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("rolls back the last Turn through Claude's Native Fork", async () => {
    const { adapter, dependencies, history } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    history.push(
      {
        type: "user",
        uuid: "user-1",
        session_id: "source-session",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
      {
        type: "user",
        uuid: "user-2",
        session_id: "source-session",
        message: { role: "user", content: "second" },
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    );
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      sessionId === "derived-session"
        ? [
            {
              type: "user",
              uuid: "derived-user-1",
              session_id: "derived-session",
              message: { role: "user", content: "first" },
            },
            {
              type: "assistant",
              uuid: "derived-assistant-1",
              session_id: "derived-session",
              message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
            },
          ]
        : structuredClone(history),
    );

    const opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "assistant-1",
      cwd: path.resolve("/synthetic"),
      sourceSessionId: "source-session",
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{ nativeTurnRef: { nativeSessionId: "derived-session" } }] },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("rejects an empty last-Turn rollback without creating a Transport", async () => {
    const { adapter, dependencies, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });

    await expect(
      adapter.open({ kind: "rollbackLastTurn", sourceRef, cwd: "/synthetic" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
    await adapter.close();
  });

  it("inspects the runtime Model catalog and publishes Claude Code Thinking control", async () => {
    const { adapter, dependencies, inspectors } = fixture();

    const first = await adapter.inspect({ cwd: "/synthetic" });
    expect(first).toMatchObject({
      status: "ready",
      catalog: {
        models: [
          {
            ref: CLAUDE_DEFAULT_MODEL_REF,
            label: "Default",
            resolvedModelLabel: "runtime-default",
          },
          { label: "Family alias", resolvedModelLabel: "runtime-custom" },
        ],
        defaultModel: CLAUDE_DEFAULT_MODEL_REF,
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "auto", label: "Auto" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
        defaultThinkingOptionId: "auto",
      },
      permissionModes: {
        defaultModeId: "default",
        modes: [
          { id: "plan" },
          { id: "default" },
          { id: "acceptEdits" },
          { id: "auto" },
          { id: "bypassPermissions", dangerous: true },
        ],
      },
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: true,
          selectPermissionMode: true,
        },
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        subagents: { observe: true, readTranscript: true },
      },
    });
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toEqual(first);
    expect(dependencies.inspectInstallation).toHaveBeenCalledOnce();
    expect(dependencies.createInspector).toHaveBeenCalledOnce();
    expect(inspectors[0]?.close).toHaveBeenCalledOnce();

    await adapter.inspect({ cwd: "/synthetic", refresh: true });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(2);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const session = await openSession(adapter);
    expect(session.capabilities).toEqual({
      configuration: {
        selectModel: true,
        selectThinkingOption: true,
        selectPermissionMode: true,
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
      subagents: { observe: true, readTranscript: true },
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveThinkingOptionId: "high",
        availableThinkingOptions: [
          { id: "off" },
          { id: "auto" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "max" },
        ],
      },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    const configured = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model: encodeClaudeModelRef("sonnet"),
    });
    expect(configured.ok).toBe(true);
    if (configured.ok) await configured.value.close();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await session.close();
  });

  it("omits Auto when no runtime Model explicitly supports it", async () => {
    const { adapter, dependencies } = fixture();
    vi.mocked(dependencies.createInspector).mockReturnValueOnce({
      inspect: vi.fn(async () => ({
        models: [{ value: "default", displayName: "Custom Model" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      })),
      close: vi.fn(async () => undefined),
    });

    await expect(adapter.inspect({ cwd: "/no-auto" })).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        defaultModeId: "default",
        modes: [
          { id: "plan" },
          { id: "default" },
          { id: "acceptEdits" },
          { id: "bypassPermissions" },
        ],
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    });
  });

  it("coalesces concurrent inspection and does not cache failures or unsupported capability", async () => {
    const { adapter, dependencies } = fixture();
    const pending = deferred<{
      models: unknown[];
      canSelectModel: boolean;
      canSelectPermissionMode: boolean;
    }>();
    const close = vi.fn(async () => undefined);
    vi.mocked(dependencies.createInspector)
      .mockReturnValueOnce({ inspect: () => pending.promise, close })
      .mockReturnValueOnce({
        inspect: async () => {
          throw new Error("synthetic startup failure");
        },
        close,
      })
      .mockReturnValueOnce({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close,
      })
      .mockReturnValueOnce({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close,
      });

    const first = adapter.inspect({ cwd: "/coalesced" });
    const second = adapter.inspect({ cwd: "/coalesced" });
    expect(dependencies.createInspector).toHaveBeenCalledOnce();
    pending.resolve({
      models: [{ value: "default", displayName: "Default" }],
      canSelectModel: true,
      canSelectPermissionMode: true,
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await expect(adapter.inspect({ cwd: "/failure" })).resolves.toMatchObject({
      status: "error",
    });
    await expect(adapter.inspect({ cwd: "/failure" })).resolves.toMatchObject({
      status: "ready",
      catalog: { models: [] },
      capabilities: { configuration: { selectModel: false } },
    });
    await expect(adapter.inspect({ cwd: "/unsupported" })).resolves.toMatchObject({
      status: "ready",
      catalog: { models: [] },
      capabilities: { configuration: { selectModel: false } },
    });
    expect(dependencies.createInspector).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("reports a missing installation without starting a Transport", async () => {
    const { adapter, dependencies, inspectInstallation } = fixture();
    inspectInstallation.mockImplementationOnce(() => {
      throw new ClaudeCodeExecutableError("Claude Code is not installed");
    });

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("restores a Subagent prompt from Parent history when native Child history omits it", async () => {
    const { adapter, dependencies, history } = fixture();
    history.push(
      {
        type: "assistant",
        uuid: "root-agent",
        session_id: "source-session",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "agent-call",
              name: "Agent",
              input: { prompt: "inspect files", description: "Inspect files" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "root-agent-result",
        session_id: "source-session",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-call",
              content: "done\nagentId: native-agent-1 (use SendMessage to continue)",
            },
          ],
        },
      },
    );
    vi.mocked(dependencies.readSubagentMessages).mockResolvedValueOnce([
      {
        type: "assistant",
        uuid: "subagent-answer",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "Inspection done" }] },
      },
    ]);

    await expect(
      adapter.subagents.readSnapshot({
        parent: nativeSessionRefSchema.parse({
          harnessId: "claude-code",
          nativeSessionId: "source-session",
          formatVersion: 1,
        }),
        nativeSubagentId: "native-agent-1",
        cwd: "/synthetic",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "inspect files" }],
            items: [{ item: { type: "agentMessage", text: "Inspection done" } }],
          },
        ],
      },
    });
    expect(dependencies.readSessionMessages).toHaveBeenCalledWith({
      cwd: "/synthetic",
      sessionId: "source-session",
    });
  });

  it("reads and resumes Native history without starting a Transport until the next Turn", async () => {
    const { adapter, dependencies, history, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    history.push(
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "source response" }],
          stop_reason: "end_turn",
        },
      },
    );

    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toEqual({ nativeRef: sourceRef });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: "source-user" },
            input: [{ type: "text", text: "source prompt" }],
            items: [{ item: { type: "agentMessage", text: "source response" } }],
          },
        ],
      },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    await expect(opened.value.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.resolve("/synthetic"),
        sessionId: "source-session",
        openMode: "resume",
      }),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { nativeRef: sourceRef },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await opened.value.close();
  });

  it("defers resumed Query startup until the next Turn and applies the final configuration", async () => {
    const { adapter, dependencies, transports } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "resume-for-selection",
      formatVersion: 1,
    });
    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const alias = encodeClaudeModelRef("sonnet");

    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { nativeRef: sourceRef, effectiveModel: alias },
    });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await nextEvent(iterator);
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await nextEvent(iterator);
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await expect(session.execute(textTurn("configured-turn"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        openMode: "resume",
        sessionId: "resume-for-selection",
        thinkingOptionId: "high",
        permissionMode: "auto",
      }),
    );
    expect(transports[0]?.setModel).not.toHaveBeenCalled();
    expect(transports[0]?.setThinkingOption).not.toHaveBeenCalled();
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("forks an exact Native prefix while later source history continues", async () => {
    const { adapter, dependencies } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "source-assistant-1",
      formatVersion: 1,
    });
    const histories = new Map<string, unknown[]>([
      [
        "source-session",
        [
          {
            type: "user",
            uuid: "source-user-1",
            session_id: "source-session",
            message: { role: "user", content: "first prompt" },
          },
          {
            type: "assistant",
            uuid: "source-assistant-1",
            session_id: "source-session",
            message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
          },
          {
            type: "user",
            uuid: "source-user-2",
            session_id: "source-session",
            message: { role: "user", content: "second prompt" },
          },
          {
            type: "assistant",
            uuid: "source-assistant-2",
            session_id: "source-session",
            message: { role: "assistant", content: [{ type: "text", text: "second response" }] },
          },
        ],
      ],
    ]);
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      structuredClone(histories.get(sessionId) ?? []),
    );
    vi.mocked(dependencies.forkSession).mockImplementationOnce(async () => {
      histories.get("source-session")?.push(
        {
          type: "user",
          uuid: "source-user-3",
          session_id: "source-session",
          message: { role: "user", content: "active prompt" },
        },
        {
          type: "assistant",
          uuid: "source-assistant-3",
          session_id: "source-session",
          message: { role: "assistant", content: [{ type: "text", text: "active response" }] },
        },
      );
      histories.set("derived-session", [
        {
          type: "user",
          uuid: "derived-user-1",
          session_id: "derived-session",
          message: { role: "user", content: "first prompt" },
        },
        {
          type: "assistant",
          uuid: "derived-assistant-1",
          session_id: "derived-session",
          message: { role: "assistant", content: [{ type: "text", text: "first response" }] },
        },
      ]);
      return { sessionId: "derived-session" };
    });

    const opened = await adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "derived-session" },
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeTurnKey: "derived-user-1" },
            checkpoint: { checkpointId: "derived-assistant-1" },
            input: [{ text: "first prompt" }],
          },
        ],
      },
    });
    expect(dependencies.forkSession).toHaveBeenCalledWith({
      checkpointId: "source-assistant-1",
      cwd: path.resolve("/synthetic"),
      sourceSessionId: "source-session",
    });
    expect(dependencies.deleteSession).not.toHaveBeenCalled();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await opened.value.close();
  });

  it("rejects missing resumed history and stale Fork Checkpoints without a Native Fork", async () => {
    const { adapter, dependencies, history } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "stale-checkpoint",
      formatVersion: 1,
    });

    const resumed = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef: sourceRef });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await expect(resumed.value.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    const foreignCheckpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "other-session",
      checkpointId: "foreign-checkpoint",
      formatVersion: 1,
    });
    await expect(
      adapter.open({
        kind: "fork",
        cwd: "/synthetic",
        sourceRef,
        checkpoint: foreignCheckpoint,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    vi.mocked(dependencies.getSessionInfo).mockResolvedValueOnce({ cwd: "/other-workspace" });
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    history.push(
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "source response" }] },
      },
    );
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(dependencies.forkSession).not.toHaveBeenCalled();
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    await resumed.value.close();
  });

  it("deletes a Native Fork whose remapped history is not the requested prefix", async () => {
    const { adapter, dependencies } = fixture();
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: "source-session",
      checkpointId: "source-assistant",
      formatVersion: 1,
    });
    const sourceHistory = [
      {
        type: "user",
        uuid: "source-user",
        session_id: "source-session",
        message: { role: "user", content: "source prompt" },
      },
      {
        type: "assistant",
        uuid: "source-assistant",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "source response" }] },
      },
    ];
    const derivedHistory = [
      {
        type: "user",
        uuid: "derived-user",
        session_id: "derived-session",
        message: { role: "user", content: "wrong prompt" },
      },
      {
        type: "assistant",
        uuid: "derived-assistant",
        session_id: "derived-session",
        message: { role: "assistant", content: [{ type: "text", text: "wrong response" }] },
      },
    ];
    vi.mocked(dependencies.readSessionMessages).mockImplementation(async ({ sessionId }) =>
      structuredClone(sessionId === "derived-session" ? derivedHistory : sourceHistory),
    );

    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(dependencies.deleteSession).toHaveBeenCalledWith({
      cwd: path.resolve("/synthetic"),
      sessionId: "derived-session",
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();
  });

  it("starts lazily and emits a complete text lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.delta("hello");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "hello" },
    });
    transports[0]?.event({
      type: "message.completed",
      messageId: "synthetic-assistant",
      checkpointId: "native-assistant",
    });
    transports[0]?.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "hello" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      nativeTurnRef: {
        harnessId: "claude-code",
        nativeSessionId: transports[0]?.sessionId,
        nativeTurnKey: transports[0]?.turns[0]?.userMessageId,
        formatVersion: 1,
      },
      outcome: {
        status: "succeeded",
        checkpoint: {
          harnessId: "claude-code",
          nativeSessionId: transports[0]?.sessionId,
          checkpointId: "native-assistant",
          formatVersion: 1,
        },
      },
    });
    await session.close();
  });

  it("exposes Claude compact as a command whose native events drive the standard UI lifecycle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");

    await expect(commands.list()).resolves.toMatchObject({
      ok: true,
      value: {
        commands: [
          { id: "claude.compact", invocation: "/compact" },
          { id: "claude.init", invocation: "/init", argumentMode: "none" },
          { id: "claude.recap", invocation: "/recap", argumentMode: "none" },
        ],
      },
    });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("manual-compact"),
        commandId: "claude.compact",
        arguments: { text: "Keep implementation details" },
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "manual-compact" } });

    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.started",
      turnId: "manual-compact",
    });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.contextUsage = { usedTokens: 30, maxTokens: 200, model: "runtime-default" };
    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Manual compaction did not start a Context Compaction Item");
    }
    expect(started).toMatchObject({
      type: "item.started",
      turnId: "manual-compact",
      item: { type: "contextCompaction" },
    });
    transport.event({ type: "compaction.completed", outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      turnId: "manual-compact",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId: "manual-compact",
      outcome: { status: "succeeded" },
    });
    expect(transport.compactCalls).toEqual([
      {
        userMessageId: expect.any(String),
        customInstructions: "Keep implementation details",
      },
    ]);
    expect(transport.turns).toEqual([]);
    await session.close();
  });

  it("validates Claude compact arguments and rejects it while busy", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");

    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("invalid-compact"),
        commandId: "claude.compact",
        arguments: { text: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-argument"),
        commandId: "claude.compact",
        arguments: { text: "ok", extra: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("init-with-args"),
        commandId: "claude.init",
        arguments: { text: "nope" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-command"),
        commandId: "claude.unknown",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("busy"));
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("rejected-compact"),
        commandId: "claude.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    transports[0]?.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
  });

  it("cancels a running Claude compact temporary Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("cancel-compact");

    await commands.execute({ turnId, commandId: "claude.compact" });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "compaction.started" });
    await nextEvent(iterator);

    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      turnId,
      outcome: { status: "cancelled" },
    });
    expect(transport.abort).toHaveBeenCalledOnce();
    await session.close();
  });

  it("runs Claude init as a command Turn that writes through native tools", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("manual-init");

    await expect(commands.execute({ turnId, commandId: "claude.init" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      turnId,
      item: { type: "agentMessage", text: "" },
    });
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Created CLAUDE.md", "init-assistant");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Created CLAUDE.md" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Created CLAUDE.md" } },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.initCalls).toEqual([expect.any(String)]);
    expect(transport.turns).toEqual([]);
    expect(transport.compactCalls).toEqual([]);
    await session.close();
  });

  it("projects Claude recap local output as a one-line Agent Message", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const commands = session.commands;
    if (!commands) throw new Error("Claude Code Session did not expose commands");
    const turnId = hostTurnIdSchema.parse("manual-recap");

    await expect(commands.execute({ turnId, commandId: "claude.recap" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("session.state.changed");
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Built compact command and subagent projection.", "recap-assistant");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Built compact command and subagent projection." },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "agentMessage",
          text: "Built compact command and subagent projection.",
        },
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.recapCalls).toEqual([expect.any(String)]);
    expect(transport.turns).toEqual([]);
    await session.close();
  });

  it("uses one Item identity for a live response and its native history snapshot", async () => {
    const { adapter, history, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("stable-live-history-item"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const liveStarted = await nextEvent(iterator);
    if (liveStarted.type !== "item.started" || liveStarted.item.type !== "agentMessage") {
      throw new Error("Claude live Agent Message did not start");
    }
    const transport = transports[0];
    const nativeTurnKey = transport?.turns[0]?.userMessageId;
    if (!transport || !nativeTurnKey) throw new Error("Fake Claude Turn did not start");

    transport.reasoning("native-message", "one thought");
    const liveReasoningStarted = await nextEvent(iterator);
    if (
      liveReasoningStarted.type !== "item.started" ||
      liveReasoningStarted.item.type !== "reasoning"
    ) {
      throw new Error("Claude live Reasoning did not start");
    }
    await nextEvent(iterator);
    transport.completeReasoning("native-message");
    await nextEvent(iterator);
    transport.delta("one response", "native-message");
    await nextEvent(iterator);
    transport.event({
      type: "message.completed",
      messageId: "native-message",
      checkpointId: "native-assistant",
    });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    history.push(
      {
        type: "user",
        uuid: nativeTurnKey,
        session_id: transport.sessionId,
        message: { role: "user", content: "stable-live-history-item" },
      },
      {
        type: "assistant",
        uuid: "native-thinking",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [{ type: "thinking", thinking: "one thought" }],
          stop_reason: "end_turn",
        },
      },
      {
        type: "assistant",
        uuid: "native-assistant",
        session_id: transport.sessionId,
        message: {
          id: "native-message",
          role: "assistant",
          content: [{ type: "text", text: "one response" }],
          stop_reason: "end_turn",
        },
      },
    );

    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.items.map(({ item }) => item.itemId)).toEqual([
      liveReasoningStarted.item.itemId,
      liveStarted.item.itemId,
    ]);
    await session.close();
  });

  it("projects automatic Compaction and defers Usage refresh until Turn completion", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("automatic-compaction"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Claude Context Compaction Item did not start");
    }

    transport.contextUsage = { usedTokens: 30, maxTokens: 200, model: "runtime-default" };
    transport.event({ type: "compaction.completed", outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    expect(transport.getContextUsage).not.toHaveBeenCalled();

    transport.delta("continued", "assistant-after-compaction");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "continued" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "continued" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("closes an active Compaction Item when the Turn is cancelled", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancel-compaction"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "compaction.started" });
    await nextEvent(iterator);

    await session.execute({ type: "turn.cancel", turnId: textTurn("cancel-compaction").turnId });
    transport.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await session.close();
  });

  it("keeps native Assistant responses in separate Agent Items", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("message-boundaries"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    const firstStarted = await nextEvent(iterator);
    const transport = transports[0];
    if (!transport || firstStarted.type !== "item.started") {
      throw new Error("Fake Claude transport or first Agent Item was not created");
    }

    transport.delta("first", "assistant-1");
    await nextEvent(iterator);
    transport.delta("second", "assistant-2");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { itemId: firstStarted.item.itemId, text: "first" } },
    });
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    await nextEvent(iterator);

    transport.delta("third", "assistant-3");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "second" } },
    });
    const thirdStarted = await nextEvent(iterator);
    await nextEvent(iterator);
    if (secondStarted.type !== "item.started" || thirdStarted.type !== "item.started") {
      throw new Error("Expected Agent Item starts");
    }
    expect(
      new Set([firstStarted.item.itemId, secondStarted.item.itemId, thirdStarted.item.itemId]).size,
    ).toBe(3);

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { itemId: thirdStarted.item.itemId, text: "third" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects distinct visible Reasoning lifecycles before final text", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("reasoning"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.reasoning("assistant-1", "first ");
    const firstStarted = await nextEvent(iterator);
    expect(firstStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "first " },
    });
    transport.reasoning("assistant-1", "analysis");
    await nextEvent(iterator);
    transport.completeReasoning("assistant-1");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "reasoning", text: "first analysis" } },
    });

    transport.reasoning("assistant-2", "second analysis");
    const secondStarted = await nextEvent(iterator);
    expect(secondStarted).toMatchObject({ type: "item.started", item: { type: "reasoning" } });
    if (firstStarted.type !== "item.started" || secondStarted.type !== "item.started") {
      throw new Error("Expected Reasoning Item starts");
    }
    expect(secondStarted.item.itemId).not.toBe(firstStarted.item.itemId);
    await nextEvent(iterator);
    transport.completeReasoning("assistant-2");
    await nextEvent(iterator);
    transport.delta("answer");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "answer" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects bounded Bash and failed Generic Tool lifecycles in native order", async () => {
    const { adapter, transports } = fixture({ toolOutputLimit: 4 });
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("tools"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.delta("before", "assistant-before-tool");
    await nextEvent(iterator);
    transport.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "Bash",
      arguments: { command: "printf complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "before" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "commandExecution",
        command: "printf complete",
        cwd: path.resolve("/synthetic"),
      },
    });
    transport.event({ type: "tool.progress", callId: "bash-1", elapsedMs: 20 });
    transport.event({
      type: "tool.completed",
      callId: "bash-1",
      toolName: "Bash",
      outputText: "complete",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "commandExecution",
          output: "comp",
          outputTruncated: true,
          durationMs: expect.any(Number),
        },
        outcome: { status: "succeeded" },
      },
    });

    transport.event({
      type: "tool.started",
      callId: "read-1",
      toolName: "Read",
      arguments: { file_path: "sample.txt" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Read" },
    });
    transport.event({
      type: "tool.completed",
      callId: "read-1",
      toolName: "Read",
      outputText: "failed output",
      isError: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          output: { content: [{ type: "text", text: "fail" }], truncated: true },
        },
        outcome: { status: "failed", error: { code: "nativeFailure" } },
      },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("projects Claude Agent delegation as one common Subagent Item", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.delta("delegating", "assistant-before-agent");
    await nextEvent(iterator);
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      role: "Explore",
      background: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "delegating" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        subagents: [
          {
            subagentId: "agent-1",
            description: "Inspect implementation",
            role: "Explore",
            background: true,
            status: "running",
          },
        ],
      },
    });
    transport.event({ type: "subagent.transcript.changed", callId: "agent-1" });
    transport.event({
      type: "subagent.updated",
      callId: "agent-1",
      status: "running",
      nativeSubagentId: "native-agent-1",
      resultSummary: "Reading files",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            status: "running",
            nativeSubagentId: "native-agent-1",
            resultSummary: "Reading files",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.event({ type: "subagent.transcript.changed", callId: "agent-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.transcript.changed",
      nativeSubagentId: "native-agent-1",
    });
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      resultSummary: "Agent launched successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [{ status: "completed", resultSummary: "Agent launched successfully" }],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "completed" }] },
        outcome: { status: "succeeded" },
      },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("keeps an async Agent spawn running after its launch Tool Result", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "subagents.replace",
        subagents: [
          {
            status: "running",
            nativeSubagentId: "native-agent-1",
            resultSummary: "Async agent launched successfully",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "running" }] },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.autonomousTurnHandler?.({
      nativeTurnKey: "task-notification-1",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Inspection complete",
        },
        {
          type: "text.delta",
          messageId: "continuation-assistant",
          delta: "Inspection complete",
        },
        {
          type: "message.completed",
          messageId: "continuation-assistant",
          checkpointId: "continuation-checkpoint",
        },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
      resultSummary: "Inspection complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Inspection complete" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Inspection complete" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: transport.turns[0]?.userMessageId },
    });
    await session.close();
  });

  it("cancels a held Root Turn without waiting for background Subagents", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("delegate in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect implementation",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);

    await expect(
      session.execute({
        type: "turn.cancel",
        turnId: hostTurnIdSchema.parse("delegate in background"),
      }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "interrupted",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    expect(transport.abort).not.toHaveBeenCalled();
    await session.close();
  });

  it("keeps an existing Agent running when SendMessage returns", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("send"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "send",
      callId: "send-1",
      nativeSubagentId: "native-agent-1",
      description: "Analyze directory",
      background: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "subagentDelegation", operation: "send" },
    });
    transport.event({
      type: "subagent.completed",
      callId: "send-1",
      isError: false,
      resultSummary: "Message sent successfully",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "subagents.replace", subagents: [{ status: "running" }] },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "subagentDelegation", subagents: [{ status: "running" }] },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    transport.autonomousTurnHandler?.({
      nativeTurnKey: "task-notification-send",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Directory analyzed",
        },
        {
          type: "text.delta",
          messageId: "send-continuation",
          delta: "Directory analyzed",
        },
        { type: "message.completed", messageId: "send-continuation" },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Directory analyzed" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Directory analyzed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
  });

  it("publishes an autonomous Root Turn after background task completion", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Background task launched");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.autonomousTurnHandler?.({
      nativeTurnKey: "task-notification-1",
      events: [
        {
          type: "subagent.settled",
          nativeSubagentId: "native-agent-1",
          status: "completed",
          resultSummary: "Analysis complete",
        },
        {
          type: "text.delta",
          messageId: "autonomous-assistant",
          delta: "Background analysis result",
        },
        {
          type: "message.completed",
          messageId: "autonomous-assistant",
          checkpointId: "autonomous-checkpoint",
        },
      ],
      result: { status: "succeeded" },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.autonomous.started", input: [] });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-1",
      status: "completed",
      resultSummary: "Analysis complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Background analysis result" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Background analysis result" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
      nativeTurnRef: { nativeTurnKey: "task-notification-1" },
    });
    await session.close();
  });

  it("holds the Root Turn until background Subagents and continuations finish", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch three agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.delta("Started three agents");
    await nextEvent(iterator);
    for (const [index, nativeSubagentId] of [
      "native-agent-a",
      "native-agent-b",
      "native-agent-c",
    ].entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: `Inspect ${nativeSubagentId}`,
        background: true,
      });
      await nextEvent(iterator);
      if (index === 0) await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const [index, nativeSubagentId] of [
      "native-agent-a",
      "native-agent-b",
      "native-agent-c",
    ].entries()) {
      transport.autonomousTurnHandler?.({
        nativeTurnKey: `task-notification-${index + 1}`,
        events: [
          {
            type: "subagent.settled",
            nativeSubagentId,
            status: "completed",
            resultSummary: `${nativeSubagentId} done`,
          },
          {
            type: "text.delta",
            messageId: `continuation-${index + 1}`,
            delta: `${nativeSubagentId} done`,
          },
          { type: "message.completed", messageId: `continuation-${index + 1}` },
        ],
        result: { status: "succeeded" },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.started",
        item: { type: "agentMessage" },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.updated",
        update: { type: "text.append", text: `${nativeSubagentId} done` },
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.completed",
        snapshot: { item: { type: "agentMessage", text: `${nativeSubagentId} done` } },
      });
      if (index < 2) {
        continue;
      }
      expect(await nextEvent(iterator)).toMatchObject({
        type: "turn.completed",
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: transport.turns[0]?.userMessageId },
      });
    }
    await session.close();
  });

  it("holds the Root Turn when background Subagents settle before the native result", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch three agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const nativeSubagentIds = ["a419753fbeb78d5bd", "a4c17172923f00231", "a78414260bd2f9554"];
    for (const [index, nativeSubagentId] of nativeSubagentIds.entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: nativeSubagentId,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    // Claude reports every Subagent as settled before the Root Segment ends, but
    // it answers for each of them in a later Segment.
    for (const nativeSubagentId of [...nativeSubagentIds].reverse()) {
      transport.event({
        type: "subagent.settled",
        nativeSubagentId,
        status: "completed",
        resultSummary: `${nativeSubagentId} finished`,
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
    }
    transport.delta("三个agent全部启动完毕");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "三个agent全部启动完毕" } },
    });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const [index, nativeSubagentId] of nativeSubagentIds.entries()) {
      transport.event({ type: "segment.started" });
      transport.delta(`${nativeSubagentId} 已完成`, `continuation-${index + 1}`);
      expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "item.updated",
        update: { type: "text.append", text: `${nativeSubagentId} 已完成` },
      });
      transport.event({ type: "message.completed", messageId: `continuation-${index + 1}` });
      expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
      transport.finish({ status: "succeeded" });
    }
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not complete the Root Turn when a Subagent settles during a continuation", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch two agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    for (const [index, nativeSubagentId] of ["native-agent-1", "native-agent-2"].entries()) {
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId: `agent-${index + 1}`,
        description: `Inspect ${nativeSubagentId}`,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId: `agent-${index + 1}`,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-1",
      callId: "agent-1",
      status: "completed",
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({ type: "segment.started" });
    transport.delta("Agent 1 已完成，等待 Agent 2", "continuation-1");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    await nextEvent(iterator);
    // The second Subagent settles while Claude is still answering for the first.
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-2",
      callId: "agent-2",
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "native-agent-2",
    });
    transport.event({ type: "message.completed", messageId: "continuation-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "Agent 1 已完成，等待 Agent 2" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({ type: "segment.started" });
    transport.delta("Agent 2 已完成", "continuation-2");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "continuation-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "Agent 2 已完成" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not complete a held Turn when Root output arrives without a new Segment", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "agent-1",
      description: "Inspect directory",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "agent-1",
      isError: false,
      continuesInBackground: true,
      nativeSubagentId: "native-agent-1",
      resultSummary: "Async agent launched successfully",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "native-agent-1",
      callId: "agent-1",
      status: "completed",
    });
    await nextEvent(iterator);
    transport.delta("started", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.delta("Inspection complete", "continuation");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "Inspection complete" },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    await expect(session.execute(textTurn("still-busy"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.event({ type: "message.completed", messageId: "continuation" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "Inspection complete" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("completes after interleaved Root end_turn once background Subagents settle", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch three agents in background"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    for (const [index, nativeSubagentId] of [
      "a8b5bcd3a4bf6c508",
      "a47086db7e0c568b6",
      "a372e8a990c9aadf9",
    ].entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: nativeSubagentId,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }

    transport.delta("已并行启动 3 个子 agent", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "已并行启动 3 个子 agent" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.delta("等待三个子 agent 返回检查结果。", "root-2");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "等待三个子 agent 返回检查结果。" },
    });
    transport.event({ type: "message.completed", messageId: "root-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "等待三个子 agent 返回检查结果。" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("still-busy"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const nativeSubagentId of [
      "a8b5bcd3a4bf6c508",
      "a47086db7e0c568b6",
      "a372e8a990c9aadf9",
    ]) {
      transport.event({
        type: "subagent.settled",
        nativeSubagentId,
        status: "completed",
        resultSummary: `${nativeSubagentId} finished`,
      });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
    }

    transport.delta("三份子 agent 已完成，结果一致。", "root-3");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage", text: "" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "三份子 agent 已完成，结果一致。" },
    });
    transport.event({ type: "message.completed", messageId: "root-3" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "三份子 agent 已完成，结果一致。" } },
    });
    await expect(session.execute(textTurn("after-items"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("does not complete a user Turn while launched background Agents are unsettled", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const agents = ["a0e467bb4be68bd08", "a22cd5f001d3795e3", "a5eb0835279350422"] as const;

    await session.execute(textTurn("launch three agents"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    for (const [index, nativeSubagentId] of agents.entries()) {
      const callId = `agent-${index + 1}`;
      transport.event({
        type: "subagent.started",
        operation: "spawn",
        callId,
        description: nativeSubagentId,
        background: true,
      });
      await nextEvent(iterator);
      transport.event({
        type: "subagent.completed",
        callId,
        isError: false,
        continuesInBackground: true,
        nativeSubagentId,
        resultSummary: "Async agent launched successfully",
      });
      await nextEvent(iterator);
      await nextEvent(iterator);
    }
    transport.delta("已启动 3 个子 agent", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "已启动 3 个子 agent" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({
      type: "subagent.settled",
      nativeSubagentId: agents[0],
      status: "completed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: agents[0],
      status: "completed",
    });
    transport.delta("第 1 个子 agent 已完成，另外 2 个仍在执行中。", "root-2");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "第 1 个子 agent 已完成，另外 2 个仍在执行中。" },
    });
    transport.event({ type: "message.completed", messageId: "root-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "第 1 个子 agent 已完成，另外 2 个仍在执行中。" } },
    });
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("still-busy"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    for (const nativeSubagentId of agents.slice(1)) {
      transport.event({ type: "subagent.settled", nativeSubagentId, status: "completed" });
      expect(await nextEvent(iterator)).toMatchObject({
        type: "subagent.state.changed",
        nativeSubagentId,
        status: "completed",
      });
    }
    transport.delta("第 3 个子 agent 已完成。", "root-3");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.updated" });
    transport.event({ type: "message.completed", messageId: "root-3" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "第 3 个子 agent 已完成。" } },
    });
    await expect(session.execute(textTurn("after-items"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("occupies a background spawn from Tool Use and settles it by callId", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("launch without agent id"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "subagent.started",
      operation: "spawn",
      callId: "call_without_id",
      description: "Inspect directory",
      background: true,
    });
    await nextEvent(iterator);
    transport.event({
      type: "subagent.completed",
      callId: "call_without_id",
      isError: false,
      continuesInBackground: true,
      resultSummary: "Async agent launched successfully",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.delta("started", "root-1");
    await nextEvent(iterator);
    transport.event({ type: "message.completed", messageId: "root-1" });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await expect(session.execute(textTurn("follow-up"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    transport.event({
      type: "subagent.settled",
      nativeSubagentId: "late-agent-id",
      callId: "call_without_id",
      status: "completed",
      resultSummary: "Inspection complete",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "subagent.state.changed",
      nativeSubagentId: "late-agent-id",
      status: "completed",
    });
    transport.delta("done", "root-2");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.started" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "text.append", text: "done" },
    });
    transport.event({ type: "message.completed", messageId: "root-2" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { text: "done" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("emits a reliable File Change immediately after a successful Edit", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("edit"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "Edit",
      arguments: { file_path: "/synthetic/sample.txt" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "Edit" },
    });
    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "Edit",
      outputText: "edited",
      isError: false,
      fileChange: {
        path: "/synthetic/sample.txt",
        kind: "update",
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution", toolName: "Edit" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [
          {
            path: "sample.txt",
            kind: "update",
            unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });

    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage", text: "" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await session.close();
  });

  it("keeps successful Edit without native patch evidence Tool-only", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("edit-no-patch"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "Edit",
      arguments: { file_path: "sample.txt" },
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "Edit",
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" } },
    });
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });
    await session.close();
  });

  it("closes active Tools before cancellation and continues on the same Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancel-tool"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "bash-1",
      toolName: "Bash",
      arguments: { command: "sleep 10" },
    });
    await nextEvent(iterator);
    await expect(
      session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("cancel-tool") }),
    ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
    transport.finish({ status: "cancelled", reason: "aborted_tools" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "commandExecution" },
        outcome: { status: "cancelled" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("after-cancel-tool"))).resolves.toMatchObject({
      ok: true,
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transport.delta("continued");
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("fails a successful native result that leaves a Tool unresolved", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("unresolved-tool"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "tool.started",
      callId: "read-1",
      toolName: "Read",
      arguments: {},
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "agentMessage" }, outcome: { status: "failed" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "protocolError" } },
    });
    await session.close();
  });

  it("applies a create-time alias lazily and publishes the configured Model before the Turn", async () => {
    const { adapter, dependencies, transports } = fixture();
    const selected = encodeClaudeModelRef("sonnet");
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("max");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      model: selected,
      thinkingOptionId,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(dependencies.createTransport).not.toHaveBeenCalled();
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("selected-first"))).resolves.toMatchObject({ ok: true });
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sonnet",
        openMode: "create",
        thinkingOptionId: "max",
      }),
    );
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.state.changed",
      state: {
        effectiveModel: selected,
        effectiveThinkingOptionId: "max",
      },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("selects an Idle alias and restores default without Model readback", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-selection"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const contextReadsBeforeSelection = transport.getContextUsage.mock.calls.length;
    const alias = encodeClaudeModelRef("sonnet");
    const selectingAlias = session.execute({ type: "model.select", model: alias });
    const aliasState = await nextEvent(iterator);
    expect(aliasState).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    expect(aliasState).not.toHaveProperty("state.resolvedModelLabel");
    await expect(selectingAlias).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setModel).toHaveBeenLastCalledWith("sonnet");

    const resetting = session.execute({ type: "model.select", model: CLAUDE_DEFAULT_MODEL_REF });
    const defaultState = await nextEvent(iterator);
    expect(defaultState).toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: CLAUDE_DEFAULT_MODEL_REF },
    });
    expect(defaultState).not.toHaveProperty("state.resolvedModelLabel");
    await expect(resetting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setModel).toHaveBeenLastCalledWith(undefined);
    expect(transport.getContextUsage).toHaveBeenCalledTimes(contextReadsBeforeSelection);
    await session.close();
  });

  it("dynamically switches Thinking on an Idle Query", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-thinking"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectiveThinkingOptionId: "high" },
    });
    expect(transport.setThinkingOption).toHaveBeenCalledWith("high");
    await session.close();
  });

  it("defers cold Permission Mode selection and dynamically switches a started Query", async () => {
    const { adapter, dependencies, transports } = fixture();
    const plan = harnessPermissionModeIdSchema.parse("plan");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: plan,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const auto = harnessPermissionModeIdSchema.parse("auto");

    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: auto }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "auto" },
    });
    expect(dependencies.createTransport).not.toHaveBeenCalled();

    await session.execute(textTurn("permission-start"));
    expect(dependencies.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "auto" }),
    );
    expect(transports[0]?.setPermissionMode).not.toHaveBeenCalled();
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transports[0]?.changePermissionMode("acceptEdits");
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: "acceptEdits" },
    });

    transports[0]?.setPermissionMode.mockRejectedValueOnce(new Error("policy rejected"));
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(transports[0]?.permissionMode).toBe("acceptEdits");
    transports[0]?.setPermissionMode.mockRejectedValueOnce(
      new Error("Cannot set permission mode to auto: auto mode unavailable for this model"),
    );
    await expect(
      session.execute({ type: "permissionMode.select", permissionModeId: auto }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "Auto mode is unavailable for the current Claude Code Model",
      },
    });
    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("dontAsk"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.close();
  });

  it("switches Permission Mode on the current Session while a Turn is active", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    await session.execute(textTurn("permission-active"));

    await expect(
      session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transports[0]?.setPermissionMode).toHaveBeenCalledWith("auto");
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("serializes selection and preserves definite Model rejection", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("initialize-failure"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const alias = encodeClaudeModelRef("sonnet");
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    transport.setModel.mockRejectedValueOnce(new Error("policy rejected"));
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure" },
    });

    const contextReadsBeforeSelection = transport.getContextUsage.mock.calls.length;
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectiveModel: alias },
    });
    expect(transport.getContextUsage).toHaveBeenCalledTimes(contextReadsBeforeSelection);
    await session.close();
  });

  it("does not query Context automatically at Assistant, Tool, or Turn boundaries", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("passive-usage"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.event({
      type: "message.completed",
      messageId: "assistant-usage",
      lastRequestUsage: {
        requestId: "request-usage",
        model: "claude-sonnet-4-6",
        provider: "firstParty",
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 70,
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { cacheHitRatePercent: 70, inputTokens: 100, outputTokens: 5 },
    });

    transport.event({
      type: "tool.started",
      callId: "tool-1",
      toolName: "Read",
      arguments: {},
    });
    await nextEvent(iterator);
    transport.event({
      type: "tool.completed",
      callId: "tool-1",
      toolName: "Read",
      isError: false,
    });
    await nextEvent(iterator);
    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("deduplicates completed requests and calibrates estimates with Result totals", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("usage-result"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    const request = {
      requestId: "request-1",
      model: "claude-sonnet-4-6",
      provider: "firstParty",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 70,
    } as const;

    transport.event({
      type: "message.completed",
      messageId: "assistant-1",
      lastRequestUsage: request,
    });
    const estimate = await nextEvent(iterator);
    expect(estimate).toMatchObject({
      type: "session.usage.changed",
      usage: { inputTokens: 100, outputTokens: 5, cacheHitRatePercent: 70 },
    });
    transport.event({
      type: "message.completed",
      messageId: "assistant-1",
      lastRequestUsage: request,
    });
    await Promise.resolve();

    transport.event({
      type: "usage.result",
      totalCostUsd: 1.373,
      modelUsage: [
        { inputTokens: 100, outputTokens: 40 },
        { inputTokens: 20, outputTokens: 5 },
      ],
      lastRequestUsage: {
        inputTokens: 10,
        outputTokens: 45,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 990,
      },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "usage-result",
      usage: {
        totalCostUsd: 1.373,
        inputTokens: 120,
        outputTokens: 45,
        cacheHitRatePercent: 99,
      },
    });
    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(transport.getContextUsage).not.toHaveBeenCalled();
    await session.close();
  });

  it("keeps passive Usage isolated across concurrent Claude Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("session-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);

    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("session-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportA = transports[0];
    const transportB = transports[1];
    if (!transportA || !transportB) throw new Error("Fake Claude transports were not created");

    transportA.event({
      type: "message.completed",
      messageId: "assistant-a",
      lastRequestUsage: {
        requestId: "shared-looking-id",
        inputTokens: 10,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 90,
      },
    });
    transportB.event({
      type: "message.completed",
      messageId: "assistant-b",
      lastRequestUsage: {
        requestId: "shared-looking-id",
        inputTokens: 80,
        outputTokens: 7,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 20,
      },
    });
    expect(await nextEvent(iteratorA)).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 1, cacheHitRatePercent: 90 },
    });
    expect(await nextEvent(iteratorB)).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 7, cacheHitRatePercent: 20 },
    });

    transportA.finish({ status: "succeeded" });
    transportB.finish({ status: "succeeded" });
    for (;;) if ((await nextEvent(iteratorA)).type === "turn.completed") break;
    for (;;) if ((await nextEvent(iteratorB)).type === "turn.completed") break;
    await sessionA.close();
    await sessionB.close();
  });

  it("refreshes exact Context on demand, stops after success, and reuses the TTL", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("exact-context"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.contextUsage = { usedTokens: 80, maxTokens: 200, model: "runtime-default" };

    await session.refreshUsage?.();
    expect(transport.getContextUsage).toHaveBeenCalledOnce();
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "exact-context",
      usage: { contextUsedTokens: 80, contextWindowTokens: 200 },
    });
    await session.refreshUsage?.();
    expect(transport.getContextUsage).toHaveBeenCalledOnce();

    transport.finish({ status: "succeeded" });
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await session.close();
  });

  it("keeps concurrent exact Context refreshes isolated between Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("context-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("context-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportA = transports[0];
    const transportB = transports[1];
    if (!transportA || !transportB) throw new Error("Fake Claude transports were not created");
    transportA.contextUsage = { usedTokens: 30, maxTokens: 100, model: "a" };
    transportB.contextUsage = { usedTokens: 90, maxTokens: 200, model: "b" };

    await Promise.all([sessionA.refreshUsage?.(), sessionB.refreshUsage?.()]);
    expect(transportA.getContextUsage).toHaveBeenCalledOnce();
    expect(transportB.getContextUsage).toHaveBeenCalledOnce();
    expect(await nextEvent(iteratorA)).toMatchObject({
      usage: { contextUsedTokens: 30, contextWindowTokens: 100 },
    });
    expect(await nextEvent(iteratorB)).toMatchObject({
      usage: { contextUsedTokens: 90, contextWindowTokens: 200 },
    });

    transportA.finish({ status: "succeeded" });
    transportB.finish({ status: "succeeded" });
    for (;;) if ((await nextEvent(iteratorA)).type === "turn.completed") break;
    for (;;) if ((await nextEvent(iteratorB)).type === "turn.completed") break;
    await sessionA.close();
    await sessionB.close();
  });

  it("deduplicates concurrent exact Context reads and applies failure cooldown", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("exact-context-failure"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");
      transport.getContextUsage.mockResolvedValue(null);

      const first = session.refreshUsage?.();
      const second = session.refreshUsage?.();
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.all([first, second]);
      expect(transport.getContextUsage).toHaveBeenCalledTimes(3);
      await session.refreshUsage?.();
      expect(transport.getContextUsage).toHaveBeenCalledTimes(3);

      transport.finish({ status: "succeeded" });
      for (;;) {
        if ((await nextEvent(iterator)).type === "turn.completed") break;
      }
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards exact Context that resolves after the Model generation changes", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();
    await session.execute(textTurn("stale-context"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    const pending = deferred<ClaudeTransportContextUsage | null>();
    transport.getContextUsage.mockImplementationOnce(() => pending.promise);
    const refresh = session.refreshUsage?.();
    const alias = encodeClaudeModelRef("sonnet");
    await expect(session.execute({ type: "model.select", model: alias })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await nextEvent(iterator);
    pending.resolve({ usedTokens: 10, maxTokens: 100, model: "old" });
    await refresh;
    expect(transport.getContextUsage).toHaveBeenCalledOnce();
    await session.close();
  });

  it("recovers request Usage from the transcript when the live Assistant Usage is sparse", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, history, transports } = fixture();
      const session = await openSession(adapter);
      const iterator = session.outputs[Symbol.asyncIterator]();
      await session.execute(textTurn("transcript-cache-hit"));
      await nextEvent(iterator);
      await nextEvent(iterator);
      await nextEvent(iterator);
      const transport = transports[0];
      if (!transport) throw new Error("Fake Claude transport was not created");

      transport.event({ type: "message.completed", messageId: "native-request-1" });
      await vi.advanceTimersByTimeAsync(0);
      history.push({
        type: "assistant",
        request_id: "request-1",
        uuid: "assistant-checkpoint-1",
        session_id: "claude-id-1",
        parent_tool_use_id: null,
        provider: "firstParty",
        message: {
          id: "native-request-1",
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 70,
          },
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await nextEvent(iterator)).toMatchObject({
        type: "session.usage.changed",
        usage: { cacheHitRatePercent: 70, inputTokens: 100, outputTokens: 2 },
      });
      transport.finish({ status: "succeeded" });
      for (;;) {
        if ((await nextEvent(iterator)).type === "turn.completed") break;
      }
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits cache hit rate when last-request cache fields are incomplete", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("usage-incomplete-cache"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({
      type: "usage.result",
      totalCostUsd: 0.5,
      modelUsage: [{ inputTokens: 10, outputTokens: 2 }],
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "usage-incomplete-cache",
      usage: { totalCostUsd: 0.5, inputTokens: 10, outputTokens: 2 },
    });
    transport.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("publishes a Claude.ai five-hour plan window and preserves it across a later seven-day window", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 45, resetsAtUnix: 1_756_130_400 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-turn",
      usage: { planFiveHourUsedPercent: 45, planFiveHourResetsAtUnix: 1_756_130_400 },
    });

    transport.planLimit({ sevenDay: { utilizationPercent: 12 } });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-turn",
      usage: {
        planFiveHourUsedPercent: 45,
        planFiveHourResetsAtUnix: 1_756_130_400,
        planSevenDayUsedPercent: 12,
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("publishes both plan windows from a single rate-limit event", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-both-windows"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 28, resetsAtUnix: 1_787_674_200 },
      sevenDay: { utilizationPercent: 10, resetsAtUnix: 1_787_940_000 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-both-windows",
      usage: {
        planFiveHourUsedPercent: 28,
        planFiveHourResetsAtUnix: 1_787_674_200,
        planSevenDayUsedPercent: 10,
        planSevenDayResetsAtUnix: 1_787_940_000,
      },
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("never publishes plan-window fields for an API-key Session that receives no rate-limit event", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("api-key-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");
    transport.event({ type: "usage.result", totalCostUsd: 0.2 });
    const resultUsage = await nextEvent(iterator);
    transport.finish({ status: "succeeded" });

    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    for (const event of [resultUsage]) {
      if (event.type !== "session.usage.changed" || event.usage === null) {
        throw new Error("Expected a Session Usage snapshot");
      }
      expect(event.usage).not.toHaveProperty("planFiveHourUsedPercent");
      expect(event.usage).not.toHaveProperty("planSevenDayUsedPercent");
    }
    await session.close();
  });

  it("drops a malformed plan-limit observation without touching the latest still-applicable Usage", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("plan-malformed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({ fiveHour: { utilizationPercent: 30 } });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: "plan-malformed",
      usage: { planFiveHourUsedPercent: 30 },
    });

    transport.planLimit({ fiveHour: { utilizationPercent: Number.NaN } });
    transport.finish({ status: "succeeded" });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    await session.close();
  });

  it("has no plan usage on the Adapter before any rate-limit event is observed", () => {
    const { adapter } = fixture();
    expect(adapter.credits()).toBeNull();
  });

  it("projects the five-hour window as the primary credits pill, with the seven-day window riding along", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("credits-turn"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({
      fiveHour: { utilizationPercent: 62, resetsAtUnix: 1_756_130_400 },
      sevenDay: { utilizationPercent: 18, resetsAtUnix: 1_756_648_800 },
    });
    await nextEvent(iterator);

    expect(adapter.credits()).toEqual({
      usedPercent: 62,
      periodType: "five_hour",
      resetsAt: new Date(1_756_130_400 * 1000).toISOString(),
      productUsage: [
        {
          product: "7-day window",
          usagePercent: 18,
          resetsAt: new Date(1_756_648_800 * 1000).toISOString(),
        },
      ],
    });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("falls back to the seven-day window alone when no five-hour observation has arrived", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("seven-day-only"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    const transport = transports[0];
    if (!transport) throw new Error("Fake Claude transport was not created");

    transport.planLimit({ sevenDay: { utilizationPercent: 41 } });
    await nextEvent(iterator);

    expect(adapter.credits()).toEqual({ usedPercent: 41, periodType: "seven_day" });

    transport.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("shares one account-wide plan-limit cache across concurrent Sessions", async () => {
    const { adapter, transports } = fixture();
    const sessionA = await openSession(adapter);
    const iteratorA = sessionA.outputs[Symbol.asyncIterator]();
    await sessionA.execute(textTurn("session-a"));
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    const transportA = transports[0];
    if (!transportA) throw new Error("Fake Claude transport was not created");

    const sessionB = await openSession(adapter);
    const iteratorB = sessionB.outputs[Symbol.asyncIterator]();
    await sessionB.execute(textTurn("session-b"));
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    const transportB = transports[1];
    if (!transportB) throw new Error("Fake Claude transport was not created");

    transportA.planLimit({ fiveHour: { utilizationPercent: 33 } });
    await nextEvent(iteratorA);

    // Session B never observed a rate-limit event itself, but reads the same account-wide value.
    expect(adapter.credits()).toEqual({ usedPercent: 33, periodType: "five_hour" });

    transportA.finish({ status: "succeeded" });
    await nextEvent(iteratorA);
    await nextEvent(iteratorA);
    transportB.finish({ status: "succeeded" });
    await nextEvent(iteratorB);
    await nextEvent(iteratorB);
    await sessionA.close();
    await sessionB.close();
  });

  it("reuses one Transport and Native Session for sequential Turns", async () => {
    const { adapter, dependencies, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("turn-1"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("turn-2"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    expect(dependencies.createTransport).toHaveBeenCalledOnce();
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    expect(transports[0]?.turns.map(({ text }) => text)).toEqual(["turn-1", "turn-2"]);
    expect(new Set(transports[0]?.turns.map(({ userMessageId }) => userMessageId)).size).toBe(2);
    await session.close();
  });

  it("rejects a concurrent Turn without disturbing the active Turn", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);

    await session.execute(textTurn("turn-1"));
    await expect(session.execute(textTurn("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("maps independent native Approvals to bounded Host actions and exact responses", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("approvals"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "transport-approval-1",
      title: "Allow Edit?",
      description: "One-shot edit permission",
    });
    transports[0]?.approval({
      type: "approval",
      requestId: "transport-approval-2",
      title: "Allow Bash?",
    });
    const allowInteraction = await nextInteraction(iterator);
    const denyInteraction = await nextInteraction(iterator);
    expect(allowInteraction).toMatchObject({
      type: "approval",
      title: "Allow Edit?",
      description: "One-shot edit permission",
      subject: { type: "nativeAction" },
      actions: [
        { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
    });
    expect(denyInteraction).toMatchObject({ type: "approval", title: "Allow Bash?" });
    expect(allowInteraction.interactionId).not.toBe(denyInteraction.interactionId);
    expect(JSON.stringify(allowInteraction)).not.toContain("transport-approval-1");

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowForSession" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: denyInteraction.interactionId,
        response: { type: "approval", actionId: "deny" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "transport-approval-2",
      decision: "deny",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: denyInteraction.interactionId,
      reason: "responded",
    });

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "transport-approval-1",
      decision: "allowOnce",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: allowInteraction.interactionId,
      reason: "responded",
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: allowInteraction.interactionId,
        response: { type: "approval", actionId: "allowOnce" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps declared native suggestion scopes without exposing suggestions", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("approval-scopes"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "session-approval",
      title: "Allow Edit?",
      suggestedScope: "session",
    });
    transports[0]?.approval({
      type: "approval",
      requestId: "always-approval",
      title: "Allow Bash?",
      suggestedScope: "always",
    });
    const sessionInteraction = await nextInteraction(iterator);
    const alwaysInteraction = await nextInteraction(iterator);
    expect(sessionInteraction).toMatchObject({
      type: "approval",
      actions: expect.arrayContaining([
        {
          id: "allowForSession",
          label: "Allow this conversation",
          effect: "allowForSession",
        },
      ]),
    });
    expect(alwaysInteraction).toMatchObject({
      type: "approval",
      actions: expect.arrayContaining([
        { id: "allowAlways", label: "Always allow", effect: "allowAlways" },
      ]),
    });
    expect(JSON.stringify([sessionInteraction, alwaysInteraction])).not.toContain(
      "session-approval",
    );

    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: sessionInteraction.interactionId,
        response: { type: "approval", actionId: "allowAlways" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await session.execute({
      type: "interaction.respond",
      interactionId: sessionInteraction.interactionId,
      response: { type: "approval", actionId: "allowForSession" },
    });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "session-approval",
      decision: "allowForSession",
    });
    await nextEvent(iterator);
    await session.execute({
      type: "interaction.respond",
      interactionId: alwaysInteraction.interactionId,
      response: { type: "approval", actionId: "allowAlways" },
    });
    expect(transports[0]?.respondToInteraction).toHaveBeenLastCalledWith({
      type: "approval",
      requestId: "always-approval",
      decision: "allowAlways",
    });
    await nextEvent(iterator);

    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("closes a pending Approval before Session-close Turn terminals", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("close-approval"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "close-approval-request",
      title: "Allow pending action?",
    });
    const interaction = await nextInteraction(iterator);

    await session.close();
    const terminalEvents = [];
    for (;;) {
      const output = await iterator.next();
      if (output.done) break;
      if (output.value.kind === "event") terminalEvents.push(output.value.event);
    }
    const closedIndex = terminalEvents.findIndex(
      (event) =>
        event.type === "interaction.closed" && event.interactionId === interaction.interactionId,
    );
    const turnIndex = terminalEvents.findIndex((event) => event.type === "turn.completed");
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(closedIndex).toBeLessThan(turnIndex);
    expect(
      terminalEvents.filter(
        (event) =>
          event.type === "interaction.closed" && event.interactionId === interaction.interactionId,
      ),
    ).toHaveLength(1);
    expect(transports[0]?.close).toHaveBeenCalledOnce();
  });

  it("round-trips native multiple, multi-select, and Other Questions then continues", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("question"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.question({
      type: "question",
      requestId: "question-request",
      questions: [
        {
          question: "Which path?",
          header: "Path",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
          multiSelect: false,
        },
        {
          question: "Which features?",
          header: "Features",
          options: [
            { label: "Search", description: "Enable search" },
            { label: "Export", description: "Enable export" },
          ],
          multiSelect: true,
        },
      ],
    });
    const interaction = await nextInteraction(iterator);
    expect(interaction).toMatchObject({
      type: "question",
      title: "Claude Code",
      questions: [
        {
          id: "question-1",
          type: "choice",
          multiple: false,
          allowOther: true,
          options: [{ value: "Alpha", description: "First" }, { value: "Beta" }],
        },
        {
          id: "question-2",
          type: "choice",
          multiple: true,
          allowOther: true,
        },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { "question-1": ["Alpha"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: {
          type: "question",
          answers: {
            "question-1": ["Alpha"],
            "question-2": ["Search", "Custom feature"],
          },
        },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
      type: "question",
      requestId: "question-request",
      answers: {
        "Which path?": "Alpha",
        "Which features?": "Search, Custom feature",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: interaction.interactionId,
      reason: "responded",
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);

    await session.execute(textTurn("continued"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.delta("continued");
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports[0]?.start).toHaveBeenCalledOnce();
    await session.close();
  });

  it("maps Desktop dismissal to native Question cancellation", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("dismissed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.question({
      type: "question",
      requestId: "dismiss-request",
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "Yes", description: "Continue" },
            { label: "No", description: "Stop" },
          ],
          multiSelect: false,
        },
      ],
    });
    const interaction = await nextInteraction(iterator);
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(transports[0]?.respondToInteraction).toHaveBeenCalledWith({
      type: "question",
      requestId: "dismiss-request",
      cancelled: true,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await session.close();
  });

  it("maps proven cancellation and continues on the same Transport", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("cancelled"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "cancel-request",
      title: "Allow pending native action?",
    });
    const cancelledInteraction = await nextInteraction(iterator);
    const cancel = {
      type: "turn.cancel" as const,
      turnId: hostTurnIdSchema.parse("cancelled"),
    };
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute(cancel)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transports[0]?.abort).toHaveBeenCalledOnce();
    transports[0]?.event({
      type: "interaction.closed",
      requestId: "cancel-request",
      reason: "cancelled",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      interactionId: cancelledInteraction.interactionId,
      reason: "cancelled",
    });
    transports[0]?.finish({ status: "cancelled", reason: "aborted_streaming" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });

    await expect(session.execute(textTurn("continued"))).resolves.toMatchObject({ ok: true });
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "succeeded" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    expect(transports).toHaveLength(1);
    await session.close();
  });

  it("maps failed native results without faulting a reusable Session", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("failed"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.finish({ status: "failed", kind: "authentication" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed", error: { code: "authenticationRequired" } } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "authenticationRequired" } },
    });
    await expect(session.execute(textTurn("retry"))).resolves.toMatchObject({ ok: true });
    transports[0]?.finish({ status: "succeeded" });
    await session.close();
  });

  it("finalizes an active Turn before a Query fault", async () => {
    const { adapter, transports } = fixture();
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await session.execute(textTurn("faulted"));
    await nextEvent(iterator);
    await nextEvent(iterator);
    await nextEvent(iterator);
    transports[0]?.approval({
      type: "approval",
      requestId: "fault-request",
      title: "Allow pending native action?",
    });
    await nextInteraction(iterator);
    transports[0]?.fault(new Error("synthetic Query fault"));

    expect(await nextEvent(iterator)).toMatchObject({
      type: "interaction.closed",
      reason: "cancelled",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.faulted",
      error: { code: "processExited" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects missing installation before acceptance without outputs", async () => {
    const dependencies: ClaudeAdapterDependencies = {
      randomUUID: () => "claude-id",
      inspectInstallation: () => undefined,
      createInspector: () => ({
        inspect: async () => ({
          models: [],
          canSelectModel: false,
          canSelectPermissionMode: false,
        }),
        close: async () => undefined,
      }),
      deleteSession: async () => undefined,
      forkSession: async () => ({ sessionId: "derived-session" }),
      getSessionInfo: async () => ({ cwd: "/synthetic" }),
      readSessionMessages: async () => [],
      readSubagentMessages: async () => [],
      createTransport: () => ({
        sessionId: "claude-id",
        setAutonomousTurnHandler: () => undefined,
        setIdleTurnHandler: () => undefined,
        setIdleLive: () => undefined,
        start: async () => {
          throw new ClaudeCodeExecutableError("Claude Code is not installed");
        },
        getContextUsage: async () => null,
        getPermissionMode: () => "default",
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        setPermissionMode: async () => undefined,
        compact: async () => ({ status: "succeeded" }),
        init: async () => ({ status: "succeeded" }),
        recap: async () => ({ status: "succeeded" }),
        runTurn: async () => ({ status: "succeeded" }),
        respondToInteraction: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
      }),
    };
    const adapter = new ClaudeCodeAdapter({}, dependencies);
    const session = await openSession(adapter);
    const iterator = session.outputs[Symbol.asyncIterator]();

    await expect(session.execute(textTurn("missing"))).resolves.toMatchObject({
      ok: false,
      error: { code: "notInstalled" },
    });
    await session.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("closes an in-flight Inspector before Adapter close resolves", async () => {
    const { adapter, dependencies } = fixture();
    const pending = deferred<{
      models: unknown[];
      canSelectModel: boolean;
      canSelectPermissionMode: boolean;
    }>();
    const close = vi.fn(async () => {
      pending.resolve({
        models: [],
        canSelectModel: false,
        canSelectPermissionMode: false,
      });
    });
    vi.mocked(dependencies.createInspector).mockReturnValueOnce({
      inspect: () => pending.promise,
      close,
    });

    const inspecting = adapter.inspect({ cwd: "/closing" });
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(inspecting).resolves.toMatchObject({ status: "ready", catalog: { models: [] } });
    expect(close).toHaveBeenCalled();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
  });

  it("closes all Sessions idempotently", async () => {
    const { adapter } = fixture();
    await openSession(adapter);
    await openSession(adapter);

    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
