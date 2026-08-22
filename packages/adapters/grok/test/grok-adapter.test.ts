import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { resolve } from "node:path";
import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type { GrokCompactResult } from "../src/grok-manual-compaction.js";
import {
  GrokAdapter,
  GrokTransportError,
  GROK_SESSION_FORK_METHOD,
  type GrokAcpTransportLike,
  type GrokOpenInput,
  type GrokOpenResult,
  type GrokPermissionRequest,
  type GrokTransportEvent,
} from "../src/index.js";

const initialize: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  _meta: {
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
            totalContextTokens: 500000,
          },
        },
      ],
    },
  },
};

class FakeGrokTransport implements GrokAcpTransportLike {
  sessionId = "grok-session";
  readonly openCalls: GrokOpenInput[] = [];
  readonly compactCalls: Array<string | undefined> = [];
  readonly cancel = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly deleteSession = vi.fn(async (sessionId: string) => {
    this.histories.delete(sessionId);
  });
  readonly forkCalls: Extract<GrokOpenInput, { kind: "fork" }>[] = [];
  readonly rewindCalls: Extract<GrokOpenInput, { kind: "rewind" }>[] = [];
  histories = new Map<string, GrokTransportEvent[]>();
  sessionLocations = new Map<string, { cwd: string; sourceWorkspaceDir?: string }>();
  replay: GrokTransportEvent[] = [];
  signals: unknown;
  methodNotFound = false;
  forkImpl?: (input: Extract<GrokOpenInput, { kind: "fork" }>) => Promise<{ sessionId: string }>;
  rewindImpl?: (input: Extract<GrokOpenInput, { kind: "rewind" }>) => Promise<void>;
  #activePromptEvents: GrokTransportEvent[] = [];
  #activePromptText: string | null = null;
  #onEvent: ((event: GrokTransportEvent) => void) | null = null;
  #onPermission: ((request: GrokPermissionRequest) => Promise<RequestPermissionResponse>) | null =
    null;
  #resolve: ((response: PromptResponse) => void) | null = null;
  #compactResolve: ((result: GrokCompactResult) => void) | null = null;
  #compactOnEvent: ((event: GrokTransportEvent) => void) | null = null;

  async inspect(): Promise<InitializeResponse> {
    return initialize;
  }

  async open(input: GrokOpenInput): Promise<GrokOpenResult> {
    this.openCalls.push(input);
    if (input.kind === "resume") {
      this.sessionId = input.sessionId;
      const stored = this.histories.get(input.sessionId);
      if (stored) this.replay = [...stored];
    } else if (input.kind === "fork") {
      this.forkCalls.push(input);
      if (this.methodNotFound) {
        throw new GrokTransportError(
          "protocolError",
          `Grok ACP Method Not Found: ${GROK_SESSION_FORK_METHOD}`,
        );
      }
      if (this.forkImpl) {
        const forked = await this.forkImpl(input);
        this.sessionId = forked.sessionId;
        this.replay = [...(this.histories.get(forked.sessionId) ?? [])];
      } else {
        throw new GrokTransportError("unavailable", "Grok Native Fork failed");
      }
    } else if (input.kind === "rewind") {
      this.rewindCalls.push(input);
      if (this.methodNotFound) {
        throw new GrokTransportError(
          "protocolError",
          "Grok ACP Method Not Found: _x.ai/rewind/execute",
        );
      }
      this.sessionId = input.sessionId;
      if (this.rewindImpl) {
        await this.rewindImpl(input);
        this.replay = [...(this.histories.get(input.sessionId) ?? [])];
      } else {
        throw new GrokTransportError("unavailable", "Grok Native Rewind failed");
      }
    }
    return {
      initialize,
      session: { sessionId: this.sessionId },
      sessionId: this.sessionId,
      replay: [...this.replay],
      ...(this.signals !== undefined ? { signals: this.signals } : {}),
    };
  }

  async getHistory(): Promise<GrokTransportEvent[]> {
    return this.readHistory(this.sessionId);
  }

  async readHistory(sessionId: string): Promise<GrokTransportEvent[]> {
    const stored = this.histories.get(sessionId);
    if (stored) return [...stored];
    return sessionId === this.sessionId ? [...this.replay] : [];
  }

  async locateSession(
    sessionId: string,
  ): Promise<{ cwd: string; sourceWorkspaceDir?: string } | null> {
    const explicit = this.sessionLocations.get(sessionId);
    if (explicit) return explicit;
    if (this.histories.has(sessionId) || sessionId === this.sessionId) {
      return { cwd: "/synthetic" };
    }
    return null;
  }

