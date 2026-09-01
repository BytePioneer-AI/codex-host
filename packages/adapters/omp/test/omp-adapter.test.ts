import { describe, expect, it, vi } from "vitest";

import type { HarnessOutput, HostUsage } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessThinkingOptionId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

import {
  OmpAdapter,
  type OmpAdapterDependencies,
  type OmpTurnTransport,
} from "../src/omp-adapter.js";
import type {
  OmpCompactResult,
  OmpRpcSessionOptions,
  OmpSessionHistory,
  OmpSessionState,
  OmpSubagentMessagesResult,
  OmpTurnEvent,
  OmpTurnResult,
} from "../src/omp-rpc-session.js";
import type { OmpNativeModel } from "../src/omp-model-catalog.js";

class FakeOmpTransport implements OmpTurnTransport {
  state: OmpSessionState = {
    sessionId: "omp-parent",
    sessionFile: "/synthetic/omp-parent.jsonl",
    provider: "synthetic",
    modelId: "model",
    thinkingLevel: harnessThinkingOptionIdSchema.parse("high"),
    contextUsage: null,
    availableThinkingLevels: [harnessThinkingOptionIdSchema.parse("high")],
  };
  readonly stderrTail = "";
  history: OmpSessionHistory = { entries: [], leafId: null };
  onEvent: ((event: OmpTurnEvent) => void) | null = null;
  onSubagentEvent: ((event: OmpTurnEvent) => void) | null = null;
  #resolveTurn: ((result: OmpTurnResult) => void) | null = null;

  async start(): Promise<void> {}

  async getAvailableModels(): Promise<OmpNativeModel[]> {
    return [{ provider: "synthetic", id: "model", reasoning: true }];
  }

  async getAvailableThinkingLevels(): Promise<HarnessThinkingOptionId[]> {
    return [harnessThinkingOptionIdSchema.parse("high")];
  }

  async getEntries(): Promise<OmpSessionHistory> {
    return structuredClone(this.history);
  }

  async getSubagentMessages(): Promise<OmpSubagentMessagesResult> {
    return {
      sessionFile: "/synthetic/subagent.jsonl",
      fromByte: 0,
      nextByte: 256,
      reset: false,
      entries: [
        {
          id: "subagent-user-1",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Inspect the repository" }],
          },
        },
        {
          id: "subagent-assistant-1",
          parentId: "subagent-user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I inspected it." }],
            stopReason: "stop",
          },
        },
      ],
      messages: [],
    };
  }

  async getSessionUsage(): Promise<HostUsage | null> {
    return null;
  }

  async fork(entryId: string): Promise<OmpSessionState> {
    void entryId;
    return this.state;
  }

  async verifySessionCwd(): Promise<void> {}

  async selectModel(): Promise<OmpSessionState> {
    return this.state;
  }

  async selectThinkingOption(thinkingLevel: HarnessThinkingOptionId): Promise<OmpSessionState> {
    void thinkingLevel;
    return this.state;
  }

  async compact(): Promise<OmpCompactResult> {
    return { outcome: "succeeded" };
  }

  runTurn(_text: string, onEvent: (event: OmpTurnEvent) => void): Promise<OmpTurnResult> {
    this.onEvent = onEvent;
    return new Promise((resolve) => {
      this.#resolveTurn = resolve;
      queueMicrotask(() => {
        onEvent({
          type: "subagent.started",
          callId: "tool-1",
          nativeSubagentId: "subagent-1",
          description: "Inspect the repository",
          role: "task",
          background: false,
        });
        onEvent({
          type: "subagent.updated",
          callId: "tool-1",
          nativeSubagentId: "subagent-1",
          status: "running",
        });
        onEvent({
          type: "subagent.completed",
          callId: "tool-1",
          nativeSubagentId: "subagent-1",
          isError: false,
          resultSummary: "done",
        });
        this.history = {
          entries: [
            {
              id: "user-1",
              parentId: null,
              type: "message",
              message: { role: "user", content: [{ type: "text", text: "delegate" }] },
            },
            {
              id: "assistant-1",
              parentId: "user-1",
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                stopReason: "stop",
              },
            },
          ],
          leafId: "assistant-1",
        };
        this.#resolveTurn?.({ text: "done", cancelled: false });
      });
    });
  }

  async respondToInteraction(): Promise<void> {}

  async abort(): Promise<void> {
    this.#resolveTurn?.({ text: "", cancelled: true });
  }

  async close(): Promise<void> {}
}

