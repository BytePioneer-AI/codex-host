import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type {
  HarnessModelRef,
  HarnessOutput,
  HarnessSession,
  HarnessPermissionModeId,
  HarnessThinkingOptionId,
  HostInteraction,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "../../../protocol-core/src/codex-ui-projector.js";
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  KiroTransportError,
  type KiroOpenInput,
  type KiroOpenResult,
  type KiroTransportEvent,
} from "../src/acp-transport.js";
import { KiroExecutableError } from "../src/command.js";
import { KiroAdapter, type KiroAcpTransportLike } from "../src/kiro-adapter.js";
import type { KiroUserInputParams, KiroUserInputResult } from "../src/projection.js";

class FakeKiroTransport implements KiroAcpTransportLike {
  sessionId = "test-session-kiro";
  stderrTail?: string;

  readonly openCalls: KiroOpenInput[] = [];
  readonly configCalls: Array<{ id: string; value: string }> = [];
  readonly extensionRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  cancelled = false;
  closed = false;
  compactCalled = false;

  inspectResult: unknown = {
    configOptions: [
      {
        id: "model",
        currentValue: "claude-sonnet-4.5",
        options: [
          { value: "claude-haiku-4.5", label: "Haiku" },
          { value: "claude-sonnet-4.5", label: "Sonnet" },
        ],
      },
    ],
  };

  openResult: KiroOpenResult = {
    initialize: { protocolVersion: 1 },
    session: { sessionId: "test-session-kiro" },
    replay: [],
    sessionId: "test-session-kiro",
    configOptions: [
      { id: "autopilot", currentValue: "on" },
      {
        id: "model",
        currentValue: "claude-sonnet-4.5",
        options: [
          { value: "claude-haiku-4.5", label: "Haiku" },
          { value: "claude-sonnet-4.5", label: "Sonnet" },
        ],
      },
    ],
  };

  inspectError?: Error;
  openError?: Error;
  eventsToEmit: KiroTransportEvent[] = [];
  permissionToRequest?: RequestPermissionRequest;
  questionToRequest?: KiroUserInputParams;
  blockRunTurn = false;
  configResult: unknown;
  runError?: Error;
  stopReason = "end_turn";
  extensionResult: unknown = { summary: "VISIBLE_QUERY_RESULT" };
  confirmOpen = true;

  async inspect(): Promise<unknown> {
    if (this.inspectError) throw this.inspectError;
    return this.inspectResult;
  }

  async open(input: KiroOpenInput): Promise<KiroOpenResult> {
    this.openCalls.push(input);
    if (this.openError) throw this.openError;
    if (input.kind === "resume") this.openResult.sessionId = input.sessionId;
    if (this.confirmOpen) {
      if (input.modelId) this.setCurrent("model", input.modelId);
      if (input.autopilot) this.setCurrent("autopilot", input.autopilot);
    }
    return this.openResult;
  }

  setCurrent(id: string, value: string): void {
    this.openResult.configOptions = this.openResult.configOptions?.map((option) => {
      const entry = option as { id: string };
      return entry.id === id ? { ...entry, currentValue: value } : entry;
    });
  }

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    this.configCalls.push({ id: configId, value });
    if (this.configResult !== undefined) return this.configResult;
    this.setCurrent(configId, value);
    return { configOptions: this.openResult.configOptions };
  }

  async runTurn(
    _text: string,
    onEvent: (event: KiroTransportEvent) => void,
    onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    onQuestion: (params: KiroUserInputParams) => Promise<KiroUserInputResult>,
  ): Promise<unknown> {
    for (const event of this.eventsToEmit) {
      onEvent(event);
    }
    if (this.runError) throw this.runError;
    if (this.permissionToRequest) {
      await onPermission(this.permissionToRequest);
    }
    if (this.questionToRequest) {
      await onQuestion(this.questionToRequest);
    }
    if (this.blockRunTurn) {
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (this.cancelled || this.closed) {
            clearInterval(interval);
            resolve(undefined);
          }
        }, 10);
      });
    }
    return { stopReason: this.stopReason };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async compact(): Promise<unknown> {
    this.compactCalled = true;
    return this.extensionResult;
  }

  async sendExtensionRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.extensionRequests.push({ method, params });
    return this.extensionResult;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function collectTurn(
  session: HarnessSession,
  closeWhileActive = false,
): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const consume = (async () => {
    for await (const output of session.outputs) {
      outputs.push(output);
      if (output.kind === "event" && output.event.type === "turn.completed") finished();
    }
  })();
  await session.execute({
    type: "turn.start",
    turnId: hostTurnIdSchema.parse("regression-turn"),
    input: [{ type: "text", text: "test" }],
  });
  if (!closeWhileActive) await done;
  await session.close();
  await consume;
  return outputs;
}

