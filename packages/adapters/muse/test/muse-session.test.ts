import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { HarnessOutput, TurnStartCommand } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { MuseHarnessSession } from "../src/muse-session.js";
import {
  MuseProcessError,
  MuseRpcError,
  type JsonObject,
  type MuseRpc,
  type MuseRpcNotification,
} from "../src/msp-client.js";

class SessionRpc implements MuseRpc {
  listeners = new Set<(notification: MuseRpcNotification) => void>();
  failures = new Set<(error: MuseProcessError) => void>();
  requests: Array<{ method: string; params: JsonObject }> = [];
  startResult: JsonObject = {};
  sessionState: JsonObject = { activeTurnId: null, status: "idle" };
  cancelError: Error | undefined;
  closed = false;
  nativeTurnId = "";

  async handshake() {
    return {};
  }
  notify() {}
  async request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    this.requests.push({ method, params });
    if (method === "session/read")
      return { session: this.sessionState, history: { mode: "inline", items: [] } };
    if (method === "turn/start") {
      this.nativeTurnId = String(this.startResult.turnId ?? params.commandId);
      return {
        commandId: params.commandId,
        status: "accepted",
        disposition: "started",
        startedNewTurn: true,
        turnId: this.nativeTurnId,
        ...this.startResult,
      };
    }
    if (method === "turn/cancel" && this.cancelError) throw this.cancelError;
    return { commandId: params.commandId, status: "accepted", turnId: params.turnId };
  }
  subscribe(handler: (notification: MuseRpcNotification) => void) {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }
  subscribeFailure(handler: (error: MuseProcessError) => void) {
    this.failures.add(handler);
    return () => {
      this.failures.delete(handler);
    };
  }
  emit(method: string, params: JsonObject) {
    for (const listener of this.listeners) listener({ method, params });
  }
  fail() {
    for (const listener of this.failures)
      listener(
        new MuseProcessError({ code: "nativeFailure", message: "Muse exited 1", retryable: false }),
      );
  }
  async close() {
    this.closed = true;
  }
}

function fixture() {
  const rpc = new SessionRpc();
  const session = new MuseHarnessSession({ rpc, native: { sessionId: "parent" } });
  const outputs: HarnessOutput[] = [];
  const consume = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  const command: TurnStartCommand = {
    type: "turn.start",
    turnId: hostTurnIdSchema.parse("host-turn"),
    input: [{ type: "text", text: "hello" }],
  };
  const item = (text = "", turnId = rpc.nativeTurnId) => ({
    kind: "agentMessage",
    itemId: "reply",
    turnId,
    revision: 1,
    status: "inProgress",
    text,
  });
  const emit = (method: string, params: JsonObject = {}) =>
    rpc.emit(method, { sessionId: "parent", ...params });
  const terminal = (params: JsonObject = {}) =>
    emit("turn/completed", {
      turnId: rpc.nativeTurnId,
      terminal: "completed",
      viewCursor: "terminal",
      ...params,
    });
  const finish = async () => {
    await session.close();
    await consume;
  };
  return { rpc, session, outputs, command, item, emit, terminal, finish };
}

function events(outputs: HarnessOutput[]) {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
}