class RestartableOmpTransport extends FakeOmpTransport {
  closed = false;
  startError: Error | null = null;

  override async start(): Promise<void> {
    if (this.startError) throw this.startError;
  }

  override async close(): Promise<void> {
    this.closed = true;
  }
}

describe("OMP Adapter startup", () => {
  it("starts resumed Sessions with the native always-ask default", async () => {
    const transport = new FakeOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "omp-parent",
      locator: { sessionFile: "/synthetic/omp-parent.jsonl" },
      formatVersion: 1,
    });

    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef });

    expect(opened.ok).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "always-ask" }),
    );
    if (opened.ok) await opened.value.close();
    await adapter.close();
  });

  it("repairs an unavailable persisted Thinking level after model fallback", async () => {
    const transport = new FakeOmpTransport();
    const availableThinkingLevels = ["minimal", "low", "medium", "high"].map((level) =>
      harnessThinkingOptionIdSchema.parse(level),
    );
    transport.state = {
      ...transport.state,
      thinkingLevel: harnessThinkingOptionIdSchema.parse("xhigh"),
      availableThinkingLevels,
    };
    vi.spyOn(transport, "getAvailableThinkingLevels").mockImplementation(async () => [
      ...availableThinkingLevels,
    ]);
    const selectThinkingOption = vi
      .spyOn(transport, "selectThinkingOption")
      .mockImplementation(async (thinkingLevel) => {
        transport.state = { ...transport.state, thinkingLevel };
        return transport.state;
      });
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "omp-parent",
      locator: { sessionFile: "/synthetic/omp-parent.jsonl" },
      formatVersion: 1,
    });

    const opened = await adapter.open({ kind: "resume", cwd: "/synthetic", nativeRef });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(selectThinkingOption).toHaveBeenCalledWith("high");
    expect(opened.value.initialState).toMatchObject({
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: [
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
      ],
    });
    await opened.value.close();
    await adapter.close();
  });
});

