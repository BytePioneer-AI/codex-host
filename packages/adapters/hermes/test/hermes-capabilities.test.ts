import { describe, expect, it, vi } from "vitest";
import type { AvailableCommand, PromptResponse } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HostItemSnapshot } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HermesAcpTransport, HermesTransportEvent } from "../src/acp-transport.js";
import { hermesCommandCatalog } from "../src/hermes-commands.js";
import { hermesFileChanges, hermesToolOutput } from "../src/hermes-file-changes.js";
import { HermesSession } from "../src/hermes-session.js";

const diff = { type: "diff" as const, path: "src/app.ts", oldText: "before\n", newText: "after\n" };
const nativeCommands: AvailableCommand[] = [
  { name: "compress", description: "Compress conversation context" },
  { name: "context", description: "Inspect context" },
];
type Emit = (event: HermesTransportEvent) => void;
function makeSession(
  runTurn: (text: string, emit: Emit) => Promise<PromptResponse>,
  replay: HermesTransportEvent[] = [],
) {
  const transport = {
    availableCommands: nativeCommands,
    onFault: () => undefined,
    runTurn: vi.fn(runTurn),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const session = new HermesSession({
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "native",
      formatVersion: 1,
    }),
    transport: transport as unknown as HermesAcpTransport,
    open: {
      initialize: { protocolVersion: 1 },
      sessionId: "native",
      session: { sessionId: "native", models: null, modes: null },
      replay,
    },
    onSettle: () => undefined,
  });
  return { session, transport };
}
async function collect(outputs: AsyncIterable<HarnessOutput>): Promise<HarnessOutput[]> {
  const result: HarnessOutput[] = [];
  for await (const output of outputs) {
    result.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") return result;
  }
  return result;
}
function completedItems(outputs: HarnessOutput[]): HostItemSnapshot[] {
  return outputs.flatMap((output) =>
    output.kind === "event" && output.event.type === "item.completed"
      ? [output.event.snapshot]
      : [],
  );
}
function emitEdit(emit: Emit, status: "completed" | "failed") {
  emit({
    type: "tool.call",
    toolCallId: "edit",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "edit",
      title: "Edit file",
      status: "in_progress",
      content: [diff],
    },
  });
  emit({
    type: "tool.update",
    toolCallId: "edit",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit",
      status,
      content: [{ type: "content", content: { type: "text", text: "native tool result" } }],
    },
  });
}

describe("Hermes native diff projection", () => {
  it("keeps native diff fragments without inventing whole-file coordinates or additions", () => {
    expect(hermesFileChanges({ toolCallId: "edit", content: [diff] })).toMatchObject([
      {
        path: "src/app.ts",
        kind: "update",
        diffScope: "fragment",
        unifiedDiff: expect.stringContaining("-before\n+after"),
      },
    ]);
    expect(
      hermesFileChanges({ toolCallId: "edit", content: [{ ...diff, oldText: null }] })[0]?.kind,
    ).toBe("update");
    expect(
      hermesFileChanges({ toolCallId: "edit", content: [{ ...diff, path: "evil\npath" }] }),
    ).toEqual([]);
    expect(
      hermesFileChanges({
        toolCallId: "edit",
        content: [{ ...diff, newText: "a".repeat(1024 * 1024 + 1) }],
      }),
    ).toEqual([]);
  });
  it("reads the ACP nested content envelope", () => {
    expect(
      hermesToolOutput({
        toolCallId: "t",
        content: [{ type: "content", content: { type: "text", text: "output" } }],
      }),
    ).toEqual({ content: [{ type: "text", text: "output" }] });
  });
  it.each(["completed", "failed"] as const)(
    "emits applied changes only for %s tool status and keeps snapshot parity",
    async (status) => {
      const { session } = makeSession(async (_text, emit) => {
        emitEdit(emit, status);
        return { stopReason: "end_turn" };
      });
      const outputs = collect(session.outputs);
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("edit-turn"),
        input: [{ type: "text", text: "edit file" }],
      });
      const items = completedItems(await outputs);
      expect(items.filter(({ item }) => item.type === "fileChange")).toHaveLength(
        status === "completed" ? 1 : 0,
      );
      if (status === "completed")
        expect(items[1]?.item).toMatchObject({
          type: "fileChange",
          sourceItemIds: [items[0]?.item.itemId],
        });
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns[0]?.items).toEqual(items);
      await session.close();
    },
  );
  it("discards a stale preview when the authoritative final diff exceeds the size limit", async () => {
    const { session } = makeSession(async (_text, emit) => {
      emit({
        type: "tool.call",
        toolCallId: "edit",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "edit",
          title: "Edit file",
          status: "in_progress",
          content: [diff],
        },
      });
      emit({
        type: "tool.update",
        toolCallId: "edit",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit",
          status: "completed",
          content: [{ ...diff, newText: "x".repeat(1024 * 1024 + 1) }],
        },
      });
      return { stopReason: "end_turn" };
    });
    const outputs = collect(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("oversized-final"),
      input: [{ type: "text", text: "edit" }],
    });
    expect(completedItems(await outputs).filter(({ item }) => item.type === "fileChange")).toEqual(
      [],
    );
    await session.close();
  });
  it("projects the same confirmed changes when replaying history", async () => {
    const replay: HermesTransportEvent[] = [{ type: "user.text", text: "edit file" }];
    emitEdit((event) => replay.push(event), "completed");
    const { session } = makeSession(async () => ({ stopReason: "end_turn" }), replay);
    const snapshot = await session.readSnapshot();
    expect(snapshot.ok && snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "toolExecution",
      "fileChange",
    ]);
    await session.close();
  });
});