describe("Muse native Session lifecycle", () => {
  it("projects each streamed character once even when the consumer runs after every native event", async () => {
    const f = fixture();
    expect((await f.session.execute(f.command)).ok).toBe(true);
    f.emit("item/started", { item: f.item(), viewCursor: "1" });
    f.emit("item/delta", { itemId: "reply", delta: "你好", viewCursor: "2" });
    f.emit("item/completed", {
      item: { ...f.item("你好"), status: "completed", revision: 2 },
      viewCursor: "3",
    });
    f.terminal();
    await setImmediate();
    const projector = new CodexTurnProjector({
      threadId: "thread",
      turnId: f.command.turnId,
      cwd: "/tmp",
      startedAtMs: 0,
    });
    const messages = events(f.outputs).flatMap((event) =>
      "turnId" in event && event.type !== "turn.autonomous.started"
        ? projector.project(event).messages
        : [],
    );
    const text = messages
      .filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => (message.params as JsonObject).delta)
      .join("");
    expect(text).toBe("你好");
    expect(events(f.outputs).find((event) => event.type === "item.started")).toMatchObject({
      item: { text: "" },
    });
    await f.finish();
  });

  it("keeps legitimate repeated appends and deduplicates only the replayed view cursor", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    f.emit("item/started", { item: f.item("ha"), viewCursor: "1" });
    f.emit("item/delta", { itemId: "reply", delta: "ha", viewCursor: "2" });
    f.emit("item/delta", { itemId: "reply", delta: "ha", viewCursor: "3" });
    f.emit("item/delta", { itemId: "reply", delta: "ha", viewCursor: "3" });
    f.emit("item/completed", {
      item: { ...f.item("hahaha"), revision: 2, status: "completed" },
      viewCursor: "4",
    });
    f.terminal();
    await setImmediate();
    expect(events(f.outputs).find((event) => event.type === "item.completed")).toMatchObject({
      snapshot: { item: { text: "hahaha" } },
    });
    await f.finish();
  });

  it("ignores child sessions and stale turns, including a late terminal after cancel and restart", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    const previousNative = f.rpc.nativeTurnId;
    f.rpc.emit("turn/completed", {
      sessionId: "child",
      turnId: previousNative,
      terminal: "completed",
    });
    f.emit("item/started", { item: f.item("stale", "older"), viewCursor: "stale" });
    await setImmediate();
    expect(events(f.outputs).map((event) => event.type)).toEqual(["turn.started"]);
    expect((await f.session.execute({ type: "turn.cancel", turnId: f.command.turnId })).ok).toBe(
      true,
    );
    f.terminal({ terminal: "cancelled" });
    await setImmediate();
    const next = { ...f.command, turnId: hostTurnIdSchema.parse("next") };
    expect((await f.session.execute(next)).ok).toBe(true);
    f.emit("turn/completed", { turnId: previousNative, terminal: "completed" });
    f.emit("item/started", { item: f.item("late", previousNative) });
    await setImmediate();
    expect(events(f.outputs).filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events(f.outputs).filter((event) => event.type === "item.started")).toHaveLength(0);
    f.terminal();
    await f.finish();
  });

  it("reports native cancel errors without inventing a cancelled terminal", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    f.rpc.cancelError = new MuseRpcError("cancel denied", -32602);
    const cancelled = await f.session.execute({ type: "turn.cancel", turnId: f.command.turnId });
    expect(cancelled).toMatchObject({ ok: false, error: { message: "cancel denied" } });
    await setImmediate();
    expect(events(f.outputs).filter((event) => event.type === "turn.completed")).toHaveLength(0);
    expect(await f.session.execute(f.command)).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    f.terminal();
    await f.finish();
  });

  it("settles a process failure once and prevents all late output", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    f.emit("item/started", { item: f.item() });
    f.rpc.fail();
    f.rpc.fail();
    f.emit("item/delta", { itemId: "reply", delta: "late" });
    f.terminal();
    await setImmediate();
    expect(events(f.outputs).map((event) => event.type)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
      "session.faulted",
    ]);
    expect(events(f.outputs).find((event) => event.type === "turn.completed")).toMatchObject({
      outcome: { status: "failed" },
    });
    expect(await f.session.execute(f.command)).toMatchObject({ ok: false });
    expect(f.rpc.closed).toBe(true);
    await f.finish();
  });

  it("ends the parent at its native terminal while a background child can still change state", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    const nativeTurnId = f.rpc.nativeTurnId;
    const child = {
      kind: "subagent",
      itemId: "child-item",
      turnId: nativeTurnId,
      subagentId: "child",
      childSessionId: "child-session",
      revision: 1,
      status: "inProgress",
      controlStatus: "running",
    };
    f.emit("item/started", { item: child });
    f.terminal();
    await setImmediate();
    expect(events(f.outputs).filter((event) => event.type === "turn.completed")).toHaveLength(1);
    await f.session.execute({ ...f.command, turnId: hostTurnIdSchema.parse("next") });
    f.emit("item/completed", {
      item: { ...child, revision: 2, status: "completed", controlStatus: "resultReady" },
    });
    await setImmediate();
    const afterRestart = events(f.outputs).slice(
      events(f.outputs).findIndex((event) => event.type === "turn.completed") + 2,
    );
    expect(
      afterRestart.some(
        (event) => event.type === "subagent.state.changed" && event.status === "completed",
      ),
    ).toBe(true);
    expect(
      afterRestart.some(
        (event) => event.type === "item.updated" || event.type === "item.completed",
      ),
    ).toBe(false);
    f.terminal();
    await f.finish();
  });

  it("refreshes only an owned approval when native approval/updated has no turnId", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    const sourceRange = {
      first: { id: "event", sequence: 1 },
      last: { id: "event", sequence: 1 },
      stream: { kind: "session", id: "parent" },
    };
    const availableChoices = [
      { choiceId: "allow", decision: "approved", label: "Allow once", scope: "once" },
      { choiceId: "deny", decision: "denied", label: "Deny", scope: "once" },
    ];
    const subject = { kind: "shell", command: "printf hello" };
    f.emit("approval/requested", {
      approvalId: "approval",
      availableChoices,
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
      itemId: "tool",
      judgeEscalated: false,
      protectedWrite: false,
      rawArgs: "{}",
      sourceRange,
      subject,
      taskId: "task",
      toolCallId: "call",
      toolName: "shell",
      turnId: f.rpc.nativeTurnId,
      viewCursor: "request",
    });
    const updated = {
      approvalId: "approval",
      availableChoices,
      currentRequirementId: { approvalId: "approval", sourceIndex: 1 },
      change: { kind: "requirementChanged" },
      sourceRange,
      subject,
      viewCursor: "refresh",
    };
    expect(updated).not.toHaveProperty("turnId");
    f.emit("approval/updated", { ...updated, approvalId: "unowned", viewCursor: "unowned" });
    f.emit("approval/updated", updated);
    await setImmediate();
    const interactions = f.outputs.flatMap((output) =>
      output.kind === "interaction" ? [output.interaction] : [],
    );
    expect(interactions.map((interaction) => interaction.interactionId)).toEqual([
      "approval:0",
      "approval:1",
    ]);
    expect(events(f.outputs).filter((event) => event.type === "interaction.closed")).toMatchObject([
      { interactionId: "approval:0", reason: "superseded" },
    ]);
    const refreshed = interactions.at(-1);
    if (!refreshed) throw new Error("Expected refreshed approval");
    expect(
      await f.session.execute({
        type: "interaction.respond",
        interactionId: refreshed.interactionId,
        response: { type: "approval", actionId: "allow" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      f.rpc.requests.find((request) => request.method === "approval/decide")?.params.requirementId,
    ).toEqual({ approvalId: "approval", sourceIndex: 1 });
    f.terminal();
    await f.session.execute({ ...f.command, turnId: hostTurnIdSchema.parse("next") });
    f.emit("approval/updated", { ...updated, viewCursor: "late" });
    await setImmediate();
    expect(f.outputs.filter((output) => output.kind === "interaction")).toHaveLength(2);
    await f.finish();
  });

  it("settles an owned question without a native turnId and ignores unknown question IDs", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    f.emit("userInput/requested", {
      itemId: "tool",
      questions: [
        {
          id: "answer",
          header: "Choose",
          question: "Which?",
          options: [{ label: "one" }],
          selection: { mode: "single" },
        },
      ],
      toolCallId: "call",
      toolName: "ask",
      turnId: f.rpc.nativeTurnId,
      userInputId: "question",
      viewCursor: "request",
    });
    const settled = {
      answers: [],
      clarification: null,
      decidedByCommandId: null,
      outcome: "cancelled",
      reason: null,
      sourceRange: {
        first: { id: "event", sequence: 1 },
        last: { id: "event", sequence: 1 },
        stream: { kind: "session", id: "parent" },
      },
      userInputId: "question",
      viewCursor: "settled",
    };
    expect(settled).not.toHaveProperty("turnId");
    f.emit("userInput/settled", { ...settled, userInputId: "unknown", viewCursor: "unowned" });
    f.emit("userInput/settled", settled);
    await setImmediate();
    expect(events(f.outputs).filter((event) => event.type === "interaction.closed")).toMatchObject([
      { interactionId: "question", reason: "cancelled" },
    ]);
    await f.finish();
  });

  it("closes a pending interaction on process failure and rejects its late response", async () => {
    const f = fixture();
    await f.session.execute(f.command);
    f.emit("userInput/requested", {
      turnId: f.rpc.nativeTurnId,
      userInputId: "question",
      toolName: "ask",
      questions: [],
    });
    f.rpc.fail();
    await setImmediate();
    expect(events(f.outputs).filter((event) => event.type === "interaction.closed")).toHaveLength(
      1,
    );
    const interaction = f.outputs.find((output) => output.kind === "interaction");
    if (!interaction || interaction.kind !== "interaction") throw new Error("Expected question");
    expect(
      await f.session.execute({
        type: "interaction.respond",
        interactionId: interaction.interaction.interactionId,
        response: { type: "question", answers: {} },
      }),
    ).toMatchObject({ ok: false });
    expect(f.rpc.requests.some((request) => request.method === "userInput/answer")).toBe(false);
    await f.finish();
  });

  it.each(["failed", "cancelled", "rejected", "timedOut"])(
    "preserves native %s item outcomes and reasons without failing a successful parent Turn",
    async (status) => {
      const f = fixture();
      await f.session.execute(f.command);
      const failures = [
        { failureReason: "native failure detail", reason: "less specific reason" },
        { reason: "native fallback reason" },
      ];
      for (const [index, reasons] of failures.entries()) {
        f.emit("item/completed", {
          item: {
            kind: "toolCall",
            itemId: `tool-${index}`,
            turnId: f.rpc.nativeTurnId,
            revision: 2,
            tool: "shell",
            status,
            ...reasons,
          },
          viewCursor: `completion-${index}`,
        });
      }
      f.terminal();
      await setImmediate();
      const expected = ["native failure detail", "native fallback reason"].map((reason) =>
        status === "cancelled" || status === "rejected"
          ? { status: "cancelled", reason }
          : {
              status: "failed",
              error: { code: "nativeFailure", message: reason, retryable: false },
            },
      );
      const outcomes = events(f.outputs).flatMap((event) =>
        event.type === "item.completed" ? [event.snapshot.outcome] : [],
      );
      expect(outcomes).toEqual(expected);
      expect(events(f.outputs).find((event) => event.type === "turn.completed")).toMatchObject({
        outcome: { status: "succeeded" },
      });
      await f.finish();
    },
  );

  it("reclaims a queued input instead of projecting it as an already running turn", async () => {
    const f = fixture();
    f.rpc.startResult = { disposition: "queued", startedNewTurn: false, turnId: "queued-native" };
    expect(await f.session.execute(f.command)).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(f.rpc.requests.find((request) => request.method === "turn/unqueue")?.params.turnId).toBe(
      "queued-native",
    );
    await setImmediate();
    expect(events(f.outputs)).toEqual([]);
    await f.finish();
  });

  it.each([{ status: "noop" }, { turnId: "" }, { disposition: "steered" }])(
    "rejects an invalid fresh-turn acknowledgement %j",
    async (ack) => {
      const f = fixture();
      f.rpc.startResult = ack;
      expect(await f.session.execute(f.command)).toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
      await setImmediate();
      expect(events(f.outputs).filter((event) => event.type === "turn.started")).toHaveLength(0);
      await f.finish();
    },
  );

  it("does not submit into a session whose native foreground is still running", async () => {
    const f = fixture();
    f.rpc.sessionState = { activeTurnId: "other-client", status: "running" };
    expect(await f.session.execute(f.command)).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(f.rpc.requests.some((request) => request.method === "turn/start")).toBe(false);
    await f.finish();
  });
});
