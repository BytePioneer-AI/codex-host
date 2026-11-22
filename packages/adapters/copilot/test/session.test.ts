import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotClient, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { hostTurnIdSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { createCopilotClient } from "../src/client.js";
import { CopilotHarnessSession } from "../src/session.js";
import { modelRef } from "../src/configuration.js";
import { CopilotAdapter } from "../src/adapter.js";
import { checkpoint } from "../src/refs.js";
vi.mock("../src/client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCopilotClient: vi.fn(),
}));

let emit: (event: SessionEvent) => void;
let history: SessionEvent[];
let currentModel: string | undefined;
let client: ReturnType<typeof fixtureClient>;
const turnId = hostTurnIdSchema.parse("test-turn");
const event = (type: string, data: object): SessionEvent =>
  ({
    type,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
    data,
  }) as SessionEvent;

function fixtureClient() {
  const native = {
    sessionId: "",
    send: vi.fn(async () => "message-1"),
    abort: vi.fn(async () => {
      emit(event("abort", { reason: "cancelled" }));
      emit(event("session.idle", { aborted: true, mode: "interactive" }));
    }),
    setModel: vi.fn(async (model: string) => {
      currentModel = model;
    }),
    getEvents: vi.fn(async () => history),
    disconnect: vi.fn(async () => {}),
    rpc: {
      model: {
        getCurrent: vi.fn(async () => (currentModel ? { modelId: currentModel } : {})),
        list: vi.fn(async () => ({
          list: [{ id: "native-model", name: "Native", supportedReasoningEfforts: ["high"] }],
          providers: [{ kind: "copilot" }],
        })),
        setReasoningEffort: vi.fn(async ({ reasoningEffort }: { reasoningEffort: string }) => ({
          reasoningEffort,
        })),
      },
      mode: { get: vi.fn(async () => "interactive") },
      permissions: {
        getMode: vi.fn(async () => ({ mode: "manual" })),
        setMode: vi.fn(async ({ mode }: { mode: string }) => ({ success: true, mode })),
      },
      usage: { getMetrics: vi.fn(async () => ({})) },
      tasks: { list: vi.fn(async () => ({ tasks: [] as Array<{ status: string }> })) },
    },
  };
  return {
    native,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({})),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: "gh-cli" })),
    rpc: {
      models: {
        list: vi.fn(async () => ({
          models: [{ id: "native-model", name: "Native", supportedReasoningEfforts: ["high"] }],
        })),
      },
    },
    deleteSession: vi.fn(async () => {}),
    createSession: vi.fn(async (config: SessionConfig) => {
      native.sessionId = config.sessionId ?? "";
      emit = (value) => {
        history.push(value);
        config.onEvent?.(value);
      };
      return native;
    }),
  };
}

beforeEach(() => {
  vi.mocked(createCopilotClient).mockClear();
  history = [];
  currentModel = undefined;
  client = fixtureClient();
  vi.mocked(createCopilotClient).mockReturnValue(client as unknown as CopilotClient);
});

function open() {
  const session = new CopilotHarnessSession({ kind: "create", cwd: "/tmp" }, {});
  const outputs: HarnessOutput[] = [];
  const consume = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return { session, outputs, consume };
}

const terminal = (outputs: HarnessOutput[]) =>
  outputs.flatMap((output) =>
    output.kind === "event" && output.event.type === "turn.completed" ? [output.event] : [],
  );

