import { describe, expect, it } from "vitest";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import { HarnessOutputChannel } from "../src/index.js";
import type { HarnessError, HarnessOutput } from "../src/index.js";
import { FakeHarnessAdapter, FakeHarnessSession } from "../src/testing.js";

const turnId = (value: string) => hostTurnIdSchema.parse(value);
const textTurn = (value: string) => ({
  type: "turn.start" as const,
  turnId: turnId(value),
  input: [{ type: "text" as const, text: value }],
});
const failure: HarnessError = {
  code: "nativeFailure",
  message: "synthetic failure",
  retryable: false,
};

async function collect(outputs: AsyncIterable<HarnessOutput>): Promise<HarnessOutput[]> {
  const collected: HarnessOutput[] = [];
  for await (const output of outputs) collected.push(output);
  return collected;
}

describe("minimal Harness text Session", () => {
  it("exposes an ordered complete successful Turn lifecycle", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await expect(session.execute(textTurn("turn-1"))).resolves.toEqual({
      ok: true,
      value: { turnId: "turn-1" },
    });
    session.appendText("first");
    session.appendText(" second");
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    expect(outputs.map(({ event }) => event.type)).toEqual([
      "turn.started",
      "item.started",
      "item.updated",
      "item.updated",
      "item.completed",
      "turn.completed",
    ]);
    expect(outputs[4]?.event).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "agentMessage", text: "first second" },
        outcome: { status: "succeeded" },
      },
    });
  });

  it("does not emit lifecycle outputs when a Turn is rejected before acceptance", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);
    session.rejectNextTurn(failure);

    await expect(session.execute(textTurn("rejected"))).resolves.toEqual({
      ok: false,
      error: failure,
    });
    await session.close();

    await expect(collected).resolves.toEqual([]);
  });

  it("rejects a concurrent Turn without changing the active lifecycle", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("active"));
    const second = await session.execute(textTurn("second"));
    expect(second).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    expect(outputs.filter(({ event }) => event.type === "turn.started")).toHaveLength(1);
    expect(outputs.filter(({ event }) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("finishes the Item and Turn before a Session fault", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("faulted"));
    session.appendText("partial");
    session.fault(failure);

    expect((await collected).map(({ event }) => event.type)).toEqual([
      "turn.started",
      "item.started",
      "item.updated",
      "item.completed",
      "turn.completed",
      "session.faulted",
    ]);
  });

  it("allows only one output consumer", () => {
    const channel = new HarnessOutputChannel<string>();

    channel.outputs[Symbol.asyncIterator]();
    expect(() => channel.outputs[Symbol.asyncIterator]()).toThrow(
      "Harness outputs allow only one consumer",
    );
  });

  it("correlates interleaved Command and Generic Tool lifecycles", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("tools"));
    const commandId = session.startCommandExecution("printf command");
    const toolId = session.startToolExecution("synthetic_tool", { value: 1 });
    session.appendCommandOutput(commandId, "command output");
    session.replaceToolOutput(toolId, {
      content: [{ type: "text", text: "partial" }],
    });
    session.replaceToolOutput(toolId, {
      content: [{ type: "text", text: "partial complete" }],
      truncated: true,
    });
    session.completeItem(commandId, { status: "succeeded" });
    session.completeItem(toolId, { status: "succeeded" });
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    const toolUpdates = outputs.filter(
      ({ event }) => event.type === "item.updated" && event.itemId === toolId,
    );
    expect(toolUpdates).toHaveLength(2);
    expect(toolUpdates[1]?.event).toMatchObject({
      type: "item.updated",
      itemId: toolId,
      update: {
        type: "output.replace",
        output: {
          content: [{ type: "text", text: "partial complete" }],
          truncated: true,
        },
      },
    });
    expect(
      outputs.filter(
        ({ event }) => event.type === "item.completed" && event.snapshot.item.itemId === commandId,
      ),
    ).toHaveLength(1);
    expect(
      outputs.filter(
        ({ event }) => event.type === "item.completed" && event.snapshot.item.itemId === toolId,
      ),
    ).toHaveLength(1);
    const turnCompletedIndex = outputs.findIndex(({ event }) => event.type === "turn.completed");
    const lastItemCompletedIndex = outputs.findLastIndex(
      ({ event }) => event.type === "item.completed",
    );
    expect(turnCompletedIndex).toBeGreaterThan(lastItemCompletedIndex);
  });

  it("keeps a failed Tool local to an otherwise successful Turn", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("failed-tool"));
    const toolId = session.startToolExecution("failing_tool", {});
    session.replaceToolOutput(toolId, {
      content: [{ type: "text", text: "tool failed" }],
    });
    session.completeItem(toolId, { status: "failed", error: failure });
    session.appendText("recovered");
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    expect(outputs).toContainEqual({
      kind: "event",
      event: expect.objectContaining({
        type: "item.completed",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({ itemId: toolId }),
          outcome: { status: "failed", error: failure },
        }),
      }),
    });
    expect(outputs.at(-1)?.event).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(outputs.some(({ event }) => event.type === "session.faulted")).toBe(false);
  });

  it("accepts repeated cancellation and closes every Item before one cancelled terminal", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("cancelled"));
    session.startCommandExecution("sleep 10");
    const command = { type: "turn.cancel" as const, turnId: turnId("cancelled") };
    await expect(session.execute(command)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    await expect(session.execute(command)).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    session.completeCancellation();

    await expect(session.execute(textTurn("after-cancel"))).resolves.toMatchObject({ ok: true });
    session.appendText("continued");
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    const cancelledTerminals = outputs.filter(
      ({ event }) => event.type === "turn.completed" && event.turnId === "cancelled",
    );
    expect(cancelledTerminals).toHaveLength(1);
    expect(cancelledTerminals[0]?.event).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    const cancelledTurnIndex = outputs.findIndex(
      ({ event }) => event.type === "turn.completed" && event.turnId === "cancelled",
    );
    const cancelledItemIndexes = outputs
      .map(({ event }, index) => ({ event, index }))
      .filter(({ event }) => event.type === "item.completed" && event.turnId === "cancelled")
      .map(({ index }) => index);
    expect(cancelledItemIndexes.length).toBeGreaterThan(0);
    expect(cancelledItemIndexes.every((index) => index < cancelledTurnIndex)).toBe(true);
  });

  it("inspects a deterministic catalog without opening a Session", async () => {
    const adapter = new FakeHarnessAdapter();

    await expect(adapter.inspect({ cwd: "/synthetic", refresh: true })).resolves.toEqual({
      status: "ready",
      catalog: adapter.catalog,
      capabilities: { configuration: { selectModel: true } },
    });
    expect(adapter.inspectionCalls).toBe(1);
    expect(adapter.sessions).toHaveLength(0);
    await adapter.close();
  });

  it("publishes the selected effective Model before completing the command", async () => {
    const adapter = new FakeHarnessAdapter();
    const result = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const model = adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");

    const selecting = session.execute({ type: "model.select", model });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        event: {
          type: "session.state.changed",
          state: { effectiveModel: model },
        },
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    await session.close();
  });

  it("rejects Model writes during a Turn and preserves the confirmed state on failure", async () => {
    const adapter = new FakeHarnessAdapter();
    const result = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value as FakeHarnessSession;
    const original = session.state.effectiveModel;
    const model = adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");

    await session.execute(textTurn("active"));
    await expect(session.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(session.state.effectiveModel).toEqual(original);
    session.succeedTurn();

    session.rejectNextModelSelection(failure);
    await expect(session.execute({ type: "model.select", model })).resolves.toEqual({
      ok: false,
      error: failure,
    });
    expect(session.state.effectiveModel).toEqual(original);
    await session.close();
  });

  it("rejects a create Model that is outside the inspected catalog", async () => {
    const adapter = new FakeHarnessAdapter();

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        model: harnessModelRefSchema.parse({ id: "fake-model-v1.unknown" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(adapter.sessions).toHaveLength(0);
    await adapter.close();
  });

  it("closes every opened Session idempotently", async () => {
    const adapter = new FakeHarnessAdapter();
    await adapter.open({ kind: "create", cwd: "/synthetic" });
    await adapter.open({ kind: "create", cwd: "/synthetic" });

    await expect(Promise.all([adapter.close(), adapter.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