function projectOutputs(outputs: HarnessOutput[]): void {
  const projector = new CodexTurnProjector({
    threadId: "regression-thread",
    turnId: hostTurnIdSchema.parse("regression-turn"),
    cwd: "/workspace",
    startedAtMs: 0,
  });
  for (const output of outputs) {
    if (output.kind === "interaction") {
      if (output.interaction.type === "approval")
        projector.projectApproval(output.interaction, "kiro-cli");
      else projector.projectQuestion(output.interaction, hostItemIdSchema.parse("question-item"));
    } else if ("turnId" in output.event && output.event.type !== "turn.autonomous.started")
      projector.project(output.event);
  }
}

describe("Kiro regression lifecycle", () => {
  async function open(fake: FakeKiroTransport) {
    const adapter = new KiroAdapter({}, { createTransport: () => fake });
    const result = await adapter.open({ kind: "create", cwd: "/workspace" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    if (!result.value.commands) throw new Error("Kiro commands are missing");
    return { session: result.value, adapter };
  }

  it("projects immutable text, merged tool results, one committed Diff and native identity", async () => {
    const fake = new FakeKiroTransport();
    const content = [{ type: "diff", path: "/workspace/a.txt", oldText: "a\n", newText: "b\n" }];
    fake.eventsToEmit = [
      { type: "tool.update", callId: "initialization", status: "completed" },
      {
        type: "usage",
        update: { sessionUpdate: "session_info_update" },
        metadata: { kiro: { kind: "user_message_id_assigned", userMessageId: "native-user" } },
      },
      { type: "agent.text", text: "Hello " },
      {
        type: "tool.call",
        callId: "edit",
        title: "Edit",
        name: "edit",
        kind: "edit",
        rawInput: { path: "a.txt" },
        status: "in_progress",
      },
      { type: "tool.update", callId: "edit", status: "pending", content },
      { type: "agent.text", text: "world" },
      { type: "tool.update", callId: "edit", status: "completed", rawOutput: "saved", content },
      { type: "tool.update", callId: "edit", status: "completed", content },
    ];
    const { session } = await open(fake);
    const outputs = await collectTurn(session);
    expect(() => projectOutputs(outputs)).not.toThrow();
    const events = outputs.flatMap((o) => (o.kind === "event" ? [o.event] : []));
    const starts = events.filter((e) => e.type === "item.started");
    expect(starts.find((e) => e.item.type === "agentMessage")?.item).toMatchObject({ text: "" });
    const completed = events.filter((e) => e.type === "item.completed");
    expect(completed.filter((e) => e.snapshot.item.type === "fileChange")).toHaveLength(1);
    expect(
      completed.find((e) => e.snapshot.item.type === "toolExecution")?.snapshot.item,
    ).toMatchObject({
      toolName: "edit",
      arguments: { path: "a.txt" },
      output: { content: [{ text: "saved" }] },
    });
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({
      nativeTurnRef: { nativeTurnKey: "native-user" },
      outcome: { status: "succeeded" },
    });
  });

  it.each(["failed", "cancelled", "close", "fault"] as const)(
    "finishes active Items on %s without publishing a preview or inventing identity",
    async (mode) => {
      const fake = new FakeKiroTransport();
      fake.eventsToEmit = [
        { type: "agent.text", text: "partial" },
        {
          type: "tool.call",
          callId: "edit",
          title: "edit",
          status: "pending",
          content: [{ type: "diff", path: "/workspace/a.txt", oldText: "a", newText: "b" }],
        },
      ];
      if (mode === "failed" || mode === "fault") fake.runError = new Error("native failed");
      if (mode === "cancelled") fake.stopReason = "cancelled";
      if (mode === "close") fake.blockRunTurn = true;
      const { session } = await open(fake);
      const outputs = await collectTurn(session, mode === "close");
      expect(() => projectOutputs(outputs)).not.toThrow();
      const events = outputs.flatMap((o) => (o.kind === "event" ? [o.event] : []));
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      const terminal = events.find((e) => e.type === "turn.completed");
      expect(terminal?.nativeTurnRef).toBeUndefined();
      expect(terminal?.outcome.status).toBe(
        mode === "close" ? "cancelled" : mode === "fault" ? "failed" : mode,
      );
      expect(events.filter((e) => e.type === "item.completed")).toHaveLength(2);
      expect(events.some((e) => e.type === "item.started" && e.item.type === "fileChange")).toBe(
        false,
      );
    },
  );

  it("closes pending approvals and active Turns through Adapter.close, exactly once", async () => {
    const fake = new FakeKiroTransport();
    fake.permissionToRequest = {
      sessionId: fake.sessionId,
      toolCall: { toolCallId: "approval-tool", title: "edit" },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Deny", optionId: "deny" },
      ],
    };
    const { session, adapter } = await open(fake);
    const outputs: HarnessOutput[] = [];
    const consume = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("regression-turn"),
      input: [{ type: "text", text: "test" }],
    });
    await Promise.all([adapter.close(), session.close(), session.close()]);
    await consume;
    expect(() => projectOutputs(outputs)).not.toThrow();
    const types = outputs.map((o) => (o.kind === "event" ? o.event.type : "interaction"));
    expect(types).toEqual(["turn.started", "interaction", "interaction.closed", "turn.completed"]);
    expect(fake.closed).toBe(true);
  });

  it("does not publish unconfirmed configuration, including initial state", async () => {
    const fake = new FakeKiroTransport();
    const { session, adapter } = await open(fake);
    fake.configResult = { configOptions: fake.openResult.configOptions };
    const outputs: HarnessOutput[] = [];
    const consume = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    expect(
      (
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: "supervised" as HarnessPermissionModeId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await session.execute({
          type: "model.select",
          model: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
        })
      ).ok,
    ).toBe(false);
    await adapter.close();
    await consume;
    expect(outputs).toEqual([]);
    fake.confirmOpen = false;
    expect(
      (
        await adapter.open({
          kind: "create",
          cwd: "/workspace",
          model: { id: "not-confirmed" as HarnessModelRef["id"] },
        })
      ).ok,
    ).toBe(false);
  });

  it.each(["kiro.usage", "kiro.context"])(
    "publishes %s results without native identity",
    async (commandId) => {
      const fake = new FakeKiroTransport();
      fake.extensionResult = { summary: "VISIBLE_QUERY_RESULT", accessToken: "do-not-show" };
      const { session } = await open(fake);
      const outputs: HarnessOutput[] = [];
      const consume = (async () => {
        for await (const output of session.outputs) outputs.push(output);
      })();
      if (!session.commands) throw new Error("Kiro commands are missing");
      const result = await session.commands.execute({
        commandId,
        turnId: hostTurnIdSchema.parse("regression-turn"),
      });
      await session.close();
      await consume;
      expect(result.ok).toBe(true);
      expect(() => projectOutputs(outputs)).not.toThrow();
      expect(JSON.stringify(outputs)).toContain("VISIBLE_QUERY_RESULT");
      expect(JSON.stringify(outputs)).not.toContain("do-not-show");
      expect(JSON.stringify(outputs)).not.toContain("nativeTurnRef");
    },
  );

  it("keeps the native default and passes per-Thread environment on create/resume", async () => {
    for (const kind of ["create", "resume"] as const) {
      const fake = new FakeKiroTransport();
      let environment: NodeJS.ProcessEnv | undefined;
      const adapter = new KiroAdapter(
        { environment: { MARKER: "factory", BASE: "base" } },
        {
          createTransport: (options) => {
            environment = options.environment;
            return fake;
          },
        },
      );
      const result = await adapter.open({
        kind,
        cwd: "/workspace",
        environment: { MARKER: "thread", CODEXHOST_THREAD_ID: "thread" },
        ...(kind === "resume"
          ? {
              nativeRef: nativeSessionRefSchema.parse({
                harnessId: "kiro-cli",
                nativeSessionId: fake.sessionId,
                formatVersion: 1,
              }),
            }
          : {}),
      } as Parameters<KiroAdapter["open"]>[0]);
      expect(result.ok).toBe(true);
      expect(fake.openCalls[0]?.modelId).toBeUndefined();
      expect(environment).toEqual({
        MARKER: "thread",
        BASE: "base",
        CODEXHOST_THREAD_ID: "thread",
      });
      if (result.ok) expect(result.value.initialState.effectiveModel?.id).toBe("claude-sonnet-4.5");
      await adapter.close();
    }
  });

  it.each(["fork", "rollbackLastTurn"] as const)(
    "passes Thread environment through %s and history lookup",
    async (kind) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kiro-fork-env-"));
      try {
        await fs.writeFile(
          path.join(directory, "messages.jsonl"),
          [
            { id: "bootstrap", payload: { type: "system" } },
            { id: "u1", payload: { type: "user", content: "hello" } },
            { id: "e1", payload: { type: "turn_end", stopReason: "end_turn" } },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n"),
          "utf8",
        );
        const environments: (NodeJS.ProcessEnv | undefined)[] = [];
        const fake = new FakeKiroTransport();
        const adapter = new KiroAdapter(
          { environment: { MARKER: "factory" } },
          {
            createTransport: (options) => {
              environments.push(options.environment);
              return fake;
            },
            locateSession: async (options) => {
              environments.push(options.environment);
              return {
                sessionDirectory: directory,
                cwd: directory,
                sessionMeta: {
                  id: "source",
                  workspacePaths: [directory],
                  modelId: "claude-sonnet-4.5",
                  autopilot: "on",
                },
              };
            },
          },
        );
        const result = await adapter.open({
          kind,
          cwd: directory,
          environment: { MARKER: "thread", CODEXHOST_THREAD_ID: "child" },
          sourceRef: nativeSessionRefSchema.parse({
            harnessId: "kiro-cli",
            nativeSessionId: "source",
            formatVersion: 1,
          }),
          ...(kind === "fork"
            ? {
                checkpoint: nativeCheckpointRefSchema.parse({
                  harnessId: "kiro-cli",
                  nativeSessionId: "source",
                  checkpointId: "e1",
                  formatVersion: 1,
                }),
              }
            : {}),
        } as Parameters<KiroAdapter["open"]>[0]);
        expect(result.ok).toBe(true);
        expect(environments).toEqual([
          { MARKER: "thread", CODEXHOST_THREAD_ID: "child" },
          { MARKER: "thread", CODEXHOST_THREAD_ID: "child" },
        ]);
        await adapter.close();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("faults and closes a blocked transport without losing the accepted Turn", async () => {
    const fake = new FakeKiroTransport();
    fake.blockRunTurn = true;
    fake.eventsToEmit = [{ type: "agent.text", text: "partial" }];
    let onFault: ((error: KiroTransportError) => void) | undefined;
    const adapter = new KiroAdapter(
      {},
      {
        createTransport: (options) => {
          onFault = options.onFault;
          return fake;
        },
      },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/workspace" });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs: HarnessOutput[] = [];
    const consume = (async () => {
      for await (const output of opened.value.outputs) outputs.push(output);
    })();
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("regression-turn"),
      input: [{ type: "text", text: "test" }],
    });
    if (!onFault) throw new Error("Transport fault callback is missing");
    onFault(new KiroTransportError("processExited", "test exit"));
    await opened.value.close();
    await consume;
    expect(() => projectOutputs(outputs)).not.toThrow();
    expect(outputs.at(-1)).toMatchObject({ event: { type: "session.faulted" } });
    expect(outputs.at(-2)).toMatchObject({
      event: { type: "turn.completed", outcome: { status: "failed" } },
    });
    expect(
      (
        await opened.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("next"),
          input: [],
        })
      ).ok,
    ).toBe(false);
  });

  it("a failed tool is terminal once but does not force a failed Turn", async () => {
    const fake = new FakeKiroTransport();
    fake.eventsToEmit = [
      {
        type: "tool.call",
        callId: "tool",
        title: "Tool",
        status: "pending",
        rawInput: { query: "keep" },
      },
      { type: "tool.update", callId: "tool", status: "failed", rawOutput: "failure" },
      { type: "tool.update", callId: "tool", status: "failed" },
      { type: "agent.text", text: "Recovered" },
    ];
    const { session } = await open(fake);
    const outputs = await collectTurn(session);
    expect(() => projectOutputs(outputs)).not.toThrow();
    const completed = outputs.filter(
      (o) => o.kind === "event" && o.event.type === "item.completed",
    );
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ event: { snapshot: { outcome: { status: "failed" } } } });
    expect(outputs.at(-1)).toMatchObject({ event: { outcome: { status: "succeeded" } } });
  });

  it("rejects unknown/busy commands and closes a pending query Turn", async () => {
    const fake = new FakeKiroTransport();
    fake.sendExtensionRequest = async () => new Promise(() => {});
    const { session } = await open(fake);
    const outputs: HarnessOutput[] = [];
    const consume = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    const turnId = hostTurnIdSchema.parse("regression-turn");
    if (!session.commands) throw new Error("Kiro commands are missing");
    expect((await session.commands.execute({ commandId: "unknown", turnId })).ok).toBe(false);
    const pending = session.commands.execute({ commandId: "kiro.usage", turnId });
    expect((await session.commands.execute({ commandId: "kiro.context", turnId })).ok).toBe(false);
    await session.close();
    await pending;
    await consume;
    expect(() => projectOutputs(outputs)).not.toThrow();
    expect(outputs).toHaveLength(2);
    expect(outputs.at(-1)).toMatchObject({
      event: { type: "turn.completed", outcome: { status: "cancelled" } },
    });
  });
});

