import { describe, it, expect, vi } from "vitest";
import type {
  HarnessOutput,
  HostQuestionResponse,
  HostQuestionInteraction,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { HermesGatewayTransport, type GatewayRecord } from "../src/gateway-transport.js";
import { HermesGatewaySessionTransport } from "../src/gateway-session-transport.js";
import { HermesSession } from "../src/hermes-session.js";
import type { HermesTransportEvent } from "../src/acp-transport.js";

function fixture() {
  const raw = new HermesGatewayTransport("unused", process.cwd(), {});
  const info = { model: "test", provider: "custom", yolo: false };
  const bridge = new HermesGatewaySessionTransport(raw, "runtime", "native", info);
  const request = vi.spyOn(raw, "request").mockImplementation(async (method, params) => {
    if (method === "config.get") return { value: "low" };
    if (method === "prompt.submit") return { status: "streaming" };
    if (method === "session.compress")
      return { status: "compressed", summary: { noop: true, note: "Nothing to compress" } };
    if (method === "config.set") {
      raw.onEvent({
        type: "session.info",
        session_id: "runtime",
        payload: { ...info, yolo: params.value === "on" },
      });
      return { value: params.key === "yolo" ? (params.value === "on" ? "1" : "0") : params.value };
    }
    return {};
  });
  const respond = vi.spyOn(raw, "respond").mockImplementation(() => {});
  const reject = vi.spyOn(raw, "rejectRequest").mockImplementation(() => {});
  const close = vi.spyOn(raw, "close").mockResolvedValue();
  const emit = (type: string, payload: GatewayRecord = {}) =>
    raw.onEvent({ type, session_id: "runtime", payload });
  return { raw, bridge, request, respond, reject, close, emit };
}
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));
function makeSession(f: ReturnType<typeof fixture>) {
  vi.spyOn(f.bridge, "readNativeSnapshot").mockResolvedValue({ turns: [] });
  return new HermesSession({
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "native",
      formatVersion: 1,
    }),
    transport: f.bridge,
    open: {
      initialize: { protocolVersion: 1 },
      sessionId: "native",
      session: {
        sessionId: "native",
        models: null,
        modes: null,
        thinkingOptions: [{ id: "low" as never, label: "low" }],
      },
      replay: [],
    },
    onSettle: () => {},
  });
}
async function outputsUntilComplete(
  session: HermesSession,
  onQuestion?: (question: HostQuestionInteraction) => Promise<void>,
): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  for await (const output of session.outputs) {
    outputs.push(output);
    if (output.kind === "interaction" && output.interaction.type === "question")
      await onQuestion?.(output.interaction);
    if (output.kind !== "event") continue;
    if (output.event.type === "turn.completed") return outputs;
  }
  return outputs;
}

