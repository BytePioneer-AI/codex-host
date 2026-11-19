import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { observeSteerDelivery } from "./delivery.mjs";
import { OmpAdapter } from "@codexhost/adapter-omp";
import { PiAdapter } from "@codexhost/adapter-pi";

// Opt in per Harness. Uses existing authentication and the selected Model, real model quota,
// and native Session storage. Only the synthetic working directory is removed after the test.
const selected = new Set((process.env.CODEXHOST_STEER_REAL_HARNESSES ?? "").split(","));
const scenarios = (
  process.env.CODEXHOST_STEER_REAL_SCENARIOS ?? "single,double,near-terminal"
).split(",");
for (const name of scenarios)
  assert.ok(["single", "double", "near-terminal"].includes(name), `Unknown scenario: ${name}`);

const adapters = {
  omp: () => new OmpAdapter(),
  pi: () => new PiAdapter(),
};

async function bounded(promise, label, timeoutMs = 90_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function succeeded(result) {
  assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.error));
  return result.value;
}

class Collector {
  outputs = [];
  failure;
  constructor(session) {
    this.done = (async () => {
      for await (const output of session.outputs) {
        this.outputs.push({ ...output, observedAtMs: Date.now() });
        if (output.kind === "interaction") {
          const interaction = output.interaction;
          assert.equal(interaction.type, "approval", "Unexpected native question");
          const action = interaction.actions.find(({ effect }) => effect === "allowOnce");
          assert.ok(action, "Native approval has no allow-once action");
          succeeded(
            await session.execute({
              type: "interaction.respond",
              interactionId: interaction.interactionId,
              response: { type: "approval", actionId: action.id },
            }),
          );
        }
      }
    })().catch((error) => {
      this.failure = error;
    });
  }

  events(from) {
    return this.outputs
      .slice(from)
      .flatMap((output) => (output.kind === "event" ? [output.event] : []));
  }

  async wait(from, predicate, label) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      const events = this.events(from);
      const found = events.find(predicate);
      if (found) return found;
      const fault = events.find(({ type }) => type === "session.faulted");
      if (fault) throw new Error(JSON.stringify(fault.error));
      const terminal = events.find(({ type }) => type === "turn.completed");
      if (terminal)
        throw new Error(`Turn ended before ${label}: ${JSON.stringify(terminal.outcome)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${label}`);
  }
}

async function scenario(session, collector, receipt) {
  const { name } = receipt;
  const from = collector.outputs.length;
  const turnId = randomUUID();
  const inputMarker = `START_${randomUUID().replaceAll("-", "")}`;
  const toolMarker = `TOOL_DONE_${randomUUID().replaceAll("-", "")}`;
  const answerMarker = `STEER_${randomUUID().replaceAll("-", "")}`;
  const prompt = `${inputMarker}. Run exactly one foreground shell command: sleep 8; printf '${toolMarker}\\n'. Wait for it to finish. Then follow the latest user instruction. Do not read or modify files or use other tools.`;
  Object.assign(receipt, { turnId, inputMarker, toolMarker, answerMarker, steers: [] });
  succeeded(
    await bounded(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: prompt }] }),
      "turn.start",
    ),
  );
  const tool = await collector.wait(
    from,
    (event) =>
      event.type === "item.started" &&
      (event.item.type === "commandExecution" || event.item.type === "toolExecution") &&
      JSON.stringify(event.item).includes(toolMarker),
    "foreground sleep tool",
  );
  assert.equal(session.capabilities.steer, true, "Adapter did not confirm the active steer window");

  for (const input of [
    { turnId: randomUUID(), text: "Do not deliver this wrong-target message." },
    { turnId, text: "" },
  ]) {
    const rejected = await session.execute({
      type: "turn.steer",
      turnId: input.turnId,
      input: [{ type: "text", text: input.text }],
    });
    assert.equal(rejected.ok, false, "Invalid steer was accepted");
    assert.equal(rejected.error.code, input.text ? "invalidState" : "invalidRequest");
  }

  const toolDone = () =>
    collector.wait(
      from,
      (event) => event.type === "item.completed" && event.snapshot.item.itemId === tool.item.itemId,
      "foreground tool completion",
    );
  if (name === "near-terminal") await toolDone();
  const count = name === "double" ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    const text =
      index === count - 1
        ? `After the current shell command finishes, reply with exactly ${answerMarker}. Do not cancel it or run more tools.`
        : "Keep waiting for the current shell command. A second instruction follows; do not run more tools.";
    const result = await bounded(
      session.execute({ type: "turn.steer", turnId, input: [{ type: "text", text }] }),
      "turn.steer receipt",
      30_000,
    );
    receipt.steers.push({ ...result, observedAtMs: Date.now() });
    if (name === "near-terminal" && !result.ok) {
      assert.equal(result.error.code, "invalidState");
    } else succeeded(result);
  }
  const completedTool = await toolDone();
  assert.equal(completedTool.snapshot.outcome.status, "succeeded", "Steering interrupted the tool");
  assert.ok(
    JSON.stringify(completedTool.snapshot.item).includes(toolMarker),
    "Tool did not finish its command",
  );
  const terminal = await collector.wait(
    from,
    (event) => event.type === "turn.completed" && event.turnId === turnId,
    "Turn completion",
  );
  assert.equal(terminal.outcome.status, "succeeded", JSON.stringify(terminal.outcome));
  if (name === "near-terminal") {
    receipt.delivery = await observeSteerDelivery(
      () => collector.events(from),
      answerMarker,
      turnId,
    );
    if (collector.failure) throw collector.failure;
  }
  const events = collector.events(from);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "turn.started" && (name !== "near-terminal" || event.turnId === turnId),
    ).length,
    1,
    "Steer opened a second Host Turn",
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "turn.completed" && (name !== "near-terminal" || event.turnId === turnId),
    ).length,
    1,
  );
  const replies = events
    .filter(
      (event) => event.type === "item.completed" && event.snapshot.item.type === "agentMessage",
    )
    .map((event) => event.snapshot.item.text)
    .join("\n");
  if (name !== "near-terminal" && receipt.steers.every((result) => result.ok)) {
    assert.ok(replies.includes(answerMarker), "Accepted input was not used in the same Turn");
  }
  const snapshot = succeeded(await session.readSnapshot());
  receipt.history = snapshot;
  if (name === "near-terminal") {
    const expected = receipt.steers.every((result) => result.ok) ? 1 : 0;
    assert.equal(
      receipt.delivery.replies.length,
      expected,
      "Accepted input must execute exactly once in the observation window",
    );
    for (const reply of receipt.delivery.replies) {
      assert.equal(reply.placement, "targetTurn", "Accepted steer ran outside its target Turn");
      assert.equal(
        reply.outcome?.status,
        "succeeded",
        "The delivery Turn has not completed successfully",
      );
    }
  }
  const original = snapshot.turns.find((turn) =>
    turn.input.some(({ text }) => text.includes(inputMarker)),
  );
  assert.ok(original, "Original input missing from native history");
  assert.deepEqual(
    terminal.nativeTurnRef,
    original.nativeTurnRef,
    "Turn identity bound to steered input",
  );
  const late = await session.execute({
    type: "turn.steer",
    turnId,
    input: [{ type: "text", text: "Do not deliver after completion." }],
  });
  assert.equal(late.ok, false, "Completed Turn accepted a steer");
  assert.equal(late.error.code, "invalidState");
  Object.assign(receipt, { status: "passed", nativeTurnRef: terminal.nativeTurnRef });
}