function historyTurn(input: {
  assistantId: string;
  parentId: string | null;
  text: string;
  userId: string;
}): OmpSessionHistory["entries"] {
  return [
    {
      id: input.userId,
      parentId: input.parentId,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: input.text }] },
    },
    {
      id: input.assistantId,
      parentId: input.userId,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${input.text} response` }],
        stopReason: "stop",
      },
    },
  ];
}

describe("OMP Adapter Session environment", () => {
  it("uses OMP's native always-ask default for ordinary creates", async () => {
    const transport = new FakeOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.execute({
      type: "turn.start",
      turnId: "permission-turn" as HostTurnId,
      input: [{ type: "text", text: "task" }],
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "always-ask" }),
    );
    await adapter.close();
  });

  it.each(["write", "yolo"])(
    "rejects explicit %s for approval-required creates",
    async (permissionMode) => {
      const adapter = new OmpAdapter({}, { createTransport: () => new FakeOmpTransport() });

      await expect(
        adapter.open({
          kind: "create",
          cwd: "/synthetic",
          executionPolicy: "approval-required",
          permissionModeId: harnessPermissionModeIdSchema.parse(permissionMode),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "unsupported", retryable: false },
      });
      await adapter.close();
    },
  );

  it.each(["always-ask", "write"])(
    "rejects explicit %s for unattended-full-access creates",
    async (permissionMode) => {
      const adapter = new OmpAdapter({}, { createTransport: () => new FakeOmpTransport() });

      await expect(
        adapter.open({
          kind: "create",
          cwd: "/synthetic",
          executionPolicy: "unattended-full-access",
          permissionModeId: harnessPermissionModeIdSchema.parse(permissionMode),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "unsupported", retryable: false },
      });
      await adapter.close();
    },
  );

  it("rejects explicit yolo unless unattended-full-access is requested", async () => {
    const adapter = new OmpAdapter({}, { createTransport: () => new FakeOmpTransport() });

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    await adapter.close();
  });

  it("defers a cold OMP Permission Mode selection until startup", async () => {
    const transport = new RestartableOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: harnessPermissionModeIdSchema.parse("always-ask"),
    });
    if (!opened.ok) throw new Error(opened.error.message);

    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("write"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(createTransport).not.toHaveBeenCalled();
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "write" } },
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "write" }),
    );
    await adapter.close();
  });

  it("advertises OMP Permission Modes and restarts a persisted Session to switch mode", async () => {
    const inspection = new RestartableOmpTransport();
    const initial = new RestartableOmpTransport();
    initial.state = {
      ...initial.state,
      sessionId: "omp-permission-session",
      sessionFile: "/synthetic/omp-permission-session.jsonl",
    };
    const replacement = new RestartableOmpTransport();
    replacement.state = { ...initial.state };
    const createTransport = vi
      .fn()
      .mockImplementationOnce(() => inspection)
      .mockImplementationOnce(() => initial)
      .mockImplementationOnce(() => replacement);
    const adapter = new OmpAdapter({}, { createTransport });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        defaultModeId: "always-ask",
        modes: expect.arrayContaining([
          expect.objectContaining({ id: "always-ask" }),
          expect.objectContaining({ id: "write" }),
          expect.objectContaining({ id: "yolo", dangerous: true }),
        ]),
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: harnessPermissionModeIdSchema.parse("write"),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.readSnapshot();
    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(initial.closed).toBe(true);
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionFile: "/synthetic/omp-permission-session.jsonl",
        permissionMode: "yolo",
      }),
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "yolo" } },
    });
    await adapter.close();
  });

  it("recovers the previous OMP Permission Mode when restart fails", async () => {
    const initial = new RestartableOmpTransport();
    initial.state = {
      ...initial.state,
      sessionId: "omp-permission-recovery",
      sessionFile: "/synthetic/omp-permission-recovery.jsonl",
    };
    const failedReplacement = new RestartableOmpTransport();
    failedReplacement.state = { ...initial.state };
    failedReplacement.startError = new Error("synthetic permission restart failure");
    const recovery = new RestartableOmpTransport();
    recovery.state = { ...initial.state };
    const createTransport = vi
      .fn()
      .mockImplementationOnce(() => initial)
      .mockImplementationOnce(() => failedReplacement)
      .mockImplementationOnce(() => recovery);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: harnessPermissionModeIdSchema.parse("write"),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await opened.value.readSnapshot();
    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure", message: "synthetic permission restart failure" },
    });
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: "write" }),
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "write" } },
    });
    await adapter.close();
  });

  it("passes per-Session delegation environment to the native transport", async () => {
    const transport = new FakeOmpTransport();
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
        CODEXHOST_THREAD_ID: "thread-1",
      },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.execute({
      type: "turn.start",
      turnId: "environment-turn" as HostTurnId,
      input: [{ type: "text", text: "task" }],
    });
    expect(createTransport).toHaveBeenCalledWith(
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
});

describe("OMP Adapter inspection", () => {
  it("reports a missing executable as not installed", async () => {
    const transport = new FakeOmpTransport();
    vi.spyOn(transport, "start").mockRejectedValueOnce(
      Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }),
    );
    const close = vi.spyOn(transport, "close");
    const adapter = new OmpAdapter({}, { createTransport: () => transport });

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled", retryable: false, stage: "startup" },
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("OMP Adapter Fork", () => {
  it("forks the requested completed prefix from the next OMP User Entry", async () => {
    const firstTurn = historyTurn({
      userId: "source-user-1",
      assistantId: "source-assistant-1",
      parentId: null,
      text: "first",
    });
    const secondTurn = historyTurn({
      userId: "source-user-2",
      assistantId: "source-assistant-2",
      parentId: "source-assistant-1",
      text: "second",
    });
    const transport = new FakeOmpTransport();
    transport.state = {
      ...transport.state,
      sessionId: "fork-startup",
      sessionFile: "/synthetic/fork-startup.jsonl",
    };
    transport.history = {
      entries: [...firstTurn, ...secondTurn],
      leafId: "source-assistant-2",
    };
    const fork = vi.fn(async (entryId: string) => {
      expect(entryId).toBe("source-user-2");
      transport.state = {
        ...transport.state,
        sessionId: "fork-derived",
        sessionFile: "/synthetic/fork-derived.jsonl",
      };
      transport.history = { entries: firstTurn, leafId: "source-assistant-1" };
      return transport.state;
    });
    transport.fork = fork;
    const verifySessionCwd = vi.fn(async () => undefined);
    transport.verifySessionCwd = verifySessionCwd;
    const createTransport = vi.fn(() => transport);
    const adapter = new OmpAdapter({}, { createTransport });
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "source-session",
      locator: { sessionFile: "/synthetic/source-session.jsonl" },
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "source-session",
      checkpointId: "source-user-1",
      formatVersion: 1,
    });

    const opened = await adapter.open({
      kind: "fork",
      cwd: "/synthetic",
      sourceRef,
      checkpoint,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ forkSessionFile: "/synthetic/source-session.jsonl" }),
    );
    expect(fork).toHaveBeenCalledTimes(1);
    expect(verifySessionCwd).toHaveBeenCalledWith("/synthetic");
    expect(opened.value.initialState.nativeRef).toMatchObject({
      nativeSessionId: "fork-derived",
      locator: { sessionFile: "/synthetic/fork-derived.jsonl" },
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeSessionId: "fork-derived", nativeTurnKey: "source-user-1" },
            checkpoint: { nativeSessionId: "fork-derived", checkpointId: "source-user-1" },
          },
        ],
      },
    });
    await opened.value.close();
    await adapter.close();
  });
});

function outputs(session: { outputs: AsyncIterable<HarnessOutput> }): HarnessOutput[] {
  const values: HarnessOutput[] = [];
  void (async () => {
    for await (const output of session.outputs) values.push(output);
  })();
  return values;
}

describe("OMP Adapter Subagents", () => {
  it("projects native Subagent lifecycle into a Host delegation Item", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: (options: OmpRpcSessionOptions) => {
        transport.onSubagentEvent = options.onSubagentEvent ?? null;
        return transport;
      },
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.capabilities.subagents).toEqual({ observe: true, readTranscript: true });
    const observed = outputs(opened.value);
    const accepted = await opened.value.execute({
      type: "turn.start",
      turnId: "turn-1" as HostTurnId,
      input: [{ type: "text", text: "delegate" }],
    });
    expect(accepted).toEqual({ ok: true, value: { turnId: "turn-1" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const started = events.find(
      (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
    );
    expect(started).toMatchObject({
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        subagents: [{ nativeSubagentId: "subagent-1", status: "running" }],
      },
    });
    const completed = events.find(
      (event) =>
        event.type === "item.completed" && event.snapshot.item.type === "subagentDelegation",
    );
    expect(completed).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "subagentDelegation",
          subagents: [{ nativeSubagentId: "subagent-1", status: "completed" }],
        },
      },
    });
    expect(
      events
        .filter((event) => event.type === "subagent.state.changed")
        .map((event) => event.status),
    ).toEqual(["running", "running", "completed"]);
    transport.onSubagentEvent?.({
      type: "subagent.transcript.changed",
      callId: "tool-1",
      nativeSubagentId: "subagent-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const laterEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(laterEvents).toContainEqual({
      type: "subagent.transcript.changed",
      nativeSubagentId: "subagent-1",
    });
    await opened.value.close();
    await adapter.close();
  });

  it("exposes only OMP compact as a Harness command", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const commands = opened.value.commands;
    if (!commands) throw new Error("OMP Session did not expose commands");
    await expect(commands.list()).resolves.toEqual({
      ok: true,
      value: {
        commands: [
          {
            id: "omp.compact",
            invocation: "/compact",
            label: "Compact context",
            description: "Compact the current conversation context",
            argumentMode: "text",
          },
        ],
      },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("reads a stable OMP Subagent transcript as a Child Host Thread", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const parent = nativeSessionRefSchema.parse({
      harnessId: "omp",
      nativeSessionId: "omp-parent",
      locator: { sessionFile: "/synthetic/omp-parent.jsonl" },
      formatVersion: 1,
    });
    const result = await adapter.subagents.readSnapshot({
      parent,
      nativeSubagentId: "subagent-1",
      cwd: "/synthetic",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.turns).toHaveLength(1);
      expect(result.value.turns[0]?.input).toEqual([
        { type: "text", text: "Inspect the repository" },
      ]);
      expect(result.value.turns[0]?.items).toContainEqual({
        item: expect.objectContaining({ type: "agentMessage", text: "I inspected it." }),
        outcome: { status: "succeeded" },
      });
    }
    await adapter.close();
  });

  it("materializes a background Subagent that starts after the parent Turn is idle", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: (options: OmpRpcSessionOptions) => {
        transport.onSubagentEvent = options.onSubagentEvent ?? null;
        return transport;
      },
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-parent" as HostTurnId,
      input: [{ type: "text", text: "start background work" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.onSubagentEvent?.({
      type: "subagent.started",
      callId: "background-tool",
      nativeSubagentId: "background-subagent",
      description: "Continue the long task",
      role: "task",
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const startedEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const autonomous = startedEvents.find((event) => event.type === "turn.autonomous.started");
    expect(autonomous).toMatchObject({ type: "turn.autonomous.started" });
    expect(startedEvents).toContainEqual(
      expect.objectContaining({
        type: "item.started",
        item: expect.objectContaining({
          type: "subagentDelegation",
          subagents: [
            expect.objectContaining({
              nativeSubagentId: "background-subagent",
              status: "running",
              background: true,
            }),
          ],
        }),
      }),
    );

    transport.onSubagentEvent?.({
      type: "subagent.completed",
      callId: "background-tool",
      nativeSubagentId: "background-subagent",
      isError: false,
      resultSummary: "finished in background",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completedEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({
            type: "subagentDelegation",
            subagents: [expect.objectContaining({ status: "completed" })],
          }),
        }),
      }),
    );
    expect(completedEvents.some((event) => event.type === "turn.completed")).toBe(true);
    await opened.value.close();
    await adapter.close();
  });

  it("keeps an autonomous Turn open until all background Subagents settle", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: (options: OmpRpcSessionOptions) => {
        transport.onSubagentEvent = options.onSubagentEvent ?? null;
        return transport;
      },
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-background-parent" as HostTurnId,
      input: [{ type: "text", text: "prime background subscription" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.onSubagentEvent?.({
      type: "subagent.started",
      callId: "background-tool-1",
      nativeSubagentId: "background-subagent-1",
      description: "First background task",
      background: true,
    });
    transport.onSubagentEvent?.({
      type: "subagent.started",
      callId: "background-tool-2",
      nativeSubagentId: "background-subagent-2",
      description: "Second background task",
      background: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.onSubagentEvent?.({
      type: "subagent.completed",
      callId: "background-tool-1",
      nativeSubagentId: "background-subagent-1",
      isError: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterFirst = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const autonomousTurnIds = afterFirst
      .filter(
        (event): event is Extract<typeof event, { type: "turn.autonomous.started" }> =>
          event.type === "turn.autonomous.started",
      )
      .map((event) => event.turnId);
    expect(
      afterFirst.filter(
        (event) => event.type === "turn.completed" && autonomousTurnIds.includes(event.turnId),
      ),
    ).toHaveLength(0);
    transport.onSubagentEvent?.({
      type: "subagent.completed",
      callId: "background-tool-2",
      nativeSubagentId: "background-subagent-2",
      isError: true,
      resultSummary: "failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completed = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event)
      .filter(
        (event) => event.type === "turn.completed" && autonomousTurnIds.includes(event.turnId),
      );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: { status: "failed" } });
    await opened.value.close();
    await adapter.close();
  });
});