describe("Hermes gateway native interactions", () => {
  it("validates Host answers, preserves commas in native multi-select and rejects duplicate replies", async () => {
    const f = fixture();
    const s = makeSession(f);
    let question: HostQuestionInteraction | undefined;
    const outputs = outputsUntilComplete(s, async (interaction) => {
      question = interaction;
      const id = interaction.interactionId;
      const invalid = await s.execute({
        type: "interaction.respond",
        interactionId: id,
        response: { type: "question", answers: {} },
      });
      expect(invalid.ok).toBe(false);
      const response: HostQuestionResponse = {
        type: "question",
        answers: { pick: ["A, B", "C"], text: ["hello"] },
      };
      expect(
        (await s.execute({ type: "interaction.respond", interactionId: id, response })).ok,
      ).toBe(true);
      expect(
        (await s.execute({ type: "interaction.respond", interactionId: id, response })).ok,
      ).toBe(false);
    });
    await s.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("t"),
      input: [{ type: "text", text: "go" }],
    });
    await pause();
    f.raw.onRequest("q", "clarify", {
      session_id: "runtime",
      questions: [
        { qid: "pick", question: "Choose", choices: ["A, B", "C"], multi_select: true },
        { qid: "text", question: "Explain" },
      ],
    });
    await pause();
    expect(question?.questions).toHaveLength(2);
    expect(f.respond).toHaveBeenCalledWith("q", {
      answers: { pick: '["A, B","C"]', text: "hello" },
    });
    f.emit("message.complete", { text: "done", status: "complete" });
    await outputs;
    await s.close();
  });
  it("expires a native question without replying late, then keeps a new turn isolated", async () => {
    const f = fixture();
    const s = makeSession(f);
    let interaction: HostQuestionInteraction | undefined;
    const outputs = outputsUntilComplete(s, async (q) => {
      interaction = q;
    });
    await s.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("t"),
      input: [{ type: "text", text: "go" }],
    });
    await pause();
    f.raw.onRequest("q", "clarify", { session_id: "runtime", question: "Continue?" });
    await pause();
    f.emit("request.cancel", { id: "q", reason: "timeout" });
    await pause();
    expect(f.respond).not.toHaveBeenCalled();
    if (!interaction) throw new Error("Missing pending interaction");
    expect(
      (
        await s.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { answer: ["late"] } },
        })
      ).ok,
    ).toBe(false);
    f.emit("message.complete", { text: "done", status: "complete" });
    expect(
      (await outputs).some(
        (o) =>
          o.kind === "event" &&
          o.event.type === "interaction.closed" &&
          o.event.reason === "expired",
      ),
    ).toBe(true);
    await s.close();
    f.emit("message.delta", { text: "late" });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("preserves all native approval scopes", async () => {
    const f = fixture();
    const active = f.bridge.runTurn(
      "go",
      () => {},
      async (request) => {
        expect(request.options.map((o) => o.optionId)).toEqual([
          "once",
          "session",
          "always",
          "deny",
        ]);
        expect(request.effects?.session).toBe("allowForSession");
        return { outcome: { outcome: "selected", optionId: "session" } };
      },
    );
    await pause();
    f.raw.onRequest("a", "approval", {
      session_id: "runtime",
      choices: ["once", "session", "always", "deny"],
      command: "rm file",
    });
    await pause();
    expect(f.respond).toHaveBeenCalledWith("a", { choice: "session" });
    f.emit("message.complete", { status: "complete" });
    await active;
  });
  it("requires native confirmation for thinking, model and effective approvals", async () => {
    const f = fixture();
    await expect(f.bridge.setThinking("low")).resolves.toBe("low");
    f.request.mockResolvedValue({ value: "different" });
    await expect(f.bridge.setThinking("high")).rejects.toThrow("confirm");
    await expect(f.bridge.setModel("custom:another")).rejects.toThrow("confirm");
    f.emit("session.info", { model: "test", provider: "custom", yolo: true });
    f.request.mockResolvedValue({ value: "0" });
    await expect(f.bridge.setPermissionMode("default")).rejects.toThrow("effective approval");
  });
});

