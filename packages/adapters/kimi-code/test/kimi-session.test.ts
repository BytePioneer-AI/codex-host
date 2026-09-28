import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  harnessCommandCatalogSchema,
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  type HostInteractionId,
} from "@codexhost/shared-contracts";
import type {
  HarnessOutput,
  HostApprovalInteraction,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";

import { KimiSession } from "../src/kimi-session.js";
import { createKimiNativeTurnRef } from "../src/history.js";
import type { KimiAcpTransportLike } from "../src/kimi-adapter.js";
import {
  projectKimiToolUpdate,
  type ActivePromptHandler,
  type SessionEventHandler,
} from "../src/acp-transport.js";
import { encodeKimiModelRef } from "../src/models.js";
import { KIMI_DEFAULT_COMMAND_CATALOG } from "../src/slash-commands.js";

class MockKimiTransport implements KimiAcpTransportLike {
  sessionId: string | null = "session-mock-1";
  isClosed = false;
  activeHandler: ActivePromptHandler | null = null;
  sessionEventHandler: SessionEventHandler | null = null;
  configOptionsSet: Array<{ configId: string; value: string }> = [];
  cancelled = false;

  setActivePromptHandler(handler: ActivePromptHandler | null): void {
    this.activeHandler = handler;
  }

  setSessionEventHandler(handler: SessionEventHandler | null): void {
    this.sessionEventHandler = handler;
  }

  async inspect() {
    return { initialize: { protocolVersion: 1 } as InitializeResponse, authReady: true };
  }

  async openSession() {
    return { sessionId: this.sessionId ?? "session-mock-1" };
  }

  async setConfigOption(configId: string, value: string) {
    this.configOptionsSet.push({ configId, value });
    return [
      { id: configId, currentValue: value },
      ...(configId === "thinking" ? [] : [{ id: "thinking", currentValue: "off" }]),
    ].map((option) => ({
      ...option,
      ...(option.id === "thinking"
        ? { options: ["off", "high"].map((value) => ({ value, name: value })) }
        : {}),
    }));
  }

  promptMock = vi.fn(
    async (_text: string, handler: ActivePromptHandler): Promise<PromptResponse> => {
      this.activeHandler = handler;
      return { stopReason: "end_turn" };
    },
  );

  async prompt(text: string, handler: ActivePromptHandler): Promise<PromptResponse> {
    return this.promptMock(text, handler);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

describe("KimiSession", () => {
  it("caches native Thinking state per session and replaces it on Model changes and notifications", async () => {
    const transport = new MockKimiTransport();
    const config = (model: string, values: string[], current: string) => [
      { id: "model", currentValue: model },
      {
        id: "thinking",
        currentValue: current,
        options: values.map((value) => ({ value, name: `Thinking ${value}` })),
      },
    ];
    const setConfig = vi
      .spyOn(transport, "setConfigOption")
      .mockResolvedValue(config("second", ["off", "high"], "off"));
    const session = new KimiSession({
      transport,
      sessionId: "dynamic",
      cwd: process.cwd(),
      initialState: {
        effectiveModel: encodeKimiModelRef("first"),
        effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse("on"),
        availableThinkingOptions: ["off", "on"].map((id) => ({
          id: harnessThinkingOptionIdSchema.parse(id),
          label: id,
        })),
      },
    });
    const other = new KimiSession({
      transport: new MockKimiTransport(),
      sessionId: "other",
      cwd: process.cwd(),
      initialState: {},
    });
    const outputs: HarnessOutput[] = [];
    const drain = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    try {
      expect(
        await session.execute({ type: "model.select", model: encodeKimiModelRef("second") }),
      ).toMatchObject({ ok: true });
      expect(session.initialState).toMatchObject({
        effectiveThinkingOptionId: "off",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "high", label: "High" },
        ],
      });
      expect(setConfig).toHaveBeenCalledTimes(1);
      expect(setConfig).toHaveBeenCalledWith("model", "second");
      expect(
        await session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("on"),
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(setConfig).toHaveBeenCalledTimes(1);
      transport.sessionEventHandler?.({
        type: "config.update",
        configOptions: config("second", ["off", "on"], "on"),
      });
      expect(session.initialState.availableThinkingOptions?.map(({ id }) => id)).toEqual([
        "off",
        "on",
      ]);
      expect(other.initialState.availableThinkingOptions).toBeUndefined();
      transport.sessionEventHandler?.({
        type: "config.update",
        configOptions: [{ id: "model", currentValue: "third" }],
      });
      expect(session.initialState.availableThinkingOptions).toEqual([]);
      expect(session.initialState.effectiveThinkingOptionId).toBeUndefined();
    } finally {
      await session.close();
      await other.close();
      await drain;
    }
    expect(outputs).toContainEqual({
      kind: "event",
      event: {
        type: "session.state.changed",
        state: expect.objectContaining({ availableThinkingOptions: [] }),
      },
    });
  });

  it("initializes state, capabilities, and nativeSessionRef", () => {
    const transport = new MockKimiTransport();
    const session = new KimiSession({
      transport,
      sessionId: "session-123",
      cwd: "D:/project",
      initialState: {
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse("default"),
      },
    });

    expect(session.harnessId).toBe("kimi-code");
    expect(session.capabilities.configuration.selectModel).toBe(true);
    expect(session.capabilities.history.fork).toBe(true);
    expect(session.capabilities.history.rollbackLastTurn).toBe(true);
    expect(session.initialState.effectivePermissionModeId).toBe("default");
    expect(session.nativeSessionRef.nativeSessionId).toBe("session-123");
    expect(session.nativeSessionRef.locator).toEqual({ cwd: "D:/project" });
  });

  describe("Commands", () => {
    it("lists available commands conforming to schema", async () => {
      const transport = new MockKimiTransport();
      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
      });

      const listResult = await session.commands.list();
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(harnessCommandCatalogSchema.parse(listResult.value)).toBeDefined();
        expect(listResult.value).toEqual(KIMI_DEFAULT_COMMAND_CATALOG);
      }
    });

    it("updates command catalog dynamically on commands.update event", async () => {
      const transport = new MockKimiTransport();
      let lastCatalog: unknown = null;
      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
        onCommandsUpdate: (catalog) => {
          lastCatalog = catalog;
        },
      });

      transport.sessionEventHandler?.({
        type: "commands.update",
        commands: [
          { name: "/compact", description: "Compact context", input: { hint: "prompt" } },
          { name: "clear", description: "Clear context", input: null },
        ],
      });

      expect(lastCatalog).toBeDefined();
      const listResult = await session.commands.list();
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.value.commands).toHaveLength(2);
        expect(listResult.value.commands[0]).toEqual({
          id: "compact",
          invocation: "/compact",
          label: "compact",
          description: "Compact context",
          argumentMode: "text",
        });
        expect(listResult.value.commands[1]).toEqual({
          id: "clear",
          invocation: "/clear",
          label: "clear",
          description: "Clear context",
          argumentMode: "none",
        });
      }
    });

    it("executes command as slash prompt with text arguments", async () => {
      const transport = new MockKimiTransport();
      let promptSent = "";
      transport.promptMock = vi.fn(async (text: string) => {
        promptSent = text;
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-cmd-1");
      const execResult = await session.commands.execute({
        commandId: "compact",
        turnId,
        arguments: { text: "extra" },
      });

      expect(execResult.ok).toBe(true);
      for await (const output of session.outputs) {
        if (output.kind === "event" && output.event.type === "turn.completed") break;
      }
      expect(promptSent).toBe("/compact extra");
    });

    it("executes command without arguments and strips leading slashes", async () => {
      const transport = new MockKimiTransport();
      let promptSent = "";
      transport.promptMock = vi.fn(async (text: string) => {
        promptSent = text;
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-cmd-2");
      const execResult = await session.commands.execute({
        commandId: "///help",
        turnId,
      });

      expect(execResult.ok).toBe(true);
      for await (const output of session.outputs) {
        if (output.kind === "event" && output.event.type === "turn.completed") break;
      }
      expect(promptSent).toBe("/help");
    });

    it("rejects command execution when commandId is invalid", async () => {
      const transport = new MockKimiTransport();
      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-cmd-3");
      const execResult = await session.commands.execute({
        commandId: "///",
        turnId,
      });

      expect(execResult.ok).toBe(false);
      if (!execResult.ok) {
        expect(execResult.error.code).toBe("invalidRequest");
      }
    });

    it("rejects command execution when another turn is already active", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(
        () => new Promise(() => {}), // hangs
      );

      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
      });

      // Start regular turn
      const turn1Id = hostTurnIdSchema.parse("turn-active-1");
      const start1 = await session.execute({
        type: "turn.start",
        turnId: turn1Id,
        input: [{ type: "text", text: "Working..." }],
      });
      expect(start1.ok).toBe(true);

      // Attempt to execute command while turn 1 is active
      const turn2Id = hostTurnIdSchema.parse("turn-cmd-blocked");
      const execResult = await session.commands.execute({
        commandId: "compact",
        turnId: turn2Id,
      });
      expect(execResult.ok).toBe(false);
      if (!execResult.ok) {
        expect(execResult.error.code).toBe("sessionBusy");
      }
    });

    it("supports turn cancellation during command execution", async () => {
      const transport = new MockKimiTransport();
      let cancelCalled = false;
      transport.promptMock = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { stopReason: "cancelled" };
      });
      transport.cancel = vi.fn(async () => {
        cancelCalled = true;
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-123",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-cmd-cancel");
      const execResult = await session.commands.execute({
        commandId: "compact",
        turnId,
      });
      expect(execResult.ok).toBe(true);

      // Cancel turn
      const cancelResult = await session.execute({
        type: "turn.cancel",
        turnId,
      });
      expect(cancelResult.ok).toBe(true);
      expect(cancelCalled).toBe(true);

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      const completed = outputs.find(
        (o) => o.kind === "event" && o.event.type === "turn.completed",
      );
      expect(completed).toBeDefined();
      if (completed && completed.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.outcome.status).toBe("cancelled");
      }
    });
  });

  describe("Turn Execution & Streaming", () => {
    it("runs turn emitting text and completed outcome", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        handler.onEvent({ type: "agent.thought", text: "Thinking..." });
        handler.onEvent({ type: "agent.text", text: "Hello, " });
        handler.onEvent({ type: "agent.text", text: "world!" });
        return { stopReason: "end_turn" };
      });

      let snapshotReads = 0;
      const session = new KimiSession({
        transport,
        sessionId: "session-turn",
        cwd: "D:/project",
        initialState: {},
        readNativeSnapshot: async () => ({
          turns:
            snapshotReads++ === 0
              ? []
              : [
                  {
                    nativeTurnRef: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: "session-turn",
                      nativeTurnKey: "turn:0",
                    },
                    checkpoint: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: "session-turn",
                      checkpointId: "turn:0",
                    },
                    input: [{ type: "text", text: "Say hello" }],
                    items: [],
                    outcome: { status: "succeeded" },
                  },
                ],
        }),
      });

      const turnId = hostTurnIdSchema.parse("turn-1");
      const startResult = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Say hello" }],
      });

      expect(startResult.ok).toBe(true);

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") {
          break;
        }
      }

      const eventTypes = outputs.map((o) => (o.kind === "event" ? o.event.type : o.kind));
      expect(eventTypes).toContain("turn.started");
      expect(eventTypes).toContain("item.started");
      expect(eventTypes).toContain("item.updated");
      expect(eventTypes).toContain("item.completed");
      expect(eventTypes).toContain("turn.completed");

      const itemStarts = outputs.filter(
        (o) => o.kind === "event" && o.event.type === "item.started",
      );
      const reasoningStart = itemStarts.find(
        (s) =>
          s.kind === "event" &&
          s.event.type === "item.started" &&
          s.event.item.type === "reasoning",
      );
      const agentStart = itemStarts.find(
        (s) =>
          s.kind === "event" &&
          s.event.type === "item.started" &&
          s.event.item.type === "agentMessage",
      );
      if (
        reasoningStart &&
        reasoningStart.kind === "event" &&
        reasoningStart.event.type === "item.started" &&
        reasoningStart.event.item.type === "reasoning"
      ) {
        expect(reasoningStart.event.item.text).toBe("");
      }
      if (
        agentStart &&
        agentStart.kind === "event" &&
        agentStart.event.type === "item.started" &&
        agentStart.event.item.type === "agentMessage"
      ) {
        expect(agentStart.event.item.text).toBe("");
      }

      const reasoningCompletedIndex = outputs.findIndex(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "reasoning",
      );
      const agentStartEventIndex = outputs.findIndex(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "agentMessage",
      );
      expect(reasoningCompletedIndex).toBeGreaterThan(-1);
      expect(agentStartEventIndex).toBeGreaterThan(-1);
      expect(reasoningCompletedIndex).toBeLessThan(agentStartEventIndex);

      const completed = outputs.find(
        (o) => o.kind === "event" && o.event.type === "turn.completed",
      );
      expect(completed).toBeDefined();
      if (completed && completed.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.outcome.status).toBe("succeeded");
        expect(completed.event.nativeTurnRef?.nativeTurnKey).toBe("turn:0");
        expect(completed.event.outcome.checkpoint?.checkpointId).toBe("turn:0");
      }
    });

    it("does not report success without a durable Native Turn identity", async () => {
      const transport = new MockKimiTransport();
      const session = new KimiSession({
        transport,
        sessionId: "session-missing-identity",
        cwd: "D:/project",
        initialState: {},
        readNativeSnapshot: async () => ({ turns: [] }),
        nativeTurnFlushTimeoutMs: 100,
      });

      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-missing-identity"),
        input: [{ type: "text", text: "Say hello" }],
      });

      for await (const output of session.outputs) {
        if (output.kind !== "event" || output.event.type !== "turn.completed") continue;
        expect(output.event.outcome.status).toBe("failed");
        expect(output.event.nativeTurnRef).toBeUndefined();
        break;
      }
    });

    it("does not reuse an incomplete native turn that predates the prompt", async () => {
      const transport = new MockKimiTransport();
      const session = new KimiSession({
        transport,
        sessionId: "session-delayed-flush",
        cwd: "D:/project",
        initialState: {},
        nativeTurnFlushTimeoutMs: 100,
        readNativeSnapshot: async () => ({
          turns: [
            {
              nativeTurnRef: createKimiNativeTurnRef("session-delayed-flush", 0),
              input: [{ type: "text", text: "Say hello" }],
              items: [],
              outcome: { status: "unknown", reason: "Missing turn.ended record" },
            },
          ],
        }),
      });

      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-delayed-flush"),
        input: [{ type: "text", text: "Say hello" }],
      });

      for await (const output of session.outputs) {
        if (output.kind !== "event" || output.event.type !== "turn.completed") continue;
        expect(output.event.outcome.status).toBe("failed");
        expect(output.event.nativeTurnRef).toBeUndefined();
        break;
      }
    });

    it("does not reuse the previous native turn when prompt fails before starting", async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "kimi-current-turn-"));
      const sessionId = "session-existing";
      const sessionDir = path.join(home, ".kimi-code", "sessions", sessionId);
      const mainHomeDir = path.join(sessionDir, "agents", "main");
      await mkdir(mainHomeDir, { recursive: true });
      await writeFile(
        path.join(home, ".kimi-code", "session_index.jsonl"),
        JSON.stringify({ sessionId, sessionDir }) + "\n",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({
          id: sessionId,
          version: 2,
          cwd: "D:/project",
          agents: { main: { homedir: mainHomeDir, type: "main" } },
        }),
      );
      await writeFile(
        path.join(mainHomeDir, "wire.jsonl"),
        [
          {
            type: "turn.prompt",
            agentId: "main",
            turnId: 7,
            input: [{ type: "text", text: "old prompt" }],
          },
          { type: "turn.ended", agentId: "main", turnId: 7, reason: "cancelled" },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );

      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(async () => {
        throw new Error("prompt rejected before native turn");
      });
      const session = new KimiSession({
        transport,
        sessionId,
        cwd: "D:/project",
        initialState: {},
        homeDirectory: home,
      });
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-host-new"),
        input: [{ type: "text", text: "new prompt" }],
      });

      const outputs: HarnessOutput[] = [];
      for await (const output of session.outputs) {
        outputs.push(output);
        if (output.kind === "event" && output.event.type === "turn.completed") break;
      }
      const completed = outputs.find(
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      );
      if (completed?.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.outcome.status).toBe("failed");
        expect(completed.event.nativeTurnRef).toBeUndefined();
      }
      expect(
        outputs.some(
          (output) =>
            output.kind === "event" &&
            output.event.type === "item.started" &&
            output.event.item.type === "fileChange",
        ),
      ).toBe(false);
      await rm(home, { recursive: true, force: true });
    });

    it("rejects concurrent turn start with sessionBusy", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(
        () => new Promise(() => {}), // hangs
      );

      const session = new KimiSession({
        transport,
        sessionId: "session-busy",
        cwd: "D:/project",
        initialState: {},
      });

      const turn1 = hostTurnIdSchema.parse("turn-busy-1");
      const res1 = await session.execute({
        type: "turn.start",
        turnId: turn1,
        input: [{ type: "text", text: "Task 1" }],
      });
      expect(res1.ok).toBe(true);

      const turn2 = hostTurnIdSchema.parse("turn-busy-2");
      const res2 = await session.execute({
        type: "turn.start",
        turnId: turn2,
        input: [{ type: "text", text: "Task 2" }],
      });
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("sessionBusy");
      }
    });

    it("accumulates tool call updates and avoids duplicate item.started", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        // tool.call pending
        handler.onEvent({
          type: "tool.call",
          toolCallId: "tool-w1",
          name: "Write",
          args: { path: "test.txt" },
        });

        // tool.update in_progress preview
        handler.onEvent({
          type: "tool.update",
          toolCallId: "tool-w1",
          status: "in_progress",
          rawInput: { path: "test.txt", content: "data" },
          content: "preview",
        });

        // tool.update completed
        handler.onEvent({
          type: "tool.update",
          toolCallId: "tool-w1",
          status: "completed",
          rawOutput: "Wrote 4 bytes",
        });

        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-tool",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-tool-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Write file" }],
      });

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      // Count tool item.started events: must be exactly 1!
      const toolStarted = outputs.filter(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "toolExecution",
      );
      expect(toolStarted).toHaveLength(1);

      const toolCompleted = outputs.filter(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "toolExecution",
      );
      expect(toolCompleted).toHaveLength(1);
    });

    it("maps Bash tool to commandExecution item", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        const call = projectKimiToolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tool-b1",
          title: "Bash",
          kind: "execute",
          rawInput: { command: "cat probe.txt" },
        });
        const update = projectKimiToolUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-b1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "KIMI_PROBE_OK\n" } }],
        });
        if (call) handler.onEvent(call);
        if (update) handler.onEvent(update);
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-bash",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-bash-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "List files" }],
      });

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      const cmdStarted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "commandExecution",
      );
      expect(cmdStarted).toBeDefined();
      if (
        cmdStarted &&
        cmdStarted.kind === "event" &&
        cmdStarted.event.type === "item.started" &&
        cmdStarted.event.item.type === "commandExecution"
      ) {
        expect(cmdStarted.event.item.command).toBe("cat probe.txt");
      }
      const cmdCompleted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "commandExecution",
      );
      if (
        cmdCompleted?.kind === "event" &&
        cmdCompleted.event.type === "item.completed" &&
        cmdCompleted.event.snapshot.item.type === "commandExecution"
      ) {
        expect(cmdCompleted.event.snapshot.item.output).toBe("KIMI_PROBE_OK\n");
      }
    });

    it("preserves canonical tool name for file write and emits reasoning and final answer in correct folding order", async () => {
      const transport = new MockKimiTransport();

      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        // 1. Thinking
        handler.onEvent({ type: "agent.thought", text: "Thinking about creating note.txt" });

        // 2. Tool call: Write
        const call = projectKimiToolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tool-w1",
          title: "Write",
          kind: "edit",
          rawInput: { path: "note.txt", content: "Note content" },
        });
        const update = projectKimiToolUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-w1",
          title: "Writing note.txt",
          status: "completed",
        });
        if (call) handler.onEvent(call);
        if (update) handler.onEvent(update);

        // 3. Final answer text
        handler.onEvent({ type: "agent.text", text: "Created note.txt successfully." });

        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-write",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-write-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Create note.txt" }],
      });

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      // 1. Reasoning item was started and completed before tool
      const reasoningCompleted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "reasoning",
      );
      expect(reasoningCompleted).toBeDefined();

      // 2. Tool execution was started with canonical name "Write" (not "Writing note.txt")
      const toolStarted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "toolExecution",
      );
      expect(toolStarted).toBeDefined();
      if (
        toolStarted &&
        toolStarted.kind === "event" &&
        toolStarted.event.type === "item.started" &&
        toolStarted.event.item.type === "toolExecution"
      ) {
        expect(toolStarted.event.item.toolName).toBe("Write");
        expect(toolStarted.event.item.arguments).toEqual({
          path: "note.txt",
          content: "Note content",
        });
      }

      const toolCompleted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "toolExecution",
      );
      expect(toolCompleted).toBeDefined();
      if (
        toolCompleted &&
        toolCompleted.kind === "event" &&
        toolCompleted.event.type === "item.completed" &&
        toolCompleted.event.snapshot.item.type === "toolExecution"
      ) {
        expect(toolCompleted.event.snapshot.item.toolName).toBe("Write");
      }

      // 3. Final agent message completed
      const agentCompleted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "agentMessage",
      );
      expect(agentCompleted).toBeDefined();
      if (
        agentCompleted &&
        agentCompleted.kind === "event" &&
        agentCompleted.event.type === "item.completed" &&
        agentCompleted.event.snapshot.item.type === "agentMessage"
      ) {
        expect(agentCompleted.event.snapshot.item.text).toBe("Created note.txt successfully.");
        expect(agentCompleted.event.snapshot.item.phase).toBe("final_answer");
      }

      // 4. Verify order of events: reasoning -> tool -> agentMessage
      const eventOrder = outputs
        .filter((o): o is Extract<HarnessOutput, { kind: "event" }> => o.kind === "event")
        .map((o) =>
          o.event.type === "item.started"
            ? `start:${o.event.item.type}`
            : o.event.type === "item.completed"
              ? `complete:${o.event.snapshot.item.type}`
              : o.event.type,
        );

      expect(eventOrder).toContain("start:reasoning");
      expect(eventOrder).toContain("start:toolExecution");
      expect(eventOrder).toContain("start:agentMessage");

      const reasoningStartIdx = eventOrder.indexOf("start:reasoning");
      const toolStartIdx = eventOrder.indexOf("start:toolExecution");
      const agentStartIdx = eventOrder.indexOf("start:agentMessage");

      expect(reasoningStartIdx).toBeLessThan(toolStartIdx);
      expect(toolStartIdx).toBeLessThan(agentStartIdx);
    });
  });

  describe("Interactions", () => {
    it("bridges Approval interaction: allow_always maps to allowForSession, validates response", async () => {
      const transport = new MockKimiTransport();
      let permissionResolvedWith: RequestPermissionResponse | null = null;

      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        const permRequest: RequestPermissionRequest = {
          sessionId: "session-perm",
          toolCall: {
            toolCallId: "call-1",
            title: "Writing probe.txt",
            content: [
              {
                type: "content",
                content: { type: "text", text: "Requesting approval to Writing probe.txt" },
              },
            ],
          },
          options: [
            { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
            { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        };
        permissionResolvedWith = await handler.onPermission(permRequest);
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-perm",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-perm-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Do action" }],
      });

      // Read until interaction is emitted
      let emittedInteraction: HostApprovalInteraction | null = null;
      for await (const out of session.outputs) {
        if (out.kind === "interaction" && out.interaction.type === "approval") {
          emittedInteraction = out.interaction;
          break;
        }
      }

      expect(emittedInteraction).not.toBeNull();
      expect(emittedInteraction?.title).toBe("Writing probe.txt");
      expect(emittedInteraction?.description).toBe("Requesting approval to Writing probe.txt");
      expect(emittedInteraction?.actions).toHaveLength(3);
      const alwaysAction = emittedInteraction?.actions.find((a) => a.id === "approve_always");
      expect(alwaysAction?.effect).toBe("allowForSession");

      // Respond to interaction
      expect(emittedInteraction).toBeDefined();
      if (!emittedInteraction) return;
      const respondResult = await session.execute({
        type: "interaction.respond",
        interactionId: emittedInteraction.interactionId,
        response: {
          type: "approval",
          actionId: "approve_always",
        },
      });

      expect(respondResult.ok).toBe(true);
      expect(permissionResolvedWith).toEqual({
        outcome: { outcome: "selected", optionId: "approve_always" },
      });
    });

    it("bridges Elicitation (Question) interaction with single and multi choice", async () => {
      const transport = new MockKimiTransport();
      let elicitationResolvedWith: CreateElicitationResponse | null = null;

      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        const elicitationReq: CreateElicitationRequest = {
          sessionId: "session-elic",
          mode: "form",
          message: "Questions",
          requestedSchema: {
            type: "object",
            properties: {
              q0: {
                type: "string",
                title: "Color",
                oneOf: [
                  { const: "Red", title: "Red" },
                  { const: "Blue", title: "Blue" },
                ],
              },
              q1: {
                type: "array",
                title: "Fruits",
                items: { anyOf: [{ const: "Apple" }, { const: "Pear" }] },
              },
            },
            required: ["q0", "q1"],
          },
        };
        elicitationResolvedWith = await handler.onElicitation(elicitationReq);
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-elic",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-elic-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Ask questions" }],
      });

      let emittedQuestion: HostQuestionInteraction | null = null;
      for await (const out of session.outputs) {
        if (out.kind === "interaction" && out.interaction.type === "question") {
          emittedQuestion = out.interaction;
          break;
        }
      }

      expect(emittedQuestion).not.toBeNull();
      if (!emittedQuestion) return;
      expect(emittedQuestion.questions).toHaveLength(2);
      const q0 = emittedQuestion.questions[0];
      const q1 = emittedQuestion.questions[1];
      if (q0 && "options" in q0) {
        expect(q0.multiple).toBe(false);
      }
      if (q1 && "options" in q1) {
        expect(q1.multiple).toBe(true);
      }

      // Respond
      const respondResult = await session.execute({
        type: "interaction.respond",
        interactionId: emittedQuestion.interactionId,
        response: {
          type: "question",
          answers: {
            q0: ["Red"],
            q1: ["Apple", "Pear"],
          },
        },
      });

      expect(respondResult.ok).toBe(true);
      expect(elicitationResolvedWith).toEqual({
        action: "accept",
        content: {
          q0: "Red",
          q1: ["Apple", "Pear"],
        },
      });
    });

    it("emits reasoning envelope when thought occurs before elicitation and finishes turn cleanly with final answer", async () => {
      const transport = new MockKimiTransport();

      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        handler.onEvent({ type: "agent.thought", text: "Thinking about options..." });
        const elicitationReq: CreateElicitationRequest = {
          sessionId: "s",
          mode: "form",
          message: "Select an option",
          requestedSchema: {
            title: "Ask user question",
            properties: {
              question: {
                title: "question",
                type: "string",
                oneOf: [{ const: "opt1", title: "Option 1" }],
              },
            },
          },
        };
        const elicitationPromise = handler.onElicitation(elicitationReq);

        await elicitationPromise;
        handler.onEvent({ type: "agent.text", text: "Answer complete." });
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "session-elic-fold",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("turn-elic-fold-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Test question tool" }],
      });

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "interaction" && out.interaction.type === "question") {
          expect(out.interaction.title).toBe("提问");
          expect(out.interaction.questions[0]?.prompt).toBe("Select an option");
          // Respond to question
          void session.execute({
            type: "interaction.respond",
            interactionId: out.interaction.interactionId,
            response: {
              type: "question",
              answers: { question: ["opt1"] },
            },
          });
        }
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      // Verify reasoning item was emitted BEFORE interaction
      const reasoningCompleted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "reasoning",
      );
      expect(reasoningCompleted).toBeDefined();
      if (
        reasoningCompleted &&
        reasoningCompleted.kind === "event" &&
        reasoningCompleted.event.type === "item.completed" &&
        reasoningCompleted.event.snapshot.item.type === "reasoning"
      ) {
        expect(reasoningCompleted.event.snapshot.item.text).toBe("Thinking about options...");
      }

      // Verify final agent message has no commentary phase
      const agentCompleted = outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "agentMessage",
      );
      expect(agentCompleted).toBeDefined();
      if (
        agentCompleted &&
        agentCompleted.kind === "event" &&
        agentCompleted.event.type === "item.completed" &&
        agentCompleted.event.snapshot.item.type === "agentMessage"
      ) {
        expect(agentCompleted.event.snapshot.item.text).toBe("Answer complete.");
        expect(agentCompleted.event.snapshot.item.phase).toBeUndefined();
      }

      // Verify order: start:reasoning -> complete:reasoning -> interaction -> agentMessage -> turn.completed
      const eventKinds = outputs.map((o) => {
        if (o.kind === "interaction") return "interaction";
        if (o.event.type === "item.started") return `start:${o.event.item.type}`;
        if (o.event.type === "item.completed") return `complete:${o.event.snapshot.item.type}`;
        return o.event.type;
      });

      expect(eventKinds.indexOf("start:reasoning")).toBeLessThan(eventKinds.indexOf("interaction"));
      expect(eventKinds.indexOf("interaction")).toBeLessThan(
        eventKinds.indexOf("start:agentMessage"),
      );
    });

    it("rejects interaction response with mismatched type or action", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        await handler.onPermission({
          sessionId: "s",
          toolCall: { toolCallId: "call-1" },
          options: [{ optionId: "allow_once", name: "Allow Once", kind: "allow_once" }],
        });
        return { stopReason: "end_turn" };
      });

      const session = new KimiSession({
        transport,
        sessionId: "s",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("t-mismatch");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "run" }],
      });

      let interactionId: HostInteractionId | undefined;
      for await (const out of session.outputs) {
        if (out.kind === "interaction") {
          interactionId = out.interaction.interactionId;
          break;
        }
      }

      // Wrong type: sending question response to approval interaction
      expect(interactionId).toBeDefined();
      if (!interactionId) return;
      const res = await session.execute({
        type: "interaction.respond",
        interactionId,
        response: {
          type: "question",
          answers: {},
        },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("invalidRequest");
      }
    });
  });

  describe("Cancellation", () => {
    it("cancels active turn and emits turn.completed with cancelled outcome", async () => {
      const transport = new MockKimiTransport();
      let cancelCalled = false;
      transport.promptMock = vi.fn(async () => {
        // Simulate waiting for prompt
        await new Promise((r) => setTimeout(r, 50));
        return { stopReason: "cancelled" };
      });
      transport.cancel = vi.fn(async () => {
        cancelCalled = true;
      });

      const session = new KimiSession({
        transport,
        sessionId: "s-cancel",
        cwd: "D:/project",
        initialState: {},
      });

      const turnId = hostTurnIdSchema.parse("t-cancel");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Long task" }],
      });

      const cancelResult = await session.execute({
        type: "turn.cancel",
        turnId,
      });

      expect(cancelResult.ok).toBe(true);
      expect(cancelCalled).toBe(true);

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      const completed = outputs.find(
        (o) => o.kind === "event" && o.event.type === "turn.completed",
      );
      expect(completed).toBeDefined();
      if (completed && completed.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.outcome.status).toBe("cancelled");
      }
    });
  });

  describe("Configuration Commands", () => {
    it("handles model.select, thinking.select, and permissionMode.select", async () => {
      const transport = new MockKimiTransport();
      const session = new KimiSession({
        transport,
        sessionId: "s-cfg",
        cwd: "D:/project",
        initialState: {},
      });

      const modelRes = await session.execute({
        type: "model.select",
        model: encodeKimiModelRef("kimi-k2"),
      });
      expect(modelRes.ok).toBe(true);
      expect(transport.configOptionsSet).toContainEqual({ configId: "model", value: "kimi-k2" });

      const thinkingRes = await session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      });
      expect(thinkingRes.ok).toBe(true);
      expect(transport.configOptionsSet).toContainEqual({ configId: "thinking", value: "high" });

      const modeRes = await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      });
      expect(modeRes.ok).toBe(true);
      expect(transport.configOptionsSet).toContainEqual({ configId: "mode", value: "plan" });
    });
  });

  describe("Folding & Turn Completion Regressions", () => {
    it("tags pre-tool text as commentary and post-tool terminal text as final_answer without fake reasoning", async () => {
      const transport = new MockKimiTransport();
      transport.promptMock = vi.fn(async (_text: string, handler: ActivePromptHandler) => {
        // 1. Text arrives before tool call
        handler.onEvent({
          type: "agent.text",
          text: "No existing python files found. Writing quicksort...",
        });
        // 2. Tool call arrives shortly after
        handler.onEvent({
          type: "tool.call",
          toolCallId: "call-w",
          name: "Write",
          args: { path: "quicksort.py", content: "def quicksort(): pass" },
        });
        handler.onEvent({
          type: "tool.update",
          toolCallId: "call-w",
          status: "completed",
        });
        // 3. Final answer arrives after tool completion
        handler.onEvent({
          type: "agent.text",
          text: "Done. Created quicksort.py.",
        });
        return { stopReason: "end_turn" };
      });

      let snapshotReads = 0;
      const session = new KimiSession({
        transport,
        sessionId: "s-fold-reg",
        cwd: "D:/project",
        initialState: {},
        readNativeSnapshot: async () => ({
          turns:
            snapshotReads++ === 0
              ? []
              : [
                  {
                    nativeTurnRef: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: "s-fold-reg",
                      nativeTurnKey: "turn:0",
                    },
                    input: [{ type: "text", text: "write algorithm\n" }],
                    items: [],
                    outcome: { status: "succeeded" },
                  },
                ],
        }),
      });

      const turnId = hostTurnIdSchema.parse("turn-fold-test");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "write algorithm" }],
      });

      const outputs: HarnessOutput[] = [];
      for await (const out of session.outputs) {
        outputs.push(out);
        if (out.kind === "event" && out.event.type === "turn.completed") break;
      }

      // Check all agentMessage completions
      const agentMessages = outputs.filter(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "agentMessage",
      );
      expect(agentMessages).toHaveLength(2);

      // Pre-tool message has phase: commentary
      const commentaryMsg = agentMessages[0];
      if (
        commentaryMsg &&
        commentaryMsg.kind === "event" &&
        commentaryMsg.event.type === "item.completed" &&
        commentaryMsg.event.snapshot.item.type === "agentMessage"
      ) {
        expect(commentaryMsg.event.snapshot.item.text).toBe(
          "No existing python files found. Writing quicksort...",
        );
        expect(commentaryMsg.event.snapshot.item.phase).toBe("commentary");
      }

      // Final answer message has phase: final_answer
      const finalMsg = agentMessages[1];
      if (
        finalMsg &&
        finalMsg.kind === "event" &&
        finalMsg.event.type === "item.completed" &&
        finalMsg.event.snapshot.item.type === "agentMessage"
      ) {
        expect(finalMsg.event.snapshot.item.text).toBe("Done. Created quicksort.py.");
        expect(finalMsg.event.snapshot.item.phase).toBe("final_answer");
      }

      // No fake reasoning items were generated
      const reasoningItems = outputs.filter(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "reasoning",
      );
      expect(reasoningItems).toHaveLength(0);

      // Order check: commentary -> toolExecution -> finalAnswer
      const eventTypes = outputs.map((o) => {
        if (o.kind === "event") {
          if (o.event.type === "item.started") return `start:${o.event.item.type}`;
          if (o.event.type === "item.completed") return `complete:${o.event.snapshot.item.type}`;
          return o.event.type;
        }
        return o.kind;
      });

      expect(eventTypes.indexOf("complete:agentMessage")).toBeLessThan(
        eventTypes.indexOf("start:toolExecution"),
      );
      expect(eventTypes.indexOf("complete:toolExecution")).toBeLessThan(
        eventTypes.lastIndexOf("start:agentMessage"),
      );
    });

    it("correlates Native Turn with trailing newline in user input without 2000ms delay", async () => {
      const transport = new MockKimiTransport();
      let snapshotReads = 0;
      const session = new KimiSession({
        transport,
        sessionId: "s-correlate-reg",
        cwd: "D:/project",
        initialState: {},
        readNativeSnapshot: async () => ({
          turns:
            snapshotReads++ === 0
              ? []
              : [
                  {
                    nativeTurnRef: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: "s-correlate-reg",
                      nativeTurnKey: "turn:0",
                    },
                    input: [{ type: "text", text: "test input\n" }], // Kimi writes with \n
                    items: [],
                    outcome: { status: "succeeded" },
                  },
                ],
        }),
      });

      const startTime = Date.now();
      const turnId = hostTurnIdSchema.parse("turn-corr-test");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "test input" }], // Codex starts without \n
      });

      for await (const out of session.outputs) {
        if (out.kind === "event" && out.event.type === "turn.completed") {
          expect(out.event.outcome.status).toBe("succeeded");
          break;
        }
      }

      const elapsed = Date.now() - startTime;
      // Should correlate immediately, nowhere near the 2000ms timeout
      expect(elapsed).toBeLessThan(1000);
    });

    it("cancels immediately when turn.cancel is received", async () => {
      const transport = new MockKimiTransport();
      let cancelCalled = false;
      transport.promptMock = vi.fn(async () => {
        while (!cancelCalled) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return { stopReason: "cancelled" };
      });
      transport.cancel = async () => {
        cancelCalled = true;
      };

      const session = new KimiSession({
        transport,
        sessionId: "s-cancel-reg",
        cwd: "D:/project",
        initialState: {},
        readNativeSnapshot: async () => ({ turns: [] }),
      });

      const turnId = hostTurnIdSchema.parse("turn-cancel-test");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "cancel me" }],
      });

      const cancelRes = await session.execute({
        type: "turn.cancel",
        turnId,
      });
      expect(cancelRes.ok).toBe(true);

      for await (const out of session.outputs) {
        if (out.kind === "event" && out.event.type === "turn.completed") {
          expect(out.event.outcome.status).toBe("cancelled");
          break;
        }
      }
    });
  });

  describe("Close", () => {
    it("closes transport, cancels pending interactions, and ends outputs", async () => {
      const transport = new MockKimiTransport();
      const session = new KimiSession({
        transport,
        sessionId: "s-close",
        cwd: "D:/project",
        initialState: {},
      });

      await session.close();
      expect(transport.isClosed).toBe(true);

      // Subsequent execute should fail with invalidState
      const res = await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("t-after-close"),
        input: [{ type: "text", text: "test" }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("invalidState");
      }
    });
  });
});