  runTurn(
    text: string,
    onEvent: (event: GrokTransportEvent) => void,
    onPermission: (request: GrokPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse> {
    this.#activePromptText = text;
    this.#activePromptEvents = [];
    this.#onEvent = onEvent;
    this.#onPermission = onPermission;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  event(event: GrokTransportEvent): void {
    this.#activePromptEvents.push(event);
    this.#onEvent?.(event);
  }

  compactEvent(event: GrokTransportEvent): void {
    this.#compactOnEvent?.(event);
  }

  finishCompact(result: GrokCompactResult = { outcome: "succeeded" }): void {
    this.#compactResolve?.(result);
    this.#compactResolve = null;
    this.#compactOnEvent = null;
  }

  compact(
    userContext: string | undefined,
    onEvent: (event: GrokTransportEvent) => void,
  ): Promise<GrokCompactResult> {
    this.compactCalls.push(userContext);
    this.#compactOnEvent = onEvent;
    return new Promise((resolve) => {
      this.#compactResolve = resolve;
    });
  }

  permission(): Promise<RequestPermissionResponse> {
    if (!this.#onPermission) throw new Error("No active Grok Prompt");
    return this.#onPermission({
      request: {
        sessionId: this.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run tests" },
        options: [
          { optionId: "native-allow", name: "Allow once", kind: "allow_once" },
          { optionId: "native-deny", name: "Reject", kind: "reject_once" },
        ],
      },
      options: [
        { optionId: "native-allow", name: "Allow once", kind: "allow_once" },
        { optionId: "native-deny", name: "Reject", kind: "reject_once" },
      ],
    });
  }

  finish(response: PromptResponse = { stopReason: "end_turn" }, historyUsage?: unknown): void {
    if (this.#activePromptText !== null) {
      const ordinal = this.replay.filter(({ type }) => type === "turn.completed").length + 1;
      this.replay.push(
        {
          type: "user.text",
          text: this.#activePromptText,
          metadata: { eventId: `grok-session-user-${ordinal}` },
        },
        ...this.#activePromptEvents,
        {
          type: "turn.completed",
          nativeTurnKey: `grok-prompt-${ordinal}`,
          stopReason: response.stopReason,
          ...(historyUsage !== undefined ? { usage: historyUsage } : {}),
        },
      );
    }
    this.#activePromptText = null;
    this.#activePromptEvents = [];
    this.#resolve?.(response);
    this.#resolve = null;
  }
}

async function openedSession(
  transport: FakeGrokTransport,
  kind: "create" | "resume" = "create",
  knownTurnRefs?: NativeTurnRef[],
) {
  let uuid = 0;
  const adapter = new GrokAdapter(
    {},
    {
      randomUUID: () => `grok-id-${++uuid}`,
      createTransport: () => transport,
      fetchCredits: async () => null,
    },
  );
  const opened = await adapter.open(
    kind === "create"
      ? { kind: "create", cwd: "/synthetic" }
      : {
          kind: "resume",
          cwd: "/synthetic",
          nativeRef: {
            harnessId: adapter.harnessId,
            nativeSessionId: transport.sessionId,
            formatVersion: 1,
          },
          ...(knownTurnRefs ? { knownTurnRefs } : {}),
        },
  );
  if (!opened.ok) throw new Error(opened.error.message);
  return { adapter, session: opened.value };
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Grok output ended unexpectedly");
  return result.value;
}

async function nextEvent(
  iterator: AsyncIterator<HarnessOutput>,
): Promise<Extract<HarnessOutput, { kind: "event" }>["event"]> {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected Grok Event");
  return output.event;
}

describe("Grok Adapter ACP projection", () => {
  it("reports a single available Grok Model as selectable", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: () => "grok-id",
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );

    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      catalog: { models: [{ ref: { id: "grok-4.6" } }] },
      permissionModes: {
        modes: [
          { id: "default", label: "Default" },
          { id: "ask", label: "Ask" },
          { id: "auto", label: "Auto" },
          { id: "always-approve", label: "Always approve", dangerous: true },
        ],
        defaultModeId: "default",
      },
      capabilities: {
        configuration: { selectModel: true, selectPermissionMode: true },
      },
    });