describe("Copilot public Session lifecycle (synthetic races)", () => {
  it.each(["draft", "active"])(
    "rejects steering without taking input in a %s Session",
    async (phase) => {
      const { session, outputs, consume } = open();
      client.native.send.mockImplementation(async () => {
        emit(event("user.message", { messageId: "message-1", content: "original" }));
        return "message-1";
      });
      try {
        if (phase === "active") {
          expect(
            await session.execute({
              type: "turn.start",
              turnId,
              input: [{ type: "text", text: "original" }],
            }),
          ).toMatchObject({ ok: true });
        }
        expect(
          await session.execute({
            type: "turn.steer",
            turnId,
            input: [{ type: "text", text: "must not be sent" }],
          }),
        ).toMatchObject({ ok: false, error: { code: "unsupported", retryable: false } });
        expect(client.native.send).toHaveBeenCalledTimes(phase === "active" ? 1 : 0);
        expect(client.native.abort).not.toHaveBeenCalled();
        expect(terminal(outputs)).toHaveLength(0);
        if (phase === "draft") expect(createCopilotClient).not.toHaveBeenCalled();
        else {
          emit(event("session.idle", { mode: "interactive" }));
          await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(1));
          expect(terminal(outputs)[0]?.outcome.status).toBe("succeeded");
        }
      } finally {
        await session.close();
        await consume;
      }
    },
  );
  it("keeps a still-active background tool's completion after assistant.idle", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { messageId: "active-background", content: "request" }));
      return "active-background";
    });
    try {
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "background" }],
      });
      emit(
        event("tool.execution_start", {
          toolCallId: "active-background-tool",
          toolName: "bash",
          arguments: { command: "background job", mode: "async" },
        }),
      );
      emit(event("assistant.idle", {}));
      emit(
        event("tool.execution_complete", {
          toolCallId: "active-background-tool",
          success: true,
          result: { content: "ACTIVE_BACKGROUND_RESULT" },
        }),
      );
      await vi.waitFor(() =>
        expect(outputs.some((o) => o.kind === "event" && o.event.type === "item.completed")).toBe(
          true,
        ),
      );
      expect(terminal(outputs)).toEqual([]);
      const completed = outputs.flatMap((o) =>
        o.kind === "event" && o.event.type === "item.completed" ? [o.event] : [],
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        turnId,
        snapshot: {
          item: {
            itemId: "active-background-tool",
            type: "toolExecution",
            output: { content: [{ type: "text", text: "ACTIVE_BACKGROUND_RESULT" }] },
          },
          outcome: { status: "succeeded" },
        },
      });
      emit(event("session.idle", { mode: "interactive" }));
      await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(1));
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns[0]?.items).toEqual(
        completed.map((e) => e.snapshot),
      );
    } finally {
      await session.close();
      await consume;
    }
  });
  it("retains background activity and reads a late background result under its original history Turn", async () => {
    const { session, outputs, consume } = open();
    let round = 0;
    client.native.send.mockImplementation(async () => {
      const messageId = `background-root-${++round}`;
      emit(event("user.message", { messageId, content: "request" }));
      return messageId;
    });
    try {
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "first" }],
      });
      emit(
        event("tool.execution_start", {
          toolCallId: "background-tool",
          toolName: "bash",
          arguments: { command: "background job", mode: "async" },
        }),
      );
      client.native.rpc.tasks.list.mockResolvedValue({ tasks: [{ status: "running" }] });
      emit(event("session.background_tasks_changed", {}));
      emit(event("assistant.idle", {}));
      expect(session.hasBackgroundWork()).toBe(true);
      expect(terminal(outputs)).toHaveLength(0);
      emit(event("session.idle", { mode: "interactive" }));
      await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(1));
      expect(session.hasBackgroundWork()).toBe(true);
      const next = hostTurnIdSchema.parse("foreground-next");
      await session.execute({
        type: "turn.start",
        turnId: next,
        input: [{ type: "text", text: "next" }],
      });
      emit(
        event("tool.execution_complete", {
          toolCallId: "background-tool",
          success: true,
          result: { content: "BACKGROUND_RESULT" },
        }),
      );
      client.native.rpc.tasks.list.mockResolvedValue({ tasks: [{ status: "completed" }] });
      emit(event("session.background_tasks_changed", {}));
      emit(event("session.idle", { mode: "interactive" }));
      await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(2));
      await vi.waitFor(() => expect(session.hasBackgroundWork()).toBe(false));
      expect(
        outputs.some(
          (o) => o.kind === "event" && o.event.type === "item.started" && o.event.turnId === next,
        ),
      ).toBe(false);
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      expect(snapshot.value.turns[0]?.items[0]).toMatchObject({
        item: {
          itemId: "background-tool",
          type: "toolExecution",
          output: { content: [{ type: "text", text: "BACKGROUND_RESULT" }] },
        },
        outcome: { status: "succeeded" },
      });
      expect(snapshot.value.turns[1]?.items).toEqual([]);
    } finally {
      await session.close();
      await consume;
    }
  });

  it("keeps the Turn pending after abort RPC acceptance and faults only its own unconfirmed failure", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { messageId: "cancel-pending", content: "request" }));
      return "cancel-pending";
    });
    client.native.abort.mockResolvedValue(undefined);
    try {
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "first" }],
      });
      expect((await session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
      expect(terminal(outputs)).toHaveLength(0);
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("too-early"),
          input: [{ type: "text", text: "next" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      emit(event("session.idle", { aborted: true, mode: "interactive" }));
      await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(1));
      client.native.send.mockImplementation(async () => {
        emit(event("user.message", { messageId: "next-cancel", content: "request" }));
        return "next-cancel";
      });
      const next = hostTurnIdSchema.parse("failed-cancel");
      await session.execute({
        type: "turn.start",
        turnId: next,
        input: [{ type: "text", text: "next" }],
      });
      client.native.abort.mockRejectedValue(new Error("current abort failed"));
      expect((await session.execute({ type: "turn.cancel", turnId: next })).ok).toBe(false);
      await consume;
      expect(terminal(outputs).map((e) => e.outcome.status)).toEqual(["cancelled", "failed"]);
      expect(
        outputs.filter((o) => o.kind === "event" && o.event.type === "session.faulted"),
      ).toHaveLength(1);
    } finally {
      await session.close();
      await consume;
    }
  });
  it.each(
    ["resolve", "reject"].flatMap((settlement) =>
      ["host", "host-reused-id", "autonomous"].flatMap((origin) =>
        ["question", "approval"].map((interaction) => ({ settlement, origin, interaction })),
      ),
    ),
  )(
    "isolates a late abort $settlement from the next $origin Turn's $interaction",
    async ({ settlement, origin, interaction }) => {
      const { session, outputs, consume } = open();
      const abort = Promise.withResolvers<undefined>();
      let round = 0;
      client.native.send.mockImplementation(async () => {
        const messageId = `root-${++round}`;
        emit(event("user.message", { messageId, content: "request" }));
        return messageId;
      });
      client.native.abort.mockImplementation(() => {
        emit(event("abort", { reason: "cancelled" }));
        emit(event("session.idle", { aborted: true, mode: "interactive" }));
        return abort.promise;
      });
      try {
        expect(
          (
            await session.execute({
              type: "turn.start",
              turnId,
              input: [{ type: "text", text: "first" }],
            })
          ).ok,
        ).toBe(true);
        const config = client.createSession.mock.calls[0]?.[0];
        if (!config?.onUserInputRequest || !config.onPermissionRequest)
          throw new Error("Missing native callbacks");
        const context = { sessionId: client.native.sessionId };
        const oldAnswer = Promise.resolve(
          config.onUserInputRequest({ question: "Old question" }, context),
        ).catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(outputs.filter((o) => o.kind === "interaction")).toHaveLength(1),
        );
        const cancellation = session.execute({ type: "turn.cancel", turnId });
        await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(1));
        expect(terminal(outputs)[0]?.outcome.status).toBe("cancelled");
        expect(await oldAnswer).toBeInstanceOf(Error);
        if (origin !== "autonomous") {
          expect(
            (
              await session.execute({
                type: "turn.start",
                turnId: origin === "host-reused-id" ? turnId : hostTurnIdSchema.parse("next-turn"),
                input: [{ type: "text", text: "next" }],
              })
            ).ok,
          ).toBe(true);
        } else
          emit(
            event("user.message", {
              messageId: "autonomous-root",
              content: "next",
              source: "scheduler",
            }),
          );
        const answer = Promise.resolve(
          interaction === "question"
            ? config.onUserInputRequest({ question: "New question" }, context)
            : config.onPermissionRequest(
                { kind: "shell", fullCommandText: "echo approved" } as Parameters<
                  NonNullable<SessionConfig["onPermissionRequest"]>
                >[0],
                context,
              ),
        ).catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(outputs.filter((o) => o.kind === "interaction")).toHaveLength(2),
        );
        const pending = outputs.filter((o) => o.kind === "interaction").at(-1);
        if (pending?.kind !== "interaction") throw new Error("Missing new interaction");
        if (settlement === "resolve") abort.resolve(undefined);
        else abort.reject(new Error("old abort RPC failed after confirmed idle"));
        expect((await cancellation).ok).toBe(settlement === "resolve");
        expect(outputs.some((o) => o.kind === "event" && o.event.type === "session.faulted")).toBe(
          false,
        );
        expect(
          await session.execute({
            type: "interaction.respond",
            interactionId: pending.interaction.interactionId,
            response:
              interaction === "question"
                ? { type: "question", answers: { answer: ["new answer"] } }
                : { type: "approval", actionId: "allow" },
          }),
        ).toMatchObject({ ok: true });
        expect(await answer).toEqual(
          interaction === "question"
            ? { answer: "new answer", wasFreeform: true }
            : { kind: "approved" },
        );
        emit(event("session.idle", { mode: "interactive" }));
        await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(2));
        expect(terminal(outputs).map((e) => e.outcome.status)).toEqual(["cancelled", "succeeded"]);
        const closed = outputs.flatMap((o) =>
          o.kind === "event" && o.event.type === "interaction.closed" ? [o.event] : [],
        );
        expect(closed).toHaveLength(2);
        expect(new Set(closed.map((e) => e.interactionId)).size).toBe(2);
      } finally {
        abort.resolve(undefined);
        await session.close();
        await consume;
      }
    },
  );

  it("does not attribute a retired tool's late file changes to a new Turn or its history", async () => {
    const { session, outputs, consume } = open();
    let round = 0;
    client.native.send.mockImplementation(async () => {
      const messageId = `file-root-${++round}`;
      emit(event("user.message", { messageId, content: "request" }));
      return messageId;
    });
    const start = (toolCallId: string) =>
      event("tool.execution_start", { toolCallId, toolName: "apply_patch", arguments: {} });
    const complete = (toolCallId: string) =>
      event("tool.execution_complete", {
        toolCallId,
        success: true,
        fileEdits: [{ path: "/workspace/probe.txt", kind: "create" }],
        result: {
          detailedContent:
            "diff --git a/workspace/probe.txt b/workspace/probe.txt\n--- /dev/null\n+++ b/workspace/probe.txt\n@@ -0,0 +1 @@\n+probe\n",
        },
      });
    const next = hostTurnIdSchema.parse("new-file-turn");
    try {
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "first" }],
      });
      emit(start("old-tool"));
      await session.execute({ type: "turn.cancel", turnId });
      await session.execute({
        type: "turn.start",
        turnId: next,
        input: [{ type: "text", text: "second" }],
      });
      emit(
        event("tool.execution_partial_result", { toolCallId: "old-tool", partialOutput: "late" }),
      );
      emit(event("tool.execution_progress", { toolCallId: "old-tool", progressMessage: "late" }));
      emit(event("tool.shell_output", { toolCallId: "old-tool", sequence: 0, text: "late" }));
      emit(complete("old-tool"));
      emit(start("old-tool"));
      emit(complete("old-tool"));
      emit(start("new-tool"));
      emit(complete("new-tool"));
      emit(event("session.idle", { mode: "interactive" }));
      await vi.waitFor(() => expect(terminal(outputs)).toHaveLength(2));
      const starts = outputs.flatMap((o) =>
        o.kind === "event" && o.event.type === "item.started" && o.event.turnId === next
          ? [o.event.item]
          : [],
      );
      expect(starts.map((item) => item.itemId)).toEqual(["new-tool", "files-new-tool"]);
      const snapshot = await session.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const items = snapshot.value.turns[1]?.items.map(({ item }) => item) ?? [];
      expect(items.map((item) => item.itemId)).toEqual(starts.map((item) => item.itemId));
      for (const item of items)
        if (item.type === "fileChange")
          expect(
            item.sourceItemIds?.every((id) => items.some((source) => source.itemId === id)),
          ).toBe(true);
      expect(snapshot.value.turns[0]?.outcome.status).toBe("cancelled");
      expect(
        snapshot.value.turns[0]?.items.filter(({ item }) => item.type === "fileChange"),
      ).toHaveLength(1);
    } finally {
      await session.close();
      await consume;
    }
  });
  it("rejects an unadvertised initial Model before native session creation", async () => {
    const session = new CopilotHarnessSession(
      { kind: "create", cwd: "/tmp", model: modelRef("unavailable-model") },
      {},
    );
    try {
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "must not execute" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(client.createSession).not.toHaveBeenCalled();
      expect(client.native.send).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
  it("rejects an ignored initial Thinking setting before submitting input and removes the draft", async () => {
    const session = new CopilotHarnessSession(
      {
        kind: "create",
        cwd: "/tmp",
        model: modelRef("native-model"),
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      },
      {},
    );
    try {
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "must not execute" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
      expect(client.native.rpc.model.setReasoningEffort).toHaveBeenCalledWith({
        reasoningEffort: "high",
      });
      expect(client.native.send).not.toHaveBeenCalled();
      expect(client.deleteSession).toHaveBeenCalledWith(client.native.sessionId);
    } finally {
      await session.close();
    }
  });
  it("retains the native lease during compaction outside a foreground Turn", async () => {
    const { session, consume } = open();
    await session.execute({ type: "model.select", model: modelRef("native-model") });
    emit(event("session.compaction_start", {}));
    expect(session.hasBackgroundWork()).toBe(true);
    expect(await session.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    emit(event("session.compaction_complete", { success: true }));
    expect(session.hasBackgroundWork()).toBe(false);
    await session.close();
    await consume;
  });
  it("keeps a hidden queued injection inside the originating logical Turn", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { messageId: "primary", content: "visible", delivery: "idle" }));
      emit(
        event("user.message", {
          messageId: "injected",
          content: "hidden instructions",
          source: "skill-example",
          delivery: "queued",
        }),
      );
      emit(
        event("assistant.message", {
          messageId: "answer",
          originatingMessageId: "injected",
          content: "visible answer",
        }),
      );
      emit(event("session.idle", { mode: "interactive" }));
      return "primary";
    });
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "visible" }],
    });
    const snapshot = await session.readSnapshot();
    expect(snapshot.ok && snapshot.value.turns.length).toBe(1);
    await session.close();
    await consume;
    expect(terminal(outputs)[0]?.nativeTurnRef?.nativeTurnKey).toBe("primary");
    expect(JSON.stringify(outputs)).toContain("visible answer");
    expect(JSON.stringify(outputs)).not.toContain("hidden instructions");
    expect(JSON.stringify(snapshot)).not.toContain("hidden instructions");
  });
  it("refuses Fork of an active source before starting another native connection", async () => {
    const adapter = new CopilotAdapter({ CODEXHOST_COPILOT_COMMAND: process.execPath });
    try {
      const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
      if (!opened.ok || !opened.value.nativeWriterRef) throw new Error("Missing source");
      const reading = (async () => {
        for await (const output of opened.value.outputs) void output;
      })();
      client.native.send.mockImplementation(async () => {
        emit(event("user.message", { messageId: "source-message", content: "source" }));
        return "source-message";
      });
      await opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "source" }],
      });
      const sourceRef = opened.value.nativeWriterRef;
      expect(
        await adapter.open({
          kind: "fork",
          sourceRef,
          checkpoint: checkpoint(sourceRef.nativeSessionId, "source-message"),
          cwd: process.cwd(),
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      expect(createCopilotClient).toHaveBeenCalledTimes(1);
      await adapter.close();
      await reading;
    } finally {
      await adapter.close();
    }
  });
  it("observes a stable autonomous root message without treating child events as roots", async () => {
    const { session, outputs, consume } = open();
    await session.execute({ type: "model.select", model: modelRef("native-model") });
    emit({
      ...event("user.message", { messageId: "child-message", content: "child" }),
      agentId: "child",
    } as SessionEvent);
    emit(
      event("user.message", {
        messageId: "autonomous-message",
        content: "native continuation",
        source: "scheduler",
      }),
    );
    emit(
      event("assistant.message", {
        messageId: "autonomous-answer",
        originatingMessageId: "autonomous-message",
        content: "done",
      }),
    );
    emit(event("session.idle", { mode: "interactive" }));
    await session.close();
    await consume;
    expect(
      outputs.filter(
        (output) => output.kind === "event" && output.event.type === "turn.autonomous.started",
      ),
    ).toHaveLength(1);
    expect(terminal(outputs)[0]?.nativeTurnRef?.nativeTurnKey).toBe("autonomous-message");
  });
  it("discards an untouched prewarm without starting a CLI", async () => {
    const { session, consume } = open();
    await session.close();
    await consume;
    expect(createCopilotClient).not.toHaveBeenCalled();
  });
  it("confirms draft configuration and deletes only the unused draft on close", async () => {
    const { session, outputs, consume } = open();
    expect(
      await session.execute({ type: "model.select", model: modelRef("native-model") }),
    ).toEqual({ ok: true, value: { completed: true } });
    await session.close();
    await consume;
    expect(client.deleteSession).toHaveBeenCalledWith(client.native.sessionId);
    expect(
      outputs.some(
        (o) =>
          o.kind === "event" &&
          o.event.type === "session.state.changed" &&
          o.event.state.effectiveModel?.id === modelRef("native-model").id &&
          !o.event.state.nativeRef,
      ),
    ).toBe(true);
  });
  it("buffers early events, keeps one Turn, and preserves committed history on close", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { content: "hello", messageId: "message-1" }));
      emit(event("assistant.message_delta", { messageId: "answer-1", deltaContent: "hello" }));
      emit(
        event("assistant.message", {
          messageId: "answer-1",
          originatingMessageId: "message-1",
          content: "hello",
        }),
      );
      emit(event("session.idle", { mode: "interactive" }));
      return "message-1";
    });
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "hello" }],
        })
      ).ok,
    ).toBe(true);
    expect(client.createSession.mock.calls[0]?.[0]).not.toHaveProperty("model");
    expect(client.createSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
    await session.close();
    await consume;
    expect(terminal(outputs)).toHaveLength(1);
    expect(terminal(outputs)[0]?.outcome.status).toBe("succeeded");
    expect(terminal(outputs)[0]?.nativeTurnRef?.nativeTurnKey).toBe("message-1");
    expect(client.deleteSession).not.toHaveBeenCalled();
  });
  it("fails identity mismatch before publishing success", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { content: "hello", messageId: "wrong" }));
      emit(event("session.idle", { mode: "interactive" }));
      return "message-1";
    });
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] });
    await consume;
    await session.close();
    expect(terminal(outputs)).toEqual([]);
    expect(outputs.some((o) => o.kind === "event" && o.event.type === "turn.started")).toBe(false);
  });
  it("rejects busy input and permits another Turn only after native cancellation", async () => {
    const { session, outputs, consume } = open();
    let message = 0;
    client.native.send.mockImplementation(async () => {
      const messageId = `message-${++message}`;
      emit(event("user.message", { content: "hello", messageId }));
      return messageId;
    });
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] });
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("busy"),
        input: [{ type: "text", text: "busy" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect((await session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("next"),
          input: [{ type: "text", text: "next" }],
        })
      ).ok,
    ).toBe(true);
    await session.close();
    await consume;
    expect(terminal(outputs).filter((e) => e.turnId === turnId)).toHaveLength(1);
    expect(terminal(outputs)[0]?.outcome.status).toBe("cancelled");
  });
  it("does not mark a failed configuration request effective", async () => {
    const { session, outputs, consume } = open();
    client.native.setModel.mockImplementation(async () => {});
    expect(
      (await session.execute({ type: "model.select", model: modelRef("not-confirmed") })).ok,
    ).toBe(false);
    await session.close();
    await consume;
    expect(
      outputs.some(
        (o) =>
          o.kind === "event" &&
          o.event.type === "session.state.changed" &&
          o.event.state.effectiveModel,
      ),
    ).toBe(false);
  });

  it("does not report a configuration completed after the Session closed", async () => {
    const { session, outputs, consume } = open();
    const pending = Promise.withResolvers<{ modelId: string }>();
    client.native.rpc.model.getCurrent
      .mockResolvedValueOnce({})
      .mockReturnValueOnce(pending.promise);
    const changing = session.execute({ type: "model.select", model: modelRef("native-model") });
    await vi.waitFor(() => expect(client.native.rpc.model.getCurrent).toHaveBeenCalledTimes(2));
    await session.close();
    await consume;
    pending.resolve({ modelId: "native-model" });
    expect(await changing).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(
      outputs.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "session.state.changed" &&
          output.event.state.effectiveModel,
      ),
    ).toBe(false);
  });

  it("retries failed draft cleanup and ends the output stream on the failed attempt", async () => {
    const { session, consume } = open();
    await session.execute({ type: "model.select", model: modelRef("native-model") });
    client.deleteSession.mockRejectedValueOnce(new Error("temporary deletion failure"));
    await expect(session.close()).rejects.toThrow(/retried/);
    await consume;
    expect(client.forceStop).toHaveBeenCalled();
    await session.close();
    expect(client.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("releases a waiting question on close without sending an answer", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { content: "hello", messageId: "question-message" }));
      return "question-message";
    });
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] });
    const handler = client.createSession.mock.calls[0]?.[0].onUserInputRequest;
    if (!handler) throw new Error("Missing native input callback");
    const waiting = Promise.resolve(
      handler({ question: "Choose" }, { sessionId: client.native.sessionId }),
    ).catch((error) => error);
    await Promise.resolve();
    await session.close();
    await consume;
    expect(await waiting).toBeInstanceOf(Error);
    expect(
      outputs.filter(
        (output) => output.kind === "event" && output.event.type === "interaction.closed",
      ),
    ).toHaveLength(1);
    expect(terminal(outputs)).toHaveLength(1);
  });

  it("uses native abort when the user cancels a legacy question", async () => {
    const { session, outputs, consume } = open();
    client.native.send.mockImplementation(async () => {
      emit(event("user.message", { messageId: "question-root", content: "question" }));
      return "question-root";
    });
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "question" }],
    });
    const handler = client.createSession.mock.calls[0]?.[0].onUserInputRequest;
    if (!handler) throw new Error("Missing question callback");
    const waiting = Promise.resolve(
      handler({ question: "Choose" }, { sessionId: client.native.sessionId }),
    ).catch((error) => error);
    await vi.waitFor(() =>
      expect(outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const pending = outputs.find((output) => output.kind === "interaction");
    if (pending?.kind !== "interaction") throw new Error("Missing public question");
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: pending.interaction.interactionId,
          response: { type: "question", answers: {}, cancelled: true },
        })
      ).ok,
    ).toBe(true);
    expect(await waiting).toBeInstanceOf(Error);
    expect(client.native.abort).toHaveBeenCalledOnce();
    await session.close();
    await consume;
    expect(terminal(outputs).map((value) => value.outcome.status)).toEqual(["cancelled"]);
  });

  it("isolates late messages from a completed Turn", async () => {
    const { session, outputs, consume } = open();
    let round = 0;
    client.native.send.mockImplementation(async () => {
      const number = ++round;
      const messageId = `message-${number}`;
      emit(event("user.message", { content: "hello", messageId }));
      if (number === 2)
        emit(event("assistant.message_delta", { messageId: "answer-1", deltaContent: "late" }));
      if (number === 2)
        emit(
          event("session.error", {
            errorType: "inference",
            message: "previous request",
            originatingMessageId: "message-1",
          }),
        );
      emit(
        event("assistant.message", {
          messageId: `answer-${number}`,
          originatingMessageId: messageId,
          content: `answer ${number}`,
        }),
      );
      emit(event("session.idle", { mode: "interactive" }));
      return messageId;
    });
    for (const id of ["first", "second"])
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(id),
        input: [{ type: "text", text: "hello" }],
      });
    await session.close();
    await consume;
    expect(terminal(outputs).map((value) => value.outcome.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(JSON.stringify(outputs)).not.toContain("late");
  });

  it("faults and settles the active Turn when the native connection disappears", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { session, outputs, consume } = open();
    try {
      client.native.send.mockImplementation(async () => {
        emit(event("user.message", { content: "hello", messageId: "message-1" }));
        return "message-1";
      });
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hello" }],
      });
      client.ping.mockRejectedValue(new Error("connection exited"));
      await vi.advanceTimersByTimeAsync(5_000);
      await consume;
      expect(terminal(outputs).map((value) => value.outcome.status)).toEqual(["failed"]);
      expect(
        outputs.filter(
          (output) => output.kind === "event" && output.event.type === "session.faulted",
        ),
      ).toHaveLength(1);
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });
});