for (const [id, createAdapter] of Object.entries(adapters)) {
  describe.runIf(selected.has(id))(`${id} real native steering`, () => {
    it("accepts single and consecutive input, exercises terminal timing and rejects invalid targets", async (context) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), `codexhost-steer-${id}-`));
      const reportDirectory = path.resolve(".codexhost", "native-steer-real", id);
      await mkdir(reportDirectory, { recursive: true });
      const report = {
        harness: id,
        cwd,
        startedAt: new Date().toISOString(),
        status: "running",
        scenarios: [],
      };
      const adapter = createAdapter();
      let collector;
      try {
        const inspection = await bounded(adapter.inspect({ cwd }), "Harness inspect", 45_000);
        if (inspection.status !== "ready") {
          report.status = "blocked";
          report.error = inspection.error;
          context.skip(JSON.stringify(inspection.error));
        }
        const requestedModel = process.env.CODEXHOST_STEER_REAL_MODEL;
        const selectedModel = requestedModel
          ? inspection.catalog.models.find(
              (model) => model.nativeId === requestedModel || model.label === requestedModel,
            )
          : undefined;
        if (requestedModel)
          assert.ok(selectedModel, `Model not in native catalog: ${requestedModel}`);
        report.model = selectedModel?.ref ?? inspection.catalog.defaultModel;
        report.requestedModel = requestedModel;
        const opened = await bounded(
          adapter.open({
            kind: "create",
            cwd,
            ...(selectedModel ? { model: selectedModel.ref } : {}),
          }),
          "Harness open",
          45_000,
        );
        if (!opened.ok) {
          report.status = "blocked";
          report.error = opened.error;
          context.skip(JSON.stringify(opened.error));
        }
        const session = opened.value;
        collector = new Collector(session);
        for (const name of scenarios) {
          report.activeScenario = name;
          const receipt = { name, status: "running" };
          report.scenarios.push(receipt);
          await scenario(session, collector, receipt);
        }
        report.status = "passed";
      } catch (error) {
        if (report.status !== "blocked") {
          report.status = "failed";
          const active = report.scenarios.at(-1);
          if (active?.status === "running") active.status = "failed";
          report.error = error instanceof Error ? error.message : String(error);
        }
        throw error;
      } finally {
        try {
          await bounded(adapter.close(), "Adapter close", 30_000);
          if (collector) await bounded(collector.done, "Output consumer close", 5_000);
        } finally {
          report.outputs = collector?.outputs ?? [];
          await writeFile(
            path.join(reportDirectory, `${Date.now()}.json`),
            `${JSON.stringify(report, null, 2)}\n`,
          );
          await rm(cwd, { recursive: true, force: true });
        }
      }
    }, 360_000);
  });
}