describe("KiroAdapter", () => {
  const dummyBin = "/fake/bin/kiro-cli";

  describe("inspect()", () => {
    it("returns notInstalled when executable cannot be resolved", async () => {
      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          inspectInstallation: () => {
            throw new KiroExecutableError("Kiro CLI is not installed");
          },
          createTransport: () => new FakeKiroTransport(),
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("notInstalled");
    });

    it("returns ready with catalog and capabilities when executable is present", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          inspectInstallation: () => undefined,
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("ready");
      if (inspection.status === "ready") {
        expect(inspection.catalog.models).toHaveLength(2);
        expect(inspection.catalog.thinkingOptions).toEqual([]);
        expect(inspection.capabilities.history.fork).toBe(true);
        expect(inspection.capabilities.history.rollbackLastTurn).toBe(true);
        expect(inspection.capabilities.configuration.selectThinkingOption).toBe(false);
      }
    });

    it("returns error with code authenticationRequired when transport reports auth failure", async () => {
      const fakeTransport = new FakeKiroTransport();
      fakeTransport.inspectError = new KiroTransportError(
        "authenticationRequired",
        "Login required",
      );
      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          inspectInstallation: () => undefined,
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("error");
      if (inspection.status === "error") {
        expect(inspection.error.code).toBe("authenticationRequired");
      }
    });
  });

  describe("open()", () => {
    it("rejects unattended-full-access execution policy as unsupported", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "unattended-full-access",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
      }
    });

    it("creates a new session and initializes model and autopilot", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: "/workspace",
        model: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
        permissionModeId: "supervised" as HarnessPermissionModeId,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openCalls).toHaveLength(1);
      expect(fakeTransport.openCalls[0]).toEqual({
        kind: "create",
        modelId: "claude-haiku-4.5",
        autopilot: "off",
      });

      if (result.ok) {
        const session = result.value;
        expect(session.initialState.effectiveModel?.id).toBe("claude-haiku-4.5");
        expect(session.initialState.effectivePermissionModeId).toBe("supervised");
      }
    });

    it("resumes an existing session", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: harnessIdSchema.parse("kiro-cli"),
        nativeSessionId: "existing-session-456",
        formatVersion: 1,
      });

      const result = await adapter.open({
        kind: "resume",
        cwd: "/workspace",
        nativeRef,
        permissionModeId: "autopilot" as HarnessPermissionModeId,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openCalls[0]).toEqual({
        kind: "resume",
        sessionId: "existing-session-456",
        autopilot: "on",
      });
    });

    it("returns sessionNotFound when source session for fork does not exist", async () => {
      const fakeTransport = new FakeKiroTransport();
      const sourceRef = nativeSessionRefSchema.parse({
        harnessId: harnessIdSchema.parse("kiro-cli"),
        nativeSessionId: "nonexistent-sess",
        formatVersion: 1,
      });
      const checkpoint = nativeCheckpointRefSchema.parse({
        harnessId: harnessIdSchema.parse("kiro-cli"),
        nativeSessionId: "nonexistent-sess",
        checkpointId: "e1",
        formatVersion: 1,
      });

      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          createTransport: () => fakeTransport,
          locateSession: async () => null,
        },
      );

      const result = await adapter.open({
        kind: "fork",
        cwd: "/workspace",
        sourceRef,
        checkpoint,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("sessionNotFound");
      }
    });
  });

  describe("KiroSession execution", () => {
    it("handles model selection, permission mode selection, and rejects thinking selection", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({
        kind: "create",
        cwd: "/workspace",
      });
      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const session = openResult.value;

      // Select model
      const modelRes = await session.execute({
        type: "model.select",
        model: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
      });
      expect(modelRes.ok).toBe(true);
      expect(fakeTransport.configCalls).toContainEqual({
        id: "model",
        value: "claude-haiku-4.5",
      });

      // Select permission mode
      const permRes = await session.execute({
        type: "permissionMode.select",
        permissionModeId: "supervised" as HarnessPermissionModeId,
      });
      expect(permRes.ok).toBe(true);
      expect(fakeTransport.configCalls).toContainEqual({
        id: "autopilot",
        value: "off",
      });

      // Select thinking option -> rejected with unsupported
      const thinkingRes = await session.execute({
        type: "thinking.select",
        thinkingOptionId: "high" as HarnessThinkingOptionId,
      });
      expect(thinkingRes.ok).toBe(false);
      if (!thinkingRes.ok) {
        expect(thinkingRes.error.code).toBe("unsupported");
      }
    });

    it("cancels active turn via transport", async () => {
      const fakeTransport = new FakeKiroTransport();
      fakeTransport.blockRunTurn = true;

      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      const turnId = hostTurnIdSchema.parse("turn-cancel-test");

      // Start turn
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Long running task" }],
      });

      // Cancel turn while running
      const cancelRes = await session.execute({
        type: "turn.cancel",
        turnId,
      });

      expect(cancelRes.ok).toBe(true);
      expect(fakeTransport.cancelled).toBe(true);
    });

    it("executes /compact slash command via transport.compact()", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      if (!session.commands) throw new Error("Kiro commands are missing");
      const cmdList = await session.commands.list();
      expect(cmdList.ok).toBe(true);

      const turnId = hostTurnIdSchema.parse("cmd-turn-1");
      const execRes = await session.commands.execute({
        turnId,
        commandId: "kiro.compact",
      });
      expect(execRes.ok).toBe(true);
      expect(fakeTransport.compactCalled).toBe(true);
    });

    it("runs turn and emits streaming events", async () => {
      const fakeTransport = new FakeKiroTransport();
      fakeTransport.eventsToEmit = [
        { type: "agent.text", text: "Hello " },
        { type: "agent.text", text: "world!" },
        {
          type: "tool.call",
          callId: "call-1",
          title: "my_tool",
          name: "my_tool",
          rawInput: { query: "test" },
          status: "running",
        },
        {
          type: "tool.update",
          callId: "call-1",
          name: "my_tool",
          status: "completed",
          rawOutput: "result",
        },
      ];

      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      const outputs: HarnessOutput[] = [];
      const outputPromise = (async () => {
        for await (const out of session.outputs) {
          outputs.push(out);
        }
      })();

      const turnId = hostTurnIdSchema.parse("turn-run-1");
      const turnRes = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Say hello" }],
      });

      expect(turnRes.ok).toBe(true);

      // Wait a tick for background async execution
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.close();
      await outputPromise;

      const events = outputs.filter((o) => o.kind === "event").map((o) => o.event);
      const types = events.map((e) => e.type);

      expect(types).toContain("turn.started");
      expect(types).toContain("item.started");
      expect(types).toContain("item.updated");
      expect(types).toContain("turn.completed");
    });

    it("handles permission interaction response during turn", async () => {
      const fakeTransport = new FakeKiroTransport();

      fakeTransport.permissionToRequest = {
        sessionId: "sess-test",
        toolCall: { toolCallId: "tool-1", title: "Tool" },
        options: [
          { optionId: "opt-allow", name: "Allow Once", kind: "allow_once" },
          { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
        ],
      };

      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      let capturedInteraction: HostInteraction | undefined;

      const outputPromise = (async () => {
        for await (const out of session.outputs) {
          if (out.kind === "interaction") {
            capturedInteraction = out.interaction;
            // Respond to interaction
            await session.execute({
              type: "interaction.respond",
              interactionId: out.interaction.interactionId,
              response: {
                type: "approval",
                actionId: "opt-allow",
              },
            });
          }
        }
      })();

      const turnId = hostTurnIdSchema.parse("turn-perm-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Execute tool requiring approval" }],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.close();
      await outputPromise;

      expect(capturedInteraction).toBeDefined();
      expect(capturedInteraction?.type).toBe("approval");
    });
  });
});
