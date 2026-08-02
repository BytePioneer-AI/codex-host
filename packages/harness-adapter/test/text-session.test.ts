import { describe, expect, it } from "vitest";
import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import { HarnessOutputChannel } from "../src/index.js";
import type { HarnessError, HarnessOutput, HostEvent } from "../src/index.js";
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

function events(outputs: HarnessOutput[]): HostEvent[] {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
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
    expect(events(outputs).map(({ type }) => type)).toEqual([
      "turn.started",
      "item.started",
      "item.updated",
      "item.updated",
      "item.completed",
      "turn.completed",
    ]);
    expect(events(outputs)[4]).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "agentMessage", text: "first second" },
        outcome: { status: "succeeded" },
      },
    });
  });

  it("exposes visible Reasoning as a separate ordered textual Item", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("reasoning-turn"));
    const reasoningId = session.startReasoning("visible ");
    session.appendReasoning(reasoningId, "analysis");
    session.completeItem(reasoningId, { status: "succeeded" });
    session.appendText("answer");
    session.succeedTurn();
    await session.close();

    const hostEvents = events(await collected);
    expect(hostEvents.map(({ type }) => type)).toEqual([
      "turn.started",
      "item.started",
      "item.started",
      "item.updated",
      "item.updated",
      "item.completed",
      "item.updated",
      "item.completed",
      "turn.completed",
    ]);
    expect(hostEvents[5]).toMatchObject({
      type: "item.completed",
      snapshot: {
        item: { type: "reasoning", itemId: reasoningId, text: "visible analysis" },
        outcome: { status: "succeeded" },
      },
    });
  });

  it("publishes complete Session Usage replacements after a Turn terminal", async () => {
    const initialUsage = {
      totalTokens: 10,
      contextUsedTokens: 6,
      contextWindowTokens: 100,
    };
    const session = new FakeHarnessSession(
      harnessIdSchema.parse("fake"),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      initialUsage,
    );
    const collected = collect(session.outputs);

    expect(session.initialUsage).toEqual(initialUsage);
    expect(session.capabilities).not.toHaveProperty("usage");
    await session.execute(textTurn("usage-turn"));
    session.succeedTurn();
    session.publishUsage({ totalTokens: 12 }, turnId("usage-turn"));
    session.publishUsage(null);
    session.failUsageTelemetry();
    await session.close();

    const usageEvents = events(await collected).filter(
      (event) => event.type === "session.usage.changed",
    );
    expect(usageEvents).toEqual([
      {
        type: "session.usage.changed",
        usage: { totalTokens: 12 },
        observedForTurnId: "usage-turn",
      },
      { type: "session.usage.changed", usage: null },
    ]);
    expect(session.usageFailures).toBe(1);
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
    expect(events(outputs).filter(({ type }) => type === "turn.started")).toHaveLength(1);
    expect(events(outputs).filter(({ type }) => type === "turn.completed")).toHaveLength(1);
  });

  it("finishes the Item and Turn before a Session fault", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("faulted"));
    session.appendText("partial");
    session.fault(failure);

    expect(events(await collected).map(({ type }) => type)).toEqual([
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
    const toolUpdates = events(outputs).filter(
      (event) => event.type === "item.updated" && event.itemId === toolId,
    );
    expect(toolUpdates).toHaveLength(2);
    expect(toolUpdates[1]).toMatchObject({
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
    const hostEvents = events(outputs);
    expect(
      hostEvents.filter(
        (event) => event.type === "item.completed" && event.snapshot.item.itemId === commandId,
      ),
    ).toHaveLength(1);
    expect(
      hostEvents.filter(
        (event) => event.type === "item.completed" && event.snapshot.item.itemId === toolId,
      ),
    ).toHaveLength(1);
    const turnCompletedIndex = hostEvents.findIndex(({ type }) => type === "turn.completed");
    const lastItemCompletedIndex = hostEvents.findLastIndex(
      ({ type }) => type === "item.completed",
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
    expect(events(outputs).at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    expect(events(outputs).some(({ type }) => type === "session.faulted")).toBe(false);
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
    const hostEvents = events(outputs);
    const cancelledTerminals = hostEvents.filter(
      (event) => event.type === "turn.completed" && event.turnId === "cancelled",
    );
    expect(cancelledTerminals).toHaveLength(1);
    expect(cancelledTerminals[0]).toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    const cancelledTurnIndex = hostEvents.findIndex(
      (event) => event.type === "turn.completed" && event.turnId === "cancelled",
    );
    const cancelledItemIndexes = hostEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "item.completed" && event.turnId === "cancelled")
      .map(({ index }) => index);
    expect(cancelledItemIndexes.length).toBeGreaterThan(0);
    expect(cancelledItemIndexes.every((index) => index < cancelledTurnIndex)).toBe(true);
  });

  it("round-trips a typed choice Question and closes it before the Turn", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("question"));
    const interactionId = session.askQuestion({
      id: "decision",
      type: "choice",
      prompt: "Choose",
      options: [
        { value: "continue", label: "Continue" },
        { value: "stop", label: "Stop" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "question", answers: { decision: ["continue"] } },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    session.appendText("continued");
    session.succeedTurn();
    await session.close();

    const outputs = await collected;
    expect(outputs.find((output) => output.kind === "interaction")).toEqual({
      kind: "interaction",
      interaction: expect.objectContaining({
        type: "question",
        interactionId,
        turnId: "question",
        questions: [expect.objectContaining({ id: "decision", type: "choice" })],
      }),
    });
    const hostEvents = events(outputs);
    const closedIndex = hostEvents.findIndex(
      (event) => event.type === "interaction.closed" && event.interactionId === interactionId,
    );
    const completedIndex = hostEvents.findIndex(({ type }) => type === "turn.completed");
    expect(hostEvents[closedIndex]).toMatchObject({
      type: "interaction.closed",
      reason: "responded",
    });
    expect(closedIndex).toBeGreaterThan(
      hostEvents.findIndex(({ type }) => type === "turn.started"),
    );
    expect(closedIndex).toBeLessThan(completedIndex);
  });

  it("rejects malformed and duplicate Question responses without misrouting", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("validate-question"));
    const interactionId = session.askQuestion({
      id: "required",
      type: "choice",
      prompt: "Choose",
      options: [{ value: "known", label: "Known" }],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "question", answers: { required: ["unknown"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "question", answers: {}, cancelled: true },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    session.succeedTurn();
    await session.close();

    expect(
      events(await collected).filter(
        (event) => event.type === "interaction.closed" && event.interactionId === interactionId,
      ),
    ).toEqual([expect.objectContaining({ reason: "cancelled" })]);
  });

  it("expires a Question and rejects a late response", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("expired-question"));
    const interactionId = session.askQuestion({
      id: "text",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    session.expireQuestion(interactionId);
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId,
        response: { type: "question", answers: { text: ["late"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    session.succeedTurn();
    await session.close();

    expect(events(await collected)).toContainEqual(
      expect.objectContaining({
        type: "interaction.closed",
        interactionId,
        reason: "expired",
      }),
    );
  });

  it("closes a pending Question before cancellation and supports continuation", async () => {
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const collected = collect(session.outputs);

    await session.execute(textTurn("cancel-question"));
    const interactionId = session.askQuestion({
      id: "confirm",
      type: "choice",
      prompt: "Continue?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    await session.execute({ type: "turn.cancel", turnId: turnId("cancel-question") });
    session.completeCancellation();
    await expect(session.execute(textTurn("continued-after-question"))).resolves.toMatchObject({
      ok: true,
    });
    session.appendText("ok");
    session.succeedTurn();
    await session.close();

    const hostEvents = events(await collected);
    const closedIndex = hostEvents.findIndex(
      (event) => event.type === "interaction.closed" && event.interactionId === interactionId,
    );
    const terminalIndex = hostEvents.findIndex(
      (event) => event.type === "turn.completed" && event.turnId === "cancel-question",
    );
    expect(hostEvents[closedIndex]).toMatchObject({ reason: "cancelled" });
    expect(closedIndex).toBeLessThan(terminalIndex);
    expect(
      hostEvents.filter(
        (event) => event.type === "turn.completed" && event.turnId === "cancel-question",
      ),
    ).toHaveLength(1);
  });

  it("closes a pending Question before fault and Session close terminals", async () => {
    const faulted = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const faultedCollected = collect(faulted.outputs);
    await faulted.execute(textTurn("fault-question"));
    const faultedInteraction = faulted.askQuestion({
      id: "fault-value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: true,
      optional: false,
    });
    faulted.fault(failure);

    const faultEvents = events(await faultedCollected);
    const faultClosed = faultEvents.findIndex(
      (event) => event.type === "interaction.closed" && event.interactionId === faultedInteraction,
    );
    const faultTurn = faultEvents.findIndex(({ type }) => type === "turn.completed");
    const sessionFault = faultEvents.findIndex(({ type }) => type === "session.faulted");
    expect(faultClosed).toBeLessThan(faultTurn);
    expect(faultTurn).toBeLessThan(sessionFault);

    const closed = new FakeHarnessSession(harnessIdSchema.parse("fake"));
    const closedCollected = collect(closed.outputs);
    await closed.execute(textTurn("close-question"));
    const closedInteraction = closed.askQuestion({
      id: "close-value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    await closed.close();
    const closeEvents = events(await closedCollected);
    expect(
      closeEvents.findIndex(
        (event) => event.type === "interaction.closed" && event.interactionId === closedInteraction,
      ),
    ).toBeLessThan(closeEvents.findIndex(({ type }) => type === "turn.completed"));
  });

  it("inspects a deterministic catalog without opening a Session", async () => {
    const adapter = new FakeHarnessAdapter();

    await expect(adapter.inspect({ cwd: "/synthetic", refresh: true })).resolves.toEqual({
      status: "ready",
      catalog: adapter.catalog,
      capabilities: {
        configuration: { selectModel: true, selectThinkingOption: true },
        history: { fork: true, forkAcrossCwd: true },
      },
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

  it("keeps selectable aliases distinct from runtime-resolved Model display", async () => {
    const defaultRef = harnessModelRefSchema.parse({ id: "fake-model-v1.default" });
    const aliasRef = harnessModelRefSchema.parse({ id: "fake-model-v1.alias" });
    const catalog = harnessModelCatalogSchema.parse({
      models: [
        { ref: defaultRef, label: "Default", resolvedModelLabel: "runtime-custom" },
        { ref: aliasRef, label: "Family alias", resolvedModelLabel: "runtime-custom" },
      ],
      defaultModel: defaultRef,
      thinkingOptions: [],
    });
    const session = new FakeHarnessSession(harnessIdSchema.parse("fake"), catalog);
    const iterator = session.outputs[Symbol.asyncIterator]();

    expect(session.initialState).toMatchObject({
      effectiveModel: defaultRef,
      resolvedModelLabel: "runtime-custom",
    });
    const selecting = session.execute({ type: "model.select", model: aliasRef });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "session.state.changed",
          state: { effectiveModel: aliasRef, resolvedModelLabel: "runtime-custom" },
        },
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    await session.close();
  });

  it("publishes Model-dependent Thinking correction and selected Thinking before completion", async () => {
    const adapter = new FakeHarnessAdapter();
    const result = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const model = adapter.catalog.models[1]?.ref;
    const low = adapter.catalog.thinkingOptions.find(({ id }) => id === "low")?.id;
    if (!model || !low) throw new Error("Fake catalog is incomplete");

    const selectingModel = session.execute({ type: "model.select", model });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "session.state.changed",
          state: {
            effectiveModel: model,
            effectiveThinkingOptionId: "off",
            availableThinkingOptions: [
              { id: "off", label: "Off" },
              { id: "low", label: "Low" },
            ],
          },
        },
      },
    });
    await expect(selectingModel).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });

    const selectingThinking = session.execute({
      type: "thinking.select",
      thinkingOptionId: low,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        event: {
          type: "session.state.changed",
          state: { effectiveModel: model, effectiveThinkingOptionId: "low" },
        },
      },
    });
    await expect(selectingThinking).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });
    await session.close();
  });

  it("rejects Model and Thinking writes during a Turn and preserves confirmed state", async () => {
    const adapter = new FakeHarnessAdapter();
    const result = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value as FakeHarnessSession;
    const original = session.state.effectiveModel;
    const model = adapter.catalog.models[1]?.ref;
    const off = adapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!model || !off) throw new Error("Fake catalog is incomplete");

    await session.execute(textTurn("active"));
    await expect(session.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    await expect(
      session.execute({ type: "thinking.select", thinkingOptionId: off }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
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

  it("reads deterministic history and Forks an isolated derived Session", async () => {
    const adapter = new FakeHarnessAdapter();
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const source = opened.value as FakeHarnessSession;

    await source.execute(textTurn("source-1"));
    source.appendText("first");
    source.succeedTurn();
    await source.execute(textTurn("source-2"));
    source.appendText("second");
    source.succeedTurn();

    const firstRead = await source.readSnapshot();
    const repeatedRead = await source.readSnapshot();
    expect(repeatedRead).toEqual(firstRead);
    if (!firstRead.ok) throw new Error(firstRead.error.message);
    const checkpoint = firstRead.value.turns[0]?.checkpoint;
    const sourceRef = source.state.nativeRef;
    if (!checkpoint || !sourceRef) throw new Error("Fake source has no Fork identity");

    const forked = await adapter.open({
      kind: "fork",
      sourceRef,
      checkpoint,
      cwd: "/synthetic-worktree",
    });
    if (!forked.ok) throw new Error(forked.error.message);
    const derived = forked.value as FakeHarnessSession;
    expect(derived.cwd).toBe("/synthetic-worktree");
    const derivedRead = await derived.readSnapshot();
    if (!derivedRead.ok) throw new Error(derivedRead.error.message);

    expect(derived.state.nativeRef?.nativeSessionId).not.toBe(sourceRef.nativeSessionId);
    expect(derivedRead.value.turns).toHaveLength(1);
    expect(derivedRead.value.turns[0]?.nativeTurnRef).not.toEqual(
      firstRead.value.turns[0]?.nativeTurnRef,
    );
    expect(derivedRead.value.turns[0]?.items[0]?.item.itemId).not.toBe(
      firstRead.value.turns[0]?.items[0]?.item.itemId,
    );

    await derived.execute(textTurn("derived-2"));
    derived.appendText("derived");
    derived.succeedTurn();
    const sourceAfter = await source.readSnapshot();
    const derivedAfter = await derived.readSnapshot();
    expect(sourceAfter.ok && sourceAfter.value.turns).toHaveLength(2);
    expect(derivedAfter.ok && derivedAfter.value.turns).toHaveLength(2);

    const resumed = await adapter.open({ kind: "resume", nativeRef: sourceRef, cwd: "/synthetic" });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await expect(resumed.value.readSnapshot()).resolves.toEqual(sourceAfter);
    await adapter.close();
  });

  it("rejects a caller-selected Fork cwd when only same-cwd Fork is supported", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("fake"), undefined, true, false);
    const opened = await adapter.open({ kind: "create", cwd: "/source" });
    if (!opened.ok) throw new Error(opened.error.message);
    const source = opened.value as FakeHarnessSession;
    await source.execute(textTurn("source-only"));
    source.succeedTurn();
    const snapshot = await source.readSnapshot();
    const sourceRef = source.state.nativeRef;
    if (!snapshot.ok || !sourceRef || !snapshot.value.turns[0]?.checkpoint) {
      throw new Error("Fake source has no Fork identity");
    }

    await expect(
      adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: snapshot.value.turns[0].checkpoint,
        cwd: "/target",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(adapter.sessions).toHaveLength(1);

    await expect(
      adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: snapshot.value.turns[0].checkpoint,
        cwd: "/source",
      }),
    ).resolves.toMatchObject({ ok: true, value: { cwd: "/source" } });
    await adapter.close();
  });

  it("reports unsupported Fork without emitting Checkpoints", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("fake"), undefined, false);
    const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
    if (!opened.ok) throw new Error(opened.error.message);
    const source = opened.value as FakeHarnessSession;
    await source.execute(textTurn("no-fork"));
    source.succeedTurn();
    const snapshot = await source.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(source.capabilities.history.fork).toBe(false);
    expect(snapshot.value.turns[0]?.checkpoint).toBeUndefined();

    const sourceRef = source.state.nativeRef;
    if (!sourceRef) throw new Error("Fake source has no Native Ref");
    await expect(
      adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: {
          harnessId: sourceRef.harnessId,
          nativeSessionId: sourceRef.nativeSessionId,
          checkpointId: "missing",
          formatVersion: 1,
        },
        cwd: "/synthetic",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
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
