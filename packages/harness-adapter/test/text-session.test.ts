import { describe, expect, it } from "vitest";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

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