describe("Hermes gateway native turn projection", () => {
  it.each(["/help extra", "//help", "/compressx", "//compress", "/context\nextra"])(
    "preserves native history identity for ordinary slash prompt %j",
    async (text) => {
      const f = fixture();
      const session = makeSession(f);
      const nativeTurnRef = {
        harnessId: session.harnessId,
        nativeSessionId: "native",
        nativeTurnKey: "persisted",
        formatVersion: 1 as const,
      };
      vi.mocked(f.bridge.readNativeSnapshot)
        .mockResolvedValueOnce({ turns: [] })
        .mockResolvedValueOnce({
          turns: [
            {
              nativeTurnRef,
              input: [{ type: "text", text }],
              items: [],
              outcome: { status: "succeeded" },
            },
          ],
        });
      const completed = outputsUntilComplete(session);
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("slash-prompt"),
        input: [{ type: "text", text }],
      });
      await pause();
      expect(f.request).toHaveBeenCalledWith("prompt.submit", { session_id: "runtime", text });
      f.emit("message.complete", { status: "complete", text: "reply" });
      const outputs = await completed;
      expect(
        outputs.find((o) => o.kind === "event" && o.event.type === "turn.completed"),
      ).toMatchObject({ event: { nativeTurnRef, outcome: { status: "succeeded" } } });
      expect(
        outputs.some(
          (o) =>
            o.kind === "event" &&
            o.event.type === "item.started" &&
            o.event.item.type === "contextCompaction",
        ),
      ).toBe(false);
      await session.close();
    },
  );
  it.each(["/help", " /HELP ", "/tools", "/context", "/version", "/compress focus"])(
    "keeps dispatched native command %j outside chat history",
    async (text) => {
      const f = fixture();
      const session = makeSession(f);
      const completed = outputsUntilComplete(session);
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("slash-command"),
        input: [{ type: "text", text }],
      });
      const outputs = await completed;
      const terminal = outputs.find((o) => o.kind === "event" && o.event.type === "turn.completed");
      expect(terminal).toMatchObject({ event: { outcome: { status: "succeeded" } } });
      if (terminal?.kind === "event" && terminal.event.type === "turn.completed")
        expect(terminal.event.nativeTurnRef).toBeUndefined();
      expect(f.request.mock.calls.some(([method]) => method === "prompt.submit")).toBe(false);
      expect(f.bridge.readNativeSnapshot).not.toHaveBeenCalled();
      await session.close();
    },
  );
  it("preserves complete tool output, native rendered diff and terminal reasoning/usage", async () => {
    const f = fixture();
    const events: HermesTransportEvent[] = [];
    const active = f.bridge.runTurn(
      "go",
      (e) => events.push(e),
      async () => ({ outcome: { outcome: "cancelled" } }),
    );
    await pause();
    f.emit("message.delta", { text: "hello" });
    f.emit("tool.complete", {
      tool_id: "edit",
      name: "patch",
      args: { path: "a.ts" },
      summary: "preview",
      result: { output: "full ".repeat(500) },
      inline_diff:
        "  ┊ review diff\n\u001b[31ma/a.ts → b/a.ts\u001b[0m\n@@ -1 +1 @@\n-before\n+after",
    });
    f.emit("message.complete", {
      text: "hello",
      status: "complete",
      reasoning: "native thinking",
      usage: { input: 10, output: 5, total: 15, reasoning: 2, context_used: 12, context_max: 100 },
    });
    expect(await active).toMatchObject({ usage: { inputTokens: 10, thoughtTokens: 2 } });
    expect(events.filter((e) => e.type === "agent.text")).toEqual([
      { type: "agent.text", text: "hello" },
    ]);
    expect(events).toContainEqual({ type: "agent.thought", text: "native thinking" });
    expect(events.find((e) => e.type === "tool.update")).toMatchObject({
      update: {
        content: [
          { type: "content", content: { text: JSON.stringify({ output: "full ".repeat(500) }) } },
          { type: "diff", path: "a.ts", oldText: "before", newText: "after" },
        ],
      },
    });
    expect(events.some((e) => e.type === "tool.call")).toBe(true);
  });
  it("keeps hunk body arrows and header-like text inside the real file", async () => {
    const f = fixture();
    const events: HermesTransportEvent[] = [];
    const active = f.bridge.runTurn(
      "go",
      (e) => events.push(e),
      async () => ({ outcome: { outcome: "cancelled" } }),
    );
    await pause();
    f.emit("tool.complete", {
      tool_id: "edit",
      name: "patch",
      result: { success: true },
      inline_diff:
        "a/a.ts → b/a.ts\n@@ -0,0 +1,3 @@\n+++ foo\n+old → new\n+--- source\n@@ -8 +11 @@\n-previous → line\n+next line\na/b.ts → b/b.ts\n@@ -1 +1 @@\n-old\n+new",
    });
    f.emit("message.complete", { status: "complete" });
    await active;
    const update = events.find((e) => e.type === "tool.update");
    expect(update).toMatchObject({
      update: {
        content: [
          { type: "content" },
          {
            type: "diff",
            path: "a.ts",
            oldText: "previous → line",
            newText: "++ foo\nold → new\n--- source\nnext line",
          },
          { type: "diff", path: "b.ts", oldText: "old", newText: "new" },
        ],
      },
    });
  });
  it("waits for native terminal cancellation and faults on pending compression", async () => {
    const f = fixture();
    let settled = false;
    const active = f.bridge
      .runTurn(
        "go",
        () => {},
        async () => ({ outcome: { outcome: "cancelled" } }),
      )
      .then((r) => {
        settled = true;
        return r;
      });
    await pause();
    await f.bridge.cancel();
    expect(settled).toBe(false);
    f.emit("message.complete", { status: "interrupted" });
    expect(await active).toMatchObject({ stopReason: "cancelled" });
    f.request.mockResolvedValue({ status: "pending" });
    const fault = vi.fn();
    f.bridge.onFault = fault;
    await expect(
      f.bridge.runTurn(
        "/compress",
        () => {},
        async () => ({ outcome: { outcome: "cancelled" } }),
      ),
    ).rejects.toThrow("pending");
    expect(fault).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    await expect(
      f.bridge.runTurn(
        "later",
        () => {},
        async () => ({ outcome: { outcome: "cancelled" } }),
      ),
    ).rejects.toThrow("unavailable");
  });
  it("reports native summary-generation abort as failed compression, not user cancellation", async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      status: "aborted",
      summary: {
        aborted: true,
        headline: "Compression aborted",
        note: "Summary generation failed",
      },
    });
    const s = makeSession(f);
    const outputs = outputsUntilComplete(s);
    await s.commands.execute({
      turnId: hostTurnIdSchema.parse("compact"),
      commandId: "hermes.compress",
    });
    const completed = await outputs;
    expect(
      completed.find((o) => o.kind === "event" && o.event.type === "turn.completed"),
    ).toMatchObject({ event: { outcome: { status: "failed" } } });
    expect(
      completed.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "contextCompaction",
      ),
    ).toMatchObject({
      event: {
        snapshot: {
          outcome: {
            status: "failed",
            error: { message: "Compression aborted\nSummary generation failed" },
          },
        },
      },
    });
    await s.close();
  });
  it("emits honest compression no-op and does not attach an old native Turn after rejected submit", async () => {
    const f = fixture();
    const s = makeSession(f);
    const old = {
      nativeTurnRef: {
        harnessId: "hermes" as never,
        nativeSessionId: "native",
        nativeTurnKey: "old",
        formatVersion: 1 as const,
      },
      input: [],
      items: [],
      outcome: { status: "succeeded" as const },
    };
    vi.mocked(f.bridge.readNativeSnapshot).mockResolvedValue({ turns: [old] });
    f.request.mockRejectedValue(new Error("rejected submit"));
    const outputs = outputsUntilComplete(s);
    await s.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("t"),
      input: [{ type: "text", text: "go" }],
    });
    const terminal = (await outputs).find(
      (o) => o.kind === "event" && o.event.type === "turn.completed",
    );
    expect(terminal).toMatchObject({ event: { outcome: { status: "failed" } } });
    expect(JSON.stringify(terminal)).not.toContain('"old"');
    await s.close();
    const fresh = fixture();
    expect(
      await fresh.bridge.runTurn(
        "/compress",
        () => {},
        async () => ({ outcome: { outcome: "cancelled" } }),
      ),
    ).toMatchObject({
      stopReason: "end_turn",
      compactionOutcome: { status: "cancelled", reason: "Nothing to compress" },
    });
  });
});