    await adapter.close();
  });

  it("seeds and changes the native Grok Permission Mode", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: () => "grok-id",
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const auto = harnessPermissionModeIdSchema.parse("auto");
    const alwaysApprove = harnessPermissionModeIdSchema.parse("always-approve");
    const opened = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: auto,
    });
    if (!opened.ok) throw new Error(opened.error.message);

    expect(transport.openCalls).toContainEqual({ kind: "create", permissionModeId: auto });
    expect(transport.setPermissionMode).toHaveBeenCalledWith(auto);
    expect(opened.value.initialState.effectivePermissionModeId).toBe(auto);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await expect(
      opened.value.execute({ type: "permissionMode.select", permissionModeId: alwaysApprove }),
    ).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(transport.setPermissionMode).toHaveBeenCalledWith(alwaysApprove);
    await expect(nextEvent(outputs)).resolves.toMatchObject({
      type: "session.state.changed",
      state: { effectivePermissionModeId: alwaysApprove },
    });

    await adapter.close();
  });

  it("keeps Native Turn identity stable across live completion and resume", async () => {
    const liveTransport = new FakeGrokTransport();
    const live = await openedSession(liveTransport);
    const liveIterator = live.session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-stable");

    await live.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "before" }],
    });
    expect((await nextEvent(liveIterator)).type).toBe("turn.started");
    liveTransport.event({ type: "agent.text", text: "answer", messageId: "agent-1" });
    expect((await nextEvent(liveIterator)).type).toBe("item.started");
    expect((await nextEvent(liveIterator)).type).toBe("item.updated");
    liveTransport.finish();
    expect((await nextEvent(liveIterator)).type).toBe("item.completed");
    const completed = await nextEvent(liveIterator);
    if (completed.type !== "turn.completed" || !completed.nativeTurnRef) {
      throw new Error("Live Grok Turn has no Native identity");
    }
    await live.adapter.close();

    const resumedTransport = new FakeGrokTransport();
    resumedTransport.replay = [...liveTransport.replay];
    const resumed = await openedSession(resumedTransport, "resume");
    const snapshot = await resumed.session.readSnapshot();
    if (!snapshot.ok || !snapshot.value.turns[0]) {
      throw new Error("Resumed Grok Snapshot has no Turn");
    }
    expect(snapshot.value.turns[0].nativeTurnRef).toEqual(completed.nativeTurnRef);
    await resumed.adapter.close();
  });

  it("omits background-task control records without shifting persisted Turn identities", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      {
        type: "user.text",
        text: "first",
        metadata: { eventId: "grok-session-user-1" },
      },
      { type: "agent.text", text: "answer-1", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
      },
      {
        type: "user.text",
        text: '<system-reminder>\nBackground task "call-1" completed.\n</system-reminder>',
        metadata: { eventId: "grok-session-user-bg" },
      },
      {
        type: "turn.completed",
        nativeTurnKey: "task-completed-call-1",
        stopReason: "end_turn",
      },
      {
        type: "user.text",
        text: "second",
        metadata: { eventId: "grok-session-user-2" },
      },
      { type: "agent.text", text: "answer-2", messageId: "agent-2" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-2",
        stopReason: "end_turn",
      },
      {
        type: "user.text",
        text: "third",
        metadata: { eventId: "grok-session-user-3" },
      },
      { type: "agent.text", text: "answer-3", messageId: "agent-3" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-3",
        stopReason: "end_turn",
      },
    ];
    const known = [
      nativeTurnRefSchema.parse({
        harnessId: "grok",
        nativeSessionId: transport.sessionId,
        nativeTurnKey: "grok-prompt-1",
        formatVersion: 1,
      }),
      nativeTurnRefSchema.parse({
        harnessId: "grok",
        nativeSessionId: transport.sessionId,
        nativeTurnKey: "grok-prompt-2",
        formatVersion: 1,
      }),
    ];
    const { adapter, session } = await openedSession(transport, "resume", known);
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: known[0],
            input: [{ type: "text", text: "first" }],
          },
          {
            nativeTurnRef: known[1],
            input: [{ type: "text", text: "second" }],
          },
          {
            nativeTurnRef: {
              nativeTurnKey: "grok-prompt-3",
            },
            input: [{ type: "text", text: "third" }],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("projects Thinking, Tool, Approval, Text, Usage, and terminal in order", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-1");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");

    transport.event({ type: "agent.thought", text: "checking", messageId: "message-1" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");

    transport.event({
      type: "tool.call",
      callId: "tool-1",
      title: "Run tests",
      name: "bash",
      rawInput: { command: "npm test" },
      status: "in_progress",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: { type: "commandExecution", command: "npm test", cwd: resolve("/synthetic") },
    });

    const permission = transport.permission();
    const interactionOutput = await nextOutput(iterator);
    if (interactionOutput.kind !== "interaction") throw new Error("Expected Grok Approval");
    expect(interactionOutput.interaction).toMatchObject({
      type: "approval",
      title: "Run tests",
      actions: [
        { id: "native-1", effect: "allowOnce" },
        { id: "native-2", effect: "deny" },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interactionOutput.interaction.interactionId,
        response: { type: "approval", actionId: "native-1" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "native-allow" },
    });
    expect((await nextEvent(iterator)).type).toBe("interaction.closed");

    transport.event({
      type: "tool.update",
      callId: "tool-1",
      status: "completed",
      rawOutput: "passed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: { type: "output.append", text: "passed" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "commandExecution", command: "npm test", output: "passed" },
        outcome: { status: "succeeded" },
      },
    });
    transport.event({ type: "agent.text", text: "done", messageId: "message-2" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    transport.finish({
      stopReason: "end_turn",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            items: [
              { item: { type: "reasoning", text: "checking" } },
              {
                item: { type: "commandExecution", command: "npm test", output: "passed" },
                outcome: { status: "succeeded" },
              },
              { item: { type: "agentMessage", text: "done" } },
            ],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("projects Generic Tool arguments and readable results, including raw_output-only tools", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-generic-tools");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "inspect" }],
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.event({
      type: "tool.call",
      callId: "read-1",
      title: "Read a.txt",
      name: "read_file",
      rawInput: { target_file: "/synthetic/a.txt" },
      status: "in_progress",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "toolExecution",
        toolName: "read_file",
        arguments: { target_file: "/synthetic/a.txt" },
      },
    });
    transport.event({
      type: "tool.update",
      callId: "read-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file body" } }],
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "output.replace",
        output: { content: [{ type: "text", text: "file body" }] },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: {
          type: "toolExecution",
          output: { content: [{ type: "text", text: "file body" }] },
        },
        outcome: { status: "succeeded" },
      },
    });
    transport.event({
      type: "tool.call",
      callId: "list-1",
      title: "List /synthetic",
      name: "list_dir",
      rawInput: { target_directory: "/synthetic" },
      status: "in_progress",
    });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transport.event({
      type: "tool.update",
      callId: "list-1",
      status: "completed",
      rawOutput: { type: "ListDir", content: "a.ts\nb.ts" },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.updated",
      update: {
        type: "output.replace",
        output: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "toolExecution", toolName: "list_dir" },
        outcome: { status: "succeeded" },
      },
    });
    transport.finish();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            items: [
              {
                item: {
                  type: "toolExecution",
                  toolName: "read_file",
                  output: { content: [{ type: "text", text: "file body" }] },
                },
              },
              {
                item: {
                  type: "toolExecution",
                  toolName: "list_dir",
                  output: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
                },
              },
            ],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("projects only successful terminal ACP Diff Content and restores it from history", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-file-change");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "edit" }],
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.event({
      type: "tool.call",
      callId: "edit-1",
      title: "Edit sample.txt",
      name: "search_replace",
      status: "in_progress",
      rawInput: { file_path: "/synthetic/sample.txt" },
    });
    expect((await nextEvent(iterator)).type).toBe("item.started");

    transport.event({
      type: "tool.update",
      callId: "edit-1",
      kind: "edit",
      content: [
        {
          type: "diff",
          path: "/synthetic/sample.txt",
          oldText: "",
          newText: "final\n",
        },
      ],
    });
    transport.event({
      type: "tool.update",
      callId: "edit-1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/synthetic/sample.txt",
          oldText: "before\n",
          newText: "final\n",
        },
      ],
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" }, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.started",
      item: {
        type: "fileChange",
        changes: [
          {
            path: "sample.txt",
            kind: "update",
            unifiedDiff: expect.stringMatching(/-before[\s\S]*\+final/u),
          },
        ],
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "fileChange" }, outcome: { status: "succeeded" } },
    });
    transport.finish();
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            items: [
              { item: { type: "toolExecution" }, outcome: { status: "succeeded" } },
              {
                item: {
                  type: "fileChange",
                  changes: [
                    {
                      path: "sample.txt",
                      kind: "update",
                      unifiedDiff: expect.stringMatching(/-before[\s\S]*\+final/u),
                    },
                  ],
                },
                outcome: { status: "succeeded" },
              },
            ],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("keeps failed terminal ACP Diff Content Tool-only", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-failed-file-change");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "edit" }],
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.event({
      type: "tool.call",
      callId: "edit-1",
      title: "Edit sample.txt",
      status: "in_progress",
    });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transport.event({
      type: "tool.update",
      callId: "edit-1",
      status: "failed",
      content: [
        {
          type: "diff",
          path: "/synthetic/sample.txt",
          oldText: "before\n",
          newText: "after\n",
        },
      ],
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "toolExecution" }, outcome: { status: "failed" } },
    });
    transport.finish();
    expect(await nextEvent(iterator)).toMatchObject({ type: "turn.completed" });

    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            items: [{ item: { type: "toolExecution" }, outcome: { status: "failed" } }],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("publishes Grok turn_completed Usage without dropping context", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-usage");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");

    transport.event({
      type: "agent.text",
      text: "working",
      messageId: "message-1",
      metadata: { totalTokens: 7734 },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "session.usage.changed",
      observedForTurnId: turnId,
      usage: { contextUsedTokens: 7734, contextWindowTokens: 500000 },
    });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");

    transport.event({
      type: "turn.completed",
      nativeTurnKey: "grok-prompt-1",
      stopReason: "end_turn",
      usage: {
        inputTokens: 330555,
        outputTokens: 3737,
        totalTokens: 334292,
        cachedReadTokens: 296448,
        cacheCreationTokens: 0,
        reasoningTokens: 2189,
        modelCalls: 9,
        apiDurationMs: 82160,
        costUsdTicks: 2388600000,
        numTurns: 9,
      },
    });
    transport.finish();
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: {
        contextUsedTokens: 7734,
        contextWindowTokens: 500000,
        inputTokens: 330555,
        outputTokens: 3737,
        totalTokens: 334292,
        cachedInputTokens: 296448,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 2189,
        totalCostUsd: 0.23886,
        cacheHitRatePercent: (296448 / 330555) * 100,
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await adapter.close();
  });

  it("publishes cache hit and cost from persisted turn_completed Usage", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-history-usage");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedReadTokens: 80,
        cacheCreationTokens: 0,
        reasoningTokens: 4,
        costUsdTicks: 126890500,
      },
    );
    const events = [];
    for (;;) {
      const event = await nextEvent(iterator);
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.usage.changed",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 4,
          totalTokens: 110,
          totalCostUsd: 0.01268905,
          cacheHitRatePercent: 80,
        },
      }),
    );
    await adapter.close();
  });

  it("restores resume Usage from Native history and signals", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "before", metadata: { eventId: "grok-session-user-1" } },
      { type: "agent.text", text: "answer", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 80,
          cacheCreationTokens: 0,
          reasoningTokens: 4,
          costUsdTicks: 126890500,
        },
      },
    ];
    transport.signals = {
      contextTokensUsed: 52322,
      contextWindowTokens: 500000,
      turnCount: 1,
    };
    const { adapter, session } = await openedSession(transport, "resume");
    expect(session.initialUsage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 4,
      totalCostUsd: 0.01268905,
      cacheHitRatePercent: 80,
      contextUsedTokens: 52322,
      contextWindowTokens: 500000,
    });
    await adapter.close();
  });

  it("sums persisted turn_completed Usage across the Native Session", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();

    const firstTurnId = hostTurnIdSchema.parse("turn-history-sum-1");
    await expect(
      session.execute({
        type: "turn.start",
        turnId: firstTurnId,
        input: [{ type: "text", text: "first" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: firstTurnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedReadTokens: 80,
        cacheCreationTokens: 0,
        reasoningTokens: 4,
        costUsdTicks: 126890500,
      },
    );
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }

    const secondTurnId = hostTurnIdSchema.parse("turn-history-sum-2");
    await expect(
      session.execute({
        type: "turn.start",
        turnId: secondTurnId,
        input: [{ type: "text", text: "second" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: secondTurnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 50,
        outputTokens: 5,
        totalTokens: 55,
        cachedReadTokens: 45,
        cacheCreationTokens: 2,
        reasoningTokens: 1,
        costUsdTicks: 2388600000,
      },
    );
    const events = [];
    for (;;) {
      const event = await nextEvent(iterator);
      events.push(event);
      if (event.type === "turn.completed") break;
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.usage.changed",
        usage: {
          inputTokens: 150,
          cachedInputTokens: 125,
          cacheWriteInputTokens: 2,
          outputTokens: 15,
          reasoningOutputTokens: 5,
          totalTokens: 165,
          totalCostUsd: 0.25154905,
          cacheHitRatePercent: 90,
        },
      }),
    );
    await adapter.close();
  });

  it("restores resume Usage by summing Native history", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "first", metadata: { eventId: "grok-session-user-1" } },
      { type: "agent.text", text: "one", messageId: "agent-1" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-1",
        stopReason: "end_turn",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          cachedReadTokens: 80,
          cacheCreationTokens: 0,
          reasoningTokens: 4,
          costUsdTicks: 126890500,
        },
      },
      { type: "user.text", text: "second", metadata: { eventId: "grok-session-user-2" } },
      { type: "agent.text", text: "two", messageId: "agent-2" },
      {
        type: "turn.completed",
        nativeTurnKey: "grok-prompt-2",
        stopReason: "end_turn",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          totalTokens: 55,
          cachedReadTokens: 45,
          cacheCreationTokens: 2,
          reasoningTokens: 1,
          costUsdTicks: 2388600000,
        },
      },
    ];
    transport.signals = {
      contextTokensUsed: 52322,
      contextWindowTokens: 500000,
      turnCount: 2,
    };
    const { adapter, session } = await openedSession(transport, "resume");
    expect(session.initialUsage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      totalTokens: 165,
      cachedInputTokens: 125,
      cacheWriteInputTokens: 2,
      reasoningOutputTokens: 5,
      totalCostUsd: 0.25154905,
      cacheHitRatePercent: 90,
      contextUsedTokens: 52322,
      contextWindowTokens: 500000,
    });
    await adapter.close();
  });

  it("cancels the active ACP Prompt and maps replay into a resumable Snapshot", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "before", messageId: "user-1" },
      { type: "agent.thought", text: "thought", messageId: "agent-1" },
      { type: "agent.text", text: "answer", messageId: "agent-1" },
    ];
    const { adapter, session } = await openedSession(transport, "resume");
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "before" }],
            items: [
              { item: { type: "reasoning", text: "thought" } },
              { item: { type: "agentMessage", text: "answer" } },
            ],
          },
        ],
      },
    });

    const turnId = hostTurnIdSchema.parse("turn-cancel");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "stop" }] });
    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.cancel).toHaveBeenCalledOnce();
    transport.finish({ stopReason: "cancelled" });
    await adapter.close();
  });

  it("rejects unsupported history mutation and invalid create Model selection", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        model: harnessModelRefSchema.parse({ id: "missing" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        cwd: "/synthetic",
        sourceRef: { harnessId: adapter.harnessId, nativeSessionId: "missing", formatVersion: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    await adapter.close();
  });

  it("caches Grok account credits on the Adapter without changing Session Usage", async () => {
    const snapshot = {
      usedPercent: 33,
      resetsAt: "2026-08-20T03:32:07.498525+00:00",
      periodType: "weekly" as const,
      fetchedAt: "2026-08-15T00:00:00.000Z",
    };
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => snapshot,
      },
    );
    expect(adapter.credits()).toBeNull();
    await expect(adapter.inspect({ cwd: "/synthetic" })).resolves.toMatchObject({
      status: "ready",
      capabilities: {
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
      },
    });
    await expect(adapter.refreshCredits()).resolves.toEqual(snapshot);
    expect(adapter.credits()).toEqual(snapshot);
    await adapter.close();
  });

  it("refreshes Grok account credits after a Turn settles", async () => {
    let fetches = 0;
    let uuid = 0;
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: () => `grok-id-${++uuid}`,
        createTransport: () => transport,
        fetchCredits: async () => {
          fetches += 1;
          return {
            usedPercent: Math.min(fetches * 10, 100),
            periodType: "weekly",
            fetchedAt: "2026-08-15T00:00:00.000Z",
          };
        },
      },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    await adapter.refreshCredits();
    const fetchesAfterOpen = fetches;
    expect(fetchesAfterOpen).toBeGreaterThan(0);

    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-credits-refresh");
    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.finish(
      { stopReason: "end_turn" },
      {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costUsdTicks: 1000,
      },
    );
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    expect(fetches).toBeGreaterThan(fetchesAfterOpen);
    expect(adapter.credits()?.usedPercent).toBe(Math.min(fetches * 10, 100));
    await adapter.close();
  });

  it("forks an exact Native prefix at the requested Prompt Index", async () => {
    const transport = new FakeGrokTransport();
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
      { type: "agent.text", text: "answer-2" },
      { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
      { type: "user.text", text: "third", metadata: { eventId: "user-3" } },
      { type: "agent.text", text: "answer-3" },
      { type: "turn.completed", nativeTurnKey: "prompt-3", stopReason: "end_turn" },
    ];
    transport.histories.set("source-session", sourceHistory);
    transport.forkImpl = async () => {
      const prefix = sourceHistory.slice(0, 3);
      transport.histories.set("child-session", prefix);
      return { sessionId: "child-session" };
    };
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: adapter.harnessId,
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: adapter.harnessId,
      nativeSessionId: "source-session",
      checkpointId: "0",
      formatVersion: 1,
    });
    const opened = await adapter.open({
      kind: "fork",
      cwd: "/synthetic",
      sourceRef,
      checkpoint,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "child-session" },
    });
    expect(opened.value.capabilities.history).toEqual({
      fork: true,
      forkAcrossCwd: true,
      rollbackLastTurn: true,
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeSessionId: "child-session", nativeTurnKey: "prompt-1" },
            checkpoint: { nativeSessionId: "child-session", checkpointId: "0" },
            input: [{ text: "first" }],
          },
        ],
      },
    });
    expect(transport.forkCalls).toEqual([
      {
        kind: "fork",
        sourceSessionId: "source-session",
        sourceCwd: resolve("/synthetic"),
        targetPromptIndex: 0,
        sessionKind: "fork",
      },
    ]);
    expect(transport.deleteSession).not.toHaveBeenCalled();
    await opened.value.close();
  });

  it("preserves the active source Permission Mode when forking", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const alwaysApprove = harnessPermissionModeIdSchema.parse("always-approve");
    const source = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      permissionModeId: alwaysApprove,
    });
    if (!source.ok) throw new Error(source.error.message);
    const sourceRef = source.value.initialState.nativeRef;
    if (!sourceRef) throw new Error("Created Session is missing its Native reference");
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ];
    transport.histories.set(sourceRef.nativeSessionId, sourceHistory);
    transport.forkImpl = async () => {
      transport.histories.set("child-session", sourceHistory);
      return { sessionId: "child-session" };
    };
    transport.setPermissionMode.mockClear();

    const forked = await adapter.open({
      kind: "fork",
      cwd: "/synthetic",
      sourceRef,
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: sourceRef.nativeSessionId,
        checkpointId: "0",
        formatVersion: 1,
      }),
    });
    if (!forked.ok) throw new Error(forked.error.message);

    expect(transport.setPermissionMode).toHaveBeenCalledWith(alwaysApprove);
    expect(forked.value.initialState.effectivePermissionModeId).toBe(alwaysApprove);
    await source.value.close();
    await forked.value.close();
  });

  it("forks into a caller-selected cwd as a Worktree Session", async () => {
    const transport = new FakeGrokTransport();
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ];
    transport.histories.set("source-session", sourceHistory);
    transport.sessionLocations.set("source-session", { cwd: "/source-project" });
    transport.forkImpl = async () => {
      transport.histories.set("child-session", sourceHistory);
      return { sessionId: "child-session" };
    };
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const opened = await adapter.open({
      kind: "fork",
      cwd: "/worktree/fork-1",
      sourceRef: nativeSessionRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        checkpointId: "0",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(transport.forkCalls).toEqual([
      {
        kind: "fork",
        sourceSessionId: "source-session",
        sourceCwd: resolve("/source-project"),
        targetPromptIndex: 0,
        sessionKind: "worktree",
        sourceWorkspaceDir: resolve("/source-project"),
      },
    ]);
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [{ input: [{ text: "first" }] }],
      },
    });
    await opened.value.close();
  });

  it("keeps the original workspace when the source is already a Worktree", async () => {
    const transport = new FakeGrokTransport();
    transport.histories.set("source-session", [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ]);
    transport.sessionLocations.set("source-session", {
      cwd: "/worktree/first",
      sourceWorkspaceDir: "/source-project",
    });
    transport.forkImpl = async () => {
      transport.histories.set("child-session", transport.histories.get("source-session") ?? []);
      return { sessionId: "child-session" };
    };
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const opened = await adapter.open({
      kind: "fork",
      cwd: "/worktree/second",
      sourceRef: nativeSessionRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        checkpointId: "0",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(transport.forkCalls[0]).toMatchObject({
      sourceCwd: resolve("/worktree/first"),
      sessionKind: "worktree",
      sourceWorkspaceDir: "/source-project",
    });
    await opened.value.close();
  });

  it("maps Host Turn past a synthetic Prompt to the Native Prompt Index", async () => {
    const transport = new FakeGrokTransport();
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      {
        type: "user.text",
        text: "<system-reminder>\nBackground task done.\n</system-reminder>",
        metadata: { eventId: "user-bg" },
      },
      { type: "turn.completed", nativeTurnKey: "task-completed-1", stopReason: "end_turn" },
      { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
      { type: "agent.text", text: "answer-2" },
      { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
    ];
    transport.histories.set("source-session", sourceHistory);
    transport.forkImpl = async () => {
      transport.histories.set("child-session", sourceHistory);
      return { sessionId: "child-session" };
    };
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const opened = await adapter.open({
      kind: "fork",
      cwd: "/synthetic",
      sourceRef: nativeSessionRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        checkpointId: "2",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(transport.forkCalls[0]?.targetPromptIndex).toBe(2);
    await opened.value.close();
  });

  it("rejects a stale Checkpoint before calling Grok Fork", async () => {
    const transport = new FakeGrokTransport();
    transport.histories.set("source-session", [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ]);
    transport.forkImpl = async () => ({ sessionId: "child-session" });
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    await expect(
      adapter.open({
        kind: "fork",
        cwd: "/synthetic",
        sourceRef: nativeSessionRefSchema.parse({
          harnessId: adapter.harnessId,
          nativeSessionId: "source-session",
          formatVersion: 1,
        }),
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId: adapter.harnessId,
          nativeSessionId: "source-session",
          checkpointId: "9",
          formatVersion: 1,
        }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(transport.forkCalls).toEqual([]);
    await adapter.close();
  });

  it("maps Method Not Found to unsupported Fork and deletes an inexact child", async () => {
    const transport = new FakeGrokTransport();
    transport.histories.set("source-session", [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ]);
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: adapter.harnessId,
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: adapter.harnessId,
      nativeSessionId: "source-session",
      checkpointId: "0",
      formatVersion: 1,
    });
    transport.methodNotFound = true;
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    transport.methodNotFound = false;
    transport.forkImpl = async () => {
      transport.histories.set("child-session", [
        { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
        { type: "agent.text", text: "answer-1" },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
        { type: "user.text", text: "extra", metadata: { eventId: "user-x" } },
        { type: "agent.text", text: "too-much" },
        { type: "turn.completed", nativeTurnKey: "prompt-x", stopReason: "end_turn" },
      ]);
      return { sessionId: "child-session" };
    };
    await expect(
      adapter.open({ kind: "fork", cwd: "/synthetic", sourceRef, checkpoint }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(transport.deleteSession).toHaveBeenCalledWith("child-session");
    await adapter.close();
  });

  it("rewinds the last Native Turn in place", async () => {
    const transport = new FakeGrokTransport();
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
      { type: "agent.text", text: "answer-2" },
      { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
    ];
    transport.histories.set("source-session", sourceHistory);
    transport.rewindImpl = async (input) => {
      transport.histories.set("source-session", [
        ...sourceHistory,
        { type: "rewind.marker", targetPromptIndex: input.targetPromptIndex },
      ]);
    };
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const opened = await adapter.open({
      kind: "rollbackLastTurn",
      cwd: "/synthetic",
      sourceRef: nativeSessionRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "source-session" },
    });
    expect(opened.value.capabilities.history).toEqual({
      fork: true,
      forkAcrossCwd: true,
      rollbackLastTurn: true,
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            nativeTurnRef: { nativeSessionId: "source-session", nativeTurnKey: "prompt-1" },
            checkpoint: { nativeSessionId: "source-session", checkpointId: "0" },
            input: [{ text: "first" }],
          },
        ],
      },
    });
    expect(transport.rewindCalls).toEqual([
      { kind: "rewind", sessionId: "source-session", targetPromptIndex: 1 },
    ]);
    await opened.value.close();
  });

  it("restores the source Session Model and Thinking after Rewind", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const created = await adapter.open({
      kind: "create",
      cwd: "/synthetic",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
    });
    if (!created.ok) throw new Error(created.error.message);
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
      { type: "agent.text", text: "answer-2" },
      { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
    ];
    const sourceRef = created.value.initialState.nativeRef;
    if (!sourceRef) throw new Error("Created Session is missing its Native reference");
    transport.histories.set(sourceRef.nativeSessionId, sourceHistory);
    transport.rewindImpl = async (input) => {
      transport.histories.set(input.sessionId, [
        ...sourceHistory,
        { type: "rewind.marker", targetPromptIndex: input.targetPromptIndex },
      ]);
    };
    transport.setModel.mockClear();
    const opened = await adapter.open({
      kind: "rollbackLastTurn",
      cwd: "/synthetic",
      sourceRef,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(transport.setModel).toHaveBeenCalledWith("grok-4.6", "low");
    expect(opened.value.initialState).toMatchObject({
      effectiveModel: { id: "grok-4.6" },
      effectiveThinkingOptionId: "low",
    });
    await created.value.close();
    await opened.value.close();
  });

  it("rewinds the only Native Turn to empty history", async () => {
    const transport = new FakeGrokTransport();
    transport.histories.set("source-session", [
      { type: "user.text", text: "only", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
    ]);
    transport.rewindImpl = async (input) => {
      transport.histories.set("source-session", [
        { type: "user.text", text: "only", metadata: { eventId: "user-1" } },
        { type: "agent.text", text: "answer" },
        { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
        { type: "rewind.marker", targetPromptIndex: input.targetPromptIndex },
      ]);
    };
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const opened = await adapter.open({
      kind: "rollbackLastTurn",
      cwd: "/synthetic",
      sourceRef: nativeSessionRefSchema.parse({
        harnessId: adapter.harnessId,
        nativeSessionId: "source-session",
        formatVersion: 1,
      }),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [] },
    });
    expect(transport.rewindCalls).toEqual([
      { kind: "rewind", sessionId: "source-session", targetPromptIndex: 0 },
    ]);
    await opened.value.close();
  });

  it("exposes Grok compact as a command backed by native compact and a temporary Turn", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("manual-grok-compact");

    if (!session.commands) throw new Error("Grok Session did not expose commands");
    await expect(session.commands.list()).resolves.toMatchObject({
      ok: true,
      value: { commands: [{ id: "grok.compact", invocation: "/compact", argumentMode: "text" }] },
    });
    await expect(
      session.commands.execute({
        turnId,
        commandId: "grok.compact",
        arguments: { text: "Keep implementation details" },
      }),
    ).resolves.toEqual({ ok: true, value: { turnId } });

    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    transport.compactEvent({
      type: "compaction.started",
      tokensUsed: 401965,
      contextWindowTokens: 500000,
    });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Manual Grok compact did not start a Context Compaction Item");
    }
    transport.compactEvent({
      type: "compaction.completed",
      outcome: "succeeded",
      tokensBefore: 401965,
      tokensAfter: 10820,
      contextWindowTokens: 500000,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      turnId,
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      observedForTurnId: turnId,
      usage: { contextUsedTokens: 10820, contextWindowTokens: 500000 },
    });
    transport.finishCompact();
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(transport.compactCalls).toEqual(["Keep implementation details"]);
    expect(transport.replay).toEqual([]);
    await adapter.close();
  });

  it("uses the native terminal compact outcome over the RPC result", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("manual-grok-compact-conflict");
    if (!session.commands) throw new Error("Grok Session did not expose commands");

    await session.commands.execute({ turnId, commandId: "grok.compact" });
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    transport.compactEvent({ type: "compaction.started" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    transport.compactEvent({
      type: "compaction.completed",
      outcome: "failed",
      errorMessage: "native compact failed",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: { status: "failed", error: { message: "native compact failed" } },
      },
    });
    transport.finishCompact({ outcome: "succeeded" });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      turnId,
      outcome: { status: "failed", error: { message: "native compact failed" } },
    });
    await adapter.close();
  });
  it("validates Grok compact arguments and rejects it while busy", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const commands = session.commands;
    if (!commands) throw new Error("Grok Session did not expose commands");
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("invalid-compact"),
        commandId: "grok.compact",
        arguments: { text: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-command"),
        commandId: "grok.unknown",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("busy-compact");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "busy" }] });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("rejected-compact"),
        commandId: "grok.compact",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    transport.finish();
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await adapter.close();
  });

  it("cancels a running Grok compact temporary Turn", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("cancel-grok-compact");
    if (!session.commands) throw new Error("Grok Session did not expose commands");

    await session.commands.execute({ turnId, commandId: "grok.compact" });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    expect(await session.execute({ type: "turn.cancel", turnId })).toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.cancel).toHaveBeenCalledOnce();
    transport.finishCompact({ outcome: "cancelled" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
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
    await adapter.close();
  });
  it("projects native auto-compaction before continuing the Assistant reply", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-auto-compact");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "continue" }],
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.event({
      type: "agent.thought",
      text: "before compact",
      messageId: "thought-1",
    });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");

    transport.event({
      type: "compaction.started",
      tokensUsed: 401965,
      contextWindowTokens: 500000,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: { item: { type: "reasoning" }, outcome: { status: "succeeded" } },
    });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Grok auto-compact did not start a Context Compaction Item");
    }

    transport.event({
      type: "compaction.completed",
      outcome: "succeeded",
      tokensBefore: 401965,
      tokensAfter: 10820,
      contextWindowTokens: 500000,
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction", itemId: started.item.itemId },
        outcome: { status: "succeeded" },
      },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      observedForTurnId: turnId,
      usage: { contextUsedTokens: 10820, contextWindowTokens: 500000 },
    });

    transport.event({ type: "agent.text", text: "after compact", messageId: "agent-1" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    transport.finish();
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("turn.completed");

    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            items: [
              { item: { type: "reasoning" }, outcome: { status: "succeeded" } },
              { item: { type: "contextCompaction" }, outcome: { status: "succeeded" } },
              { item: { type: "agentMessage" }, outcome: { status: "succeeded" } },
            ],
          },
        ],
      },
    });
    await adapter.close();
  });

  it("completes a failed auto-compact Item without closing the Turn", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-auto-compact-failed");

    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "continue" }],
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    transport.event({ type: "compaction.started" });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started" || started.item.type !== "contextCompaction") {
      throw new Error("Grok auto-compact did not start a Context Compaction Item");
    }
    transport.event({
      type: "compaction.completed",
      outcome: "failed",
      errorMessage: "quota exceeded",
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "contextCompaction" },
        outcome: {
          status: "failed",
          error: { code: "nativeFailure", message: "quota exceeded" },
        },
      },
    });
    transport.event({ type: "agent.text", text: "still going", messageId: "agent-1" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    transport.finish();
    for (;;) {
      if ((await nextEvent(iterator)).type === "turn.completed") break;
    }
    await adapter.close();
  });

  it("rejects last-Turn Rewind when Grok ACP is missing or history is unchanged", async () => {
    const transport = new FakeGrokTransport();
    const sourceHistory: GrokTransportEvent[] = [
      { type: "user.text", text: "first", metadata: { eventId: "user-1" } },
      { type: "agent.text", text: "answer-1" },
      { type: "turn.completed", nativeTurnKey: "prompt-1", stopReason: "end_turn" },
      { type: "user.text", text: "second", metadata: { eventId: "user-2" } },
      { type: "agent.text", text: "answer-2" },
      { type: "turn.completed", nativeTurnKey: "prompt-2", stopReason: "end_turn" },
    ];
    transport.histories.set("source-session", sourceHistory);
    const adapter = new GrokAdapter(
      {},
      {
        randomUUID: vi.fn(() => "id"),
        createTransport: () => transport,
        fetchCredits: async () => null,
      },
    );
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: adapter.harnessId,
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    transport.methodNotFound = true;
    await expect(
      adapter.open({ kind: "rollbackLastTurn", cwd: "/synthetic", sourceRef }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    transport.methodNotFound = false;
    transport.rewindImpl = async () => undefined;
    await expect(
      adapter.open({ kind: "rollbackLastTurn", cwd: "/synthetic", sourceRef }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await adapter.close();
  });
});