describe("Hermes native commands", () => {
  it("skips invalid and duplicate live entries without losing valid commands", () => {
    const catalog = hermesCommandCatalog([
      ...nativeCommands,
      { name: "review docs", description: "Whitespace" },
      { name: "custom/review", description: "Slash" },
      { name: "审查", description: "Non-ASCII id" },
      { name: "review", description: "Review", input: { hint: "Files" } },
      { name: "review", description: "Duplicate" },
      { name: "model", description: "Excluded" },
    ]);
    expect(catalog.commands.map(({ id }) => id)).toEqual([
      "hermes.compress",
      "hermes.context",
      "hermes.review",
    ]);
    expect(catalog.commands.at(-1)).toMatchObject({ argumentMode: "text", description: "Review" });
  });

  it("only exposes commands actually advertised by this native session", () => {
    expect(hermesCommandCatalog([])).toEqual({ commands: [] });
    expect(
      hermesCommandCatalog([
        ...nativeCommands,
        { name: "reset", description: "clear" },
        { name: "queue", description: "queue" },
        { name: "model", description: "model" },
      ]).commands.map(({ id }) => id),
    ).toEqual(["hermes.compress", "hermes.context"]);
  });
  it("runs compression via the native prompt without claiming it was persisted in history", async () => {
    const { session, transport } = makeSession(async (_text, emit) => {
      emit({
        type: "agent.text",
        text: "Context compressed: 8 -> 3 messages\n~2,000 -> ~500 tokens",
      });
      return { stopReason: "end_turn" };
    });
    const outputs = collect(session.outputs);
    expect(
      await session.commands.execute({
        turnId: hostTurnIdSchema.parse("compress"),
        commandId: "hermes.compress",
      }),
    ).toMatchObject({ ok: true });
    const events = await outputs;
    expect(transport.runTurn.mock.calls[0]?.[0]).toBe("/compress");
    expect(
      completedItems(events).find(({ item }) => item.type === "contextCompaction"),
    ).toMatchObject({ outcome: { status: "succeeded" } });
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      kind: "event",
      event: { type: "turn.completed", outcome: { status: "succeeded" } },
    });
    if (terminal?.kind === "event") expect(terminal.event).not.toHaveProperty("nativeTurnRef");
    expect(await session.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    await session.close();
  });
  it("rejects unknown commands and unsupported arguments without sending prompts", async () => {
    const { session, transport } = makeSession(async () => ({ stopReason: "end_turn" }));
    for (const request of [
      { commandId: "hermes.reset" },
      { commandId: "hermes.compress", arguments: { text: "unexpected" } },
      { commandId: "hermes.compress", arguments: { bogus: "x" } },
    ]) {
      expect(
        await session.commands.execute({ turnId: hostTurnIdSchema.parse("invalid"), ...request }),
      ).toMatchObject({ ok: false });
    }
    expect(transport.runTurn).not.toHaveBeenCalled();
    await session.close();
  });
  it("reports native compression failures without fabricating a successful compaction item", async () => {
    const { session } = makeSession(async () => {
      throw new Error("compression failed");
    });
    const outputs = collect(session.outputs);
    await session.commands.execute({
      turnId: hostTurnIdSchema.parse("failed"),
      commandId: "hermes.compress",
    });
    const events = await outputs;
    expect(events.at(-1)).toMatchObject({
      kind: "event",
      event: { type: "turn.completed", outcome: { status: "failed" } },
    });
    expect(completedItems(events)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ type: "contextCompaction" }),
        outcome: expect.objectContaining({ status: "failed" }),
      }),
    ]);
    await session.close();
  });
  it("preserves native textual failure results instead of inventing compaction success", async () => {
    const { session } = makeSession(async (_text, emit) => {
      emit({ type: "agent.text", text: "Compression failed: native error" });
      return { stopReason: "end_turn" };
    });
    const outputs = collect(session.outputs);
    await session.commands.execute({
      turnId: hostTurnIdSchema.parse("native-error"),
      commandId: "hermes.compress",
    });
    const events = await outputs;
    expect(completedItems(events).map(({ item }) => item)).toEqual([
      expect.objectContaining({ type: "agentMessage", text: "Compression failed: native error" }),
      expect.objectContaining({ type: "contextCompaction" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "event",
      event: {
        outcome: { status: "failed", error: { message: "Compression failed: native error" } },
      },
    });
    await session.close();
  });
  it.each([
    "Nothing to compress — conversation is empty.",
    "unrecognized result from a future version",
  ])("does not report successful compaction for %s", async (text) => {
    const { session } = makeSession(async (_text, emit) => {
      emit({ type: "agent.text", text });
      return { stopReason: "end_turn" };
    });
    const outputs = collect(session.outputs);
    await session.commands.execute({
      turnId: hostTurnIdSchema.parse("no-op"),
      commandId: "hermes.compress",
    });
    const events = await outputs;
    expect(
      completedItems(events).find(({ item }) => item.type === "contextCompaction"),
    ).toMatchObject({ outcome: { status: "cancelled", reason: text } });
    expect(events.at(-1)).toMatchObject({
      kind: "event",
      event: { outcome: { status: "succeeded" } },
    });
    await session.close();
  });

  it("isolates delayed failed-command events from the next turn", async () => {
    let delayed: Emit = () => undefined;
    const { session, transport } = makeSession(async (_text, emit) => {
      delayed = emit;
      throw new Error("native failure");
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    const outputStream = { [Symbol.asyncIterator]: () => iterator };
    const first = collect(outputStream);
    await session.commands.execute({
      turnId: hostTurnIdSchema.parse("first"),
      commandId: "hermes.compress",
    });
    await first;
    transport.runTurn.mockImplementationOnce(async (_text, emit) => {
      delayed({ type: "agent.text", text: "stale" });
      emit({ type: "agent.text", text: "current" });
      return { stopReason: "end_turn" };
    });
    const second = collect(outputStream);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("second"),
      input: [{ type: "text", text: "continue" }],
    });
    const secondEvents = await second;
    expect(completedItems(secondEvents).map(({ item }) => item)).toEqual([
      expect.objectContaining({ text: "current" }),
    ]);
    await session.close();
    delayed({ type: "agent.text", text: "after-close" });
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it.each(["cancel", "close"] as const)(
    "settles %s during compression once and ignores late output",
    async (action) => {
      let finish: (value: PromptResponse) => void = () => undefined;
      let emitLate: Emit = () => undefined;
      const { session, transport } = makeSession(async (_text, emit) => {
        emitLate = emit;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const outputs = collect(session.outputs);
      const turnId = hostTurnIdSchema.parse(action);
      await session.commands.execute({ turnId, commandId: "hermes.compress" });
      if (action === "close") await session.close();
      else {
        expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({ ok: true });
        expect(transport.cancel).toHaveBeenCalledOnce();
        // Acceptance is not completion: wait for the native prompt's terminal result.
        finish({ stopReason: "cancelled" });
      }
      const events = await outputs;
      expect(
        events.filter(
          (output) => output.kind === "event" && output.event.type === "turn.completed",
        ),
      ).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        kind: "event",
        event: { outcome: { status: "cancelled" } },
      });
      expect(
        completedItems(events).find(({ item }) => item.type === "contextCompaction"),
      ).toMatchObject({ outcome: { status: "cancelled" } });
      emitLate({ type: "agent.text", text: "late" });
      finish({ stopReason: "end_turn" });
      await session.close();
    },
  );
});

describe("Hermes ACP native command grammar", () => {
  it.each(["/context extra", "//context", " /CoNtExT "])(
    "keeps ACP-dispatched %j outside chat history",
    async (text) => {
      const { session } = makeSession(async () => ({ stopReason: "end_turn" }));
      const completed = collect(session.outputs);
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("acp-command"),
        input: [{ type: "text", text }],
      });
      const terminal = (await completed).find(
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      );
      if (terminal?.kind !== "event" || terminal.event.type !== "turn.completed")
        throw new Error("Missing completion");
      expect(terminal.event.nativeTurnRef).toBeUndefined();
      expect(await session.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
      await session.close();
    },
  );
});
