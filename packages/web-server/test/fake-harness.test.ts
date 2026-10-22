import assert from "node:assert/strict";
import { it } from "node:test";
import { createHarnessAdapter } from "./fake-harness/fake/plugin.ts";

for (const type of ["approval", "question"])
  it(`scripted Harness retains an immediate ${type} response`, { timeout: 3000 }, async (t) => {
    const interactionId = `immediate-${type}`;
    globalThis.fakeHarnessScripts = {
      immediate: [
        { interaction: { type, interactionId } },
        { awaitResponse: interactionId },
        { event: { type: "turn.completed", outcome: { status: "succeeded" } } },
      ],
    };
    globalThis.fakeHarnessLog = [];
    const { value: session } = await createHarnessAdapter().open({ kind: "create" });
    t.after(async () => {
      await session.close();
      globalThis.fakeHarnessScripts = undefined;
      globalThis.fakeHarnessLog = undefined;
    });
    const outputs = session.outputs[Symbol.asyncIterator]();
    await session.execute({
      type: "turn.start",
      turnId: "turn",
      input: [{ type: "text", text: "immediate" }],
    });
    assert.deepEqual((await outputs.next()).value, {
      kind: "event",
      event: { type: "turn.started", turnId: "turn" },
    });
    assert.deepEqual((await outputs.next()).value, {
      kind: "interaction",
      interaction: { type, interactionId, turnId: "turn" },
    });
    // Respond in the same microtask, before play() reaches its awaitResponse step.
    const response = { type, test: "immediate answer" };
    await session.execute({ type: "interaction.respond", interactionId, response });
    assert.deepEqual((await outputs.next()).value, {
      kind: "event",
      event: { type: "interaction.closed", interactionId, reason: "responded" },
    });
    assert.deepEqual((await outputs.next()).value, {
      kind: "event",
      event: { type: "turn.completed", turnId: "turn", outcome: { status: "succeeded" } },
    });
    assert.deepEqual(
      globalThis.fakeHarnessLog.find((entry) => entry.responded === interactionId)?.response,
      response,
    );
  });
