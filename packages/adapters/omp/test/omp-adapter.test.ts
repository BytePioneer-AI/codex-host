import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  holdTurn = false;
  steered: string[] = [];
  onSubagentEvent: ((event: OmpTurnEvent) => void) | null = null;
  autoCompleteTurn = true;
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

  event(event: OmpTurnEvent): void {
    this.onEvent?.(event);
  }

  succeed(text: string): void {
    this.history = {
      entries: [
        {
          id: "user-1",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "edit" }] },
        },
        {
          id: "assistant-1",
          parentId: "user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
          },
        },
      ],
      leafId: "assistant-1",
    };
    this.finish(text);
  }

  finish(text: string): void {
    this.#resolveTurn?.({ text, cancelled: false });
  }

  runTurn(_text: string, onEvent: (event: OmpTurnEvent) => void): Promise<OmpTurnResult> {
    this.onEvent = onEvent;
    return new Promise((resolve) => {
      this.#resolveTurn = resolve;
      if (!this.autoCompleteTurn || this.holdTurn) return;
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

  async steer(text: string): Promise<void> {
    this.steered.push(text);
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

describe("OMP Adapter Turn steering", () => {
  it("forwards steer input to the active native Turn", async () => {
    const transport = new FakeOmpTransport();
    transport.holdTurn = true;
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const turnId = "steer-turn" as HostTurnId;
    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "write a numbered list" }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { turnId } });
    await expect(
      opened.value.steer?.({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "use uppercase words" }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { turnId } });
    expect(transport.steered).toEqual(["use uppercase words"]);
    await opened.value.close();
    await adapter.close();
  });

  it("completes a steered Turn against the original User Entry", async () => {
    const transport = new FakeOmpTransport();
    transport.holdTurn = true;
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    const turnId = "steer-complete-turn" as HostTurnId;
    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "count to 200" }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { turnId } });
    await expect(
      opened.value.steer?.({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "say only HELLO" }],
      }),
    ).resolves.toMatchObject({ ok: true, value: { turnId } });
    transport.history = {
      entries: [
        {
          id: "user-1",
          parentId: null,
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "count to 200" }] },
        },
        {
          id: "assistant-1",
          parentId: "user-1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "one two three" }],
            stopReason: "aborted",
            errorMessage: "Request was aborted",
          },
        },
        {
          id: "user-steer",
          parentId: "assistant-1",
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "say only HELLO" }],
            steering: true,
          },
        },
        {
          id: "assistant-2",
          parentId: "user-steer",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "HELLO" }],
            stopReason: "stop",
          },
        },
      ],
      leafId: "assistant-2",
    };
    transport.finish("HELLO");
    await vi.waitFor(() => {
      expect(
        observed.some(
          (output) =>
            output.kind === "event" &&
            output.event.type === "turn.completed" &&
            output.event.outcome.status === "succeeded",
        ),
      ).toBe(true);
    });
    const completed = observed.find(
      (output) => output.kind === "event" && output.event.type === "turn.completed",
    );
    expect(completed).toMatchObject({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId,
        outcome: {
          status: "succeeded",
          checkpoint: { checkpointId: "user-1" },
        },
      },
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
  it("uses OMP's native yolo default without changing ordinary create semantics", async () => {
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
      expect.objectContaining({ permissionMode: "yolo" }),
    );
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
        defaultModeId: "yolo",
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

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Harness output stream ended unexpectedly");
  return result.value;
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected a Harness event output");
  return output.event;
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
  it("projects hub start background process as a running command execution", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-hub-1",
        toolName: "hub",
        arguments: {
          op: "start",
          name: "test-ticker",
          application: "bun",
          args: ["run", "ticker.js"],
        },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-hub-1",
        toolName: "hub",
        result: { pid: 98560, status: "running" },
        isError: false,
      });
      onEvent({
        type: "text.delta",
        messageId: "msg-1",
        delta: "Started background process test-ticker.",
      });
      return Promise.resolve({ text: "Started background process test-ticker.", cancelled: false });
    };
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-process" as HostTurnId,
      input: [{ type: "text", text: "start test-ticker" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const started = events.find(
      (event) => event.type === "item.started" && event.item.type === "commandExecution",
    );
    expect(started).toMatchObject({
      item: {
        type: "commandExecution",
        command: "hub start test-ticker -- bun run ticker.js",
        processId: "test-ticker",
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "test-ticker",
        status: "running",
        osPid: 98560,
      }),
    );
    expect(
      events.some(
        (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
      ),
    ).toBe(false);
    await opened.value.close();
    await adapter.close();
  });
  it("keeps hub start running when the launcher reports exitCode 0 or null", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-hub-start",
        toolName: "hub",
        arguments: { op: "start", name: "terminal-2", application: "bash" },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-hub-start",
        toolName: "hub",
        result: {
          output: "Daemon terminal-2 has unacknowledged completion notifications",
          exitCode: 0,
          pid: 4242,
        },
        isError: false,
      });
      onEvent({
        type: "tool.started",
        callId: "tool-hub-start-null",
        toolName: "bash",
        arguments: { command: "hub start terminal-3 -- bash" },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-hub-start-null",
        toolName: "bash",
        result: {
          output: "Started terminal-3: running pid=4243 uptime=11ms restarts=0",
          exitCode: null,
        },
        isError: false,
      });
      return Promise.resolve({ text: "started terminals", cancelled: false });
    };
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-hub-exit" as HostTurnId,
      input: [{ type: "text", text: "start terminals" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(
      events.filter(
        (event) =>
          event.type === "item.completed" && event.snapshot.item.type === "commandExecution",
      ),
    ).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "terminal-2",
        status: "running",
        osPid: 4242,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "terminal-3",
        status: "running",
        osPid: 4243,
      }),
    );
    expect(
      events.some(
        (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
      ),
    ).toBe(false);
    await opened.value.close();
    await adapter.close();
  });
  it("projects bash hub start as a named background process", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-bash-hub",
        toolName: "bash",
        arguments: { command: "hub start term-1 -- bash --norc --noprofile" },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-bash-hub",
        toolName: "bash",
        result: { output: "Started term-1: running pid=1416880 uptime=11ms restarts=0" },
        isError: false,
      });
      return Promise.resolve({
        text: "Started term-1: running pid=1416880 uptime=11ms restarts=0",
        cancelled: false,
      });
    };
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-bash-hub" as HostTurnId,
      input: [{ type: "text", text: "start term-1" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "term-1",
        status: "running",
        osPid: 1416880,
      }),
    );
    expect(
      events.some(
        (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
      ),
    ).toBe(false);
    const started = events.find(
      (event) => event.type === "item.started" && event.item.type === "commandExecution",
    );
    const completed = events.find(
      (event) => event.type === "item.completed" && event.snapshot.item.type === "commandExecution",
    );
    expect(started).toMatchObject({
      item: {
        type: "commandExecution",
        processId: "term-1",
        command: "hub start term-1 -- bash --norc --noprofile",
      },
    });
    expect(completed).toBeUndefined();
    await opened.value.close();
    await adapter.close();
  });
  it("projects background bash async jobs as processes, not subagents", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-bash-async",
        toolName: "bash",
        arguments: { command: "bun test", async: true },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-bash-async",
        toolName: "bash",
        result: { jobId: "bash_fcf988", status: "running" },
        isError: false,
      });
      onEvent({
        type: "process.state.changed",
        processId: "bash_fcf988",
        status: "running",
        command: "bun test",
      });
      return Promise.resolve({
        text: "Started background job bash_fcf988",
        cancelled: false,
      });
    };
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-bash-async" as HostTurnId,
      input: [{ type: "text", text: "run bun test in background" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "bash_fcf988",
        status: "running",
      }),
    );
    expect(
      events.some(
        (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
      ),
    ).toBe(false);
    await opened.value.close();
    await adapter.close();
  });
  it("projects eval hub start as a named background process, not a subagent", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-eval-hub",
        toolName: "eval",
        arguments: {
          language: "js",
          title: "start ticker",
          code: 'await tool.hub({ op: "start", name: "ticker", application: "bash" })',
        },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-eval-hub",
        toolName: "eval",
        result: { output: "Started ticker: running pid=4242 uptime=11ms restarts=0" },
        isError: false,
      });
      return Promise.resolve({ text: "started ticker", cancelled: false });
    };
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-eval-hub" as HostTurnId,
      input: [{ type: "text", text: "start ticker" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    const started = events.find(
      (event) => event.type === "item.started" && event.item.type === "commandExecution",
    );
    const completed = events.find(
      (event) => event.type === "item.completed" && event.snapshot.item.type === "commandExecution",
    );
    expect(started).toMatchObject({
      item: { type: "commandExecution", processId: "ticker" },
    });
    expect(completed).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "ticker",
        status: "running",
      }),
    );
    expect(
      events.some(
        (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
      ),
    ).toBe(false);
    await opened.value.close();
    await adapter.close();
  });
  it("keeps anonymous task subagents local until native IDs arrive", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-task-anon",
        toolName: "task",
        arguments: {
          context: "Analyze code",
          tasks: [
            { task: "Search files", agent: "scout" },
            { task: "Review changes", agent: "reviewer" },
          ],
        },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-task-anon",
        toolName: "task",
        result: { status: "completed" },
        isError: false,
      });
      transport.history = {
        entries: [
          {
            id: "user-anon",
            parentId: null,
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "run tasks" }] },
          },
          {
            id: "assistant-anon",
            parentId: "user-anon",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Delegation done." }],
              stopReason: "stop",
            },
          },
        ],
        leafId: "assistant-anon",
      };
      return Promise.resolve({ text: "Delegation done.", cancelled: false });
    };
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-anon" as HostTurnId,
      input: [{ type: "text", text: "run tasks" }],
    });
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
        subagents: [
          { subagentId: "tool-task-anon", description: "Search files" },
          { subagentId: "tool-task-anon:1", description: "Review changes" },
        ],
      },
    });
    const startedItem = started?.type === "item.started" ? started.item : undefined;
    expect(startedItem?.type).toBe("subagentDelegation");
    if (startedItem?.type === "subagentDelegation") {
      expect(startedItem.subagents.map((agent) => agent.nativeSubagentId)).toEqual([
        undefined,
        undefined,
      ]);
    }
    const stateChanges = events.filter((event) => event.type === "subagent.state.changed");
    expect(stateChanges).toEqual([]);
    await adapter.close();
  });

  it("runs subagents in conjunction with background bash process", async () => {
    const transport = new FakeOmpTransport();
    transport.runTurn = (_text, onEvent) => {
      onEvent({
        type: "tool.started",
        callId: "tool-subagent-1",
        toolName: "task",
        arguments: {
          tasks: [{ task: "Inspect repo", name: "inspector" }],
        },
      });
      onEvent({
        type: "tool.started",
        callId: "tool-bash-async",
        toolName: "bash",
        arguments: {
          command: "sleep 100",
          async: true,
        },
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-bash-async",
        toolName: "bash",
        result: { jobId: "job-bg-99", pid: 4421 },
        isError: false,
      });
      onEvent({
        type: "tool.completed",
        callId: "tool-subagent-1",
        toolName: "task",
        result: { status: "completed" },
        isError: false,
      });
      return Promise.resolve({ text: "Spawned both.", cancelled: false });
    };
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-conjunction" as HostTurnId,
      input: [{ type: "text", text: "run both" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(
      events.some(
        (event) =>
          event.type === "item.started" &&
          event.item.type === "subagentDelegation" &&
          event.item.subagents[0]?.nativeSubagentId === "inspector",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "process.state.changed" &&
          event.processId === "job-bg-99" &&
          event.status === "running",
      ),
    ).toBe(true);
    await opened.value.close();
    await adapter.close();
  });

  it("forwards background process events when idle", async () => {
    const transport = new FakeOmpTransport();
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const observed = outputs(opened.value);
    (
      opened.value as unknown as { handleTransportEvent(event: unknown): void }
    ).handleTransportEvent({
      type: "process.state.changed",
      processId: "bg-daemon",
      status: "running",
      osPid: 1234,
      command: "daemon run",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process.state.changed",
        processId: "bg-daemon",
        status: "running",
        osPid: 1234,
      }),
    );
    await opened.value.close();
    await adapter.close();
  });
  it("streams background process daemon logs as output updates", async () => {
    const transport = new FakeOmpTransport();
    const tmpDir = path.join(os.tmpdir(), `omp-test-daemons-${Date.now()}`);
    const logDir = path.join(os.homedir(), ".omp", "run", "daemons", `test-${Date.now()}`);
    const daemonLogDir = path.join(logDir, "daemons", "stream-daemon");
    await fs.mkdir(daemonLogDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, "scope.json"),
      JSON.stringify({ projectDir: tmpDir }),
      "utf8",
    );
    await fs.writeFile(path.join(daemonLogDir, "output.log"), "first line\n", "utf8");

    try {
      const dependencies: OmpAdapterDependencies = {
        createTransport: () => transport,
      };
      const adapter = new OmpAdapter({}, dependencies);
      const opened = await adapter.open({ kind: "create", cwd: tmpDir });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const observed = outputs(opened.value);

      transport.runTurn = (_text, onEvent) => {
        onEvent({
          type: "tool.started",
          callId: "tool-bg-stream",
          toolName: "hub",
          arguments: { op: "start", name: "stream-daemon", application: "bash" },
        });
        onEvent({
          type: "tool.completed",
          callId: "tool-bg-stream",
          toolName: "hub",
          result: { output: "Started stream-daemon", status: "running" },
          isError: false,
        });
        return Promise.resolve({ text: "Started stream-daemon", cancelled: false });
      };

      const turn = await opened.value.execute({
        type: "turn.start",
        turnId: "turn-bg-stream" as HostTurnId,
        input: [{ type: "text", text: "start stream" }],
      });
      expect(turn.ok).toBe(true);

      await vi.waitFor(
        () => {
          const updates = observed
            .filter(
              (output): output is Extract<HarnessOutput, { kind: "event" }> =>
                output.kind === "event" && output.event.type === "item.updated",
            )
            .map((output) => output.event);
          expect(
            updates.some(
              (u) =>
                u.type === "item.updated" &&
                u.update.type === "output.append" &&
                u.update.text.includes("first line"),
            ),
          ).toBe(true);
        },
        { timeout: 2000 },
      );

      await fs.appendFile(path.join(daemonLogDir, "output.log"), "second line\n", "utf8");

      await vi.waitFor(
        () => {
          const updates = observed
            .filter(
              (output): output is Extract<HarnessOutput, { kind: "event" }> =>
                output.kind === "event" && output.event.type === "item.updated",
            )
            .map((output) => output.event);
          expect(
            updates.some(
              (u) =>
                u.type === "item.updated" &&
                u.update.type === "output.append" &&
                u.update.text.includes("second line"),
            ),
          ).toBe(true);
        },
        { timeout: 2000 },
      );

      await opened.value.close();
      await adapter.close();
    } finally {
      await fs.rm(logDir, { recursive: true, force: true }).catch(() => undefined);
    }
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

  it("projects a native Edit File Change from numbered details.diff without faulting the Session", async () => {
    const transport = new FakeOmpTransport();
    transport.autoCompleteTurn = false;
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    const accepted = await opened.value.execute({
      type: "turn.start",
      turnId: "turn-edit" as HostTurnId,
      input: [{ type: "text", text: "edit" }],
    });
    expect(accepted).toEqual({ ok: true, value: { turnId: "turn-edit" } });
    const started = await nextEvent(iterator);
    if (started.type === "session.state.changed") {
      expect(await nextEvent(iterator)).toMatchObject({ type: "turn.started" });
    } else {
      expect(started).toMatchObject({ type: "turn.started" });
    }
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "agentMessage" },
    });

    transport.event({
      type: "tool.started",
      callId: "edit-1",
      toolName: "edit",
      arguments: {
        i: "Adding tiny test marker",
        input: "[docs/archive/README.md#6F1B]\nPUT >3:\n+\n+test-marker\n",
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "toolExecution", toolName: "edit" },
    });

    transport.event({
      type: "tool.completed",
      callId: "edit-1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "edited" }],
        details: {
          diff: " 1|# Archive\n 2|\n 3|Current documents.\n+4|\n+5|test-marker",
          path: "docs/archive/README.md",
          oldText: "# Archive\n\nCurrent documents.\n",
          newText: "# Archive\n\nCurrent documents.\n\ntest-marker\n",
        },
      },
      isError: false,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "toolExecution", toolName: "edit" },
        outcome: { status: "succeeded" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [
          {
            path: "docs/archive/README.md",
            kind: "update",
            unifiedDiff: expect.stringContaining("test-marker"),
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });

    transport.succeed("changed");
    expect(await nextEvent(iterator)).toMatchObject({ type: "item.completed" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await opened.value.close();
    await adapter.close();
  });
  it("projects task tool execution into a Host subagentDelegation Item", async () => {
    const transport = new FakeOmpTransport();
    transport.autoCompleteTurn = false;
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const observed = outputs(opened.value);
    const turnId = "turn-subagent-tool" as HostTurnId;
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "spawn subagent" }],
    });

    // Model executes `task` tool
    transport.onEvent?.({
      type: "tool.started",
      callId: "tool-task-1",
      toolName: "task",
      arguments: {
        task: "Verify system architecture",
        agent: "task",
        model: "grok-4.6",
        effort: "hi",
        background: true,
        subagent_id: "child-grok-1",
      },
    });

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
        subagents: [
          {
            subagentId: "child-grok-1",
            nativeSubagentId: "child-grok-1",
            description: "Verify system architecture",
            role: "task",
            model: "grok-4.6",
            reasoningEffort: "high",
            status: "running",
          },
        ],
      },
    });

    // Tool finishes
    transport.onEvent?.({
      type: "tool.completed",
      callId: "tool-task-1",
      toolName: "task",
      result: "Verification completed successfully",
      isError: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const allEvents = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);

    const stateChanges = allEvents.filter((event) => event.type === "subagent.state.changed");
    expect(stateChanges.length).toBeGreaterThan(0);

    await opened.value.close();
    await adapter.close();
  });

  it("projects a batch task spawn as one collaboration Item with every Agent", async () => {
    const transport = new FakeOmpTransport();
    transport.autoCompleteTurn = false;
    const adapter = new OmpAdapter({}, { createTransport: () => transport });
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const observed = outputs(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: "turn-batch-spawn" as HostTurnId,
      input: [{ type: "text", text: "spawn two inspectors" }],
    });
    transport.onEvent?.({
      type: "tool.started",
      callId: "tool-task-batch",
      toolName: "task",
      arguments: {
        tasks: [
          {
            name: "RepoInspector",
            agent: "scout",
            task: "Read package.json",
          },
          {
            name: "DocsInspector",
            agent: "scout",
            task: "List docs",
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event)
      .find((event) => event.type === "item.started" && event.item.type === "subagentDelegation");
    expect(started).toMatchObject({
      item: {
        type: "subagentDelegation",
        operation: "spawn",
        subagents: [
          {
            nativeSubagentId: "RepoInspector",
            description: "RepoInspector",
            role: "scout",
            status: "running",
          },
          {
            nativeSubagentId: "DocsInspector",
            description: "DocsInspector",
            role: "scout",
            status: "running",
          },
        ],
      },
    });

    transport.onEvent?.({
      type: "tool.completed",
      callId: "tool-task-batch",
      toolName: "task",
      result: {
        details: {
          progress: [
            { id: "RepoInspector", status: "pending" },
            { id: "DocsInspector", status: "pending" },
          ],
          async: { jobId: "RepoInspector" },
        },
      },
      isError: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const updated = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event)
      .findLast(
        (event) => event.type === "item.updated" && event.update.type === "subagents.replace",
      );
    expect(updated).toMatchObject({
      update: {
        type: "subagents.replace",
        subagents: [
          { nativeSubagentId: "RepoInspector", status: "running" },
          { nativeSubagentId: "DocsInspector", status: "running" },
        ],
      },
    });

    await opened.value.close();
    await adapter.close();
  });

  it("handles tool.started for task followed by subagent.started on the same callId idempotently", async () => {
    const transport = new FakeOmpTransport();
    transport.autoCompleteTurn = false;
    const dependencies: OmpAdapterDependencies = {
      createTransport: () => transport,
    };
    const adapter = new OmpAdapter({}, dependencies);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const observed = outputs(opened.value);
    const turnId = "turn-subagent-idempotent" as HostTurnId;
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "spawn subagent" }],
    });

    // Model executes task tool
    transport.onEvent?.({
      type: "tool.started",
      callId: "tool-task-dup",
      toolName: "task",
      arguments: { task: "First description" },
    });

    // Native subagent.started arrives for same callId
    expect(() => {
      transport.onEvent?.({
        type: "subagent.started",
        callId: "tool-task-dup",
        nativeSubagentId: "subagent-native-1",
        description: "Updated description",
        background: false,
      });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = observed
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event);

    const started = events.find(
      (event) => event.type === "item.started" && event.item.type === "subagentDelegation",
    );
    expect(started).toBeDefined();

    await opened.value.close();
    await adapter.close();
  });
});
