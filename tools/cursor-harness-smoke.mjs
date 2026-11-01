import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CursorAdapter } from "../packages/adapters/cursor-cli/dist/index.js";

if (!process.argv[2]) throw new Error("Pass a dedicated absolute smoke workspace");
const cwd = path.resolve(process.argv[2]);
await mkdir(cwd, { recursive: true });
const receiptPath = path.join(cwd, "cursor-smoke-receipt.json");
const adapter = new CursorAdapter();
let session;
const outputs = [];
const terminals = new Map();
const timer = setTimeout(() => {
  console.error("Smoke deadline exceeded");
  void adapter.close();
  process.exitCode = 1;
}, 120_000);
try {
  const inspection = await adapter.inspect({ cwd });
  assert.equal(inspection.status, "ready", JSON.stringify(inspection));
  const resume = process.argv.includes("--resume")
    ? JSON.parse(await readFile(receiptPath, "utf8"))
    : undefined;
  const opened = await adapter.open(
    resume
      ? { kind: "resume", cwd, nativeRef: resume.nativeRef, knownTurnRefs: resume.turnRefs }
      : { kind: "create", cwd },
  );
  assert.equal(opened.ok, true, JSON.stringify(opened.ok ? {} : opened.error));
  session = opened.value;
  const collect = (async () => {
    for await (const output of session.outputs) {
      outputs.push(output);
      if (output.kind === "event" && output.event.type === "turn.completed") {
        terminals.get(output.event.turnId)?.(output.event);
        console.log(
          JSON.stringify({
            terminal: output.event.outcome.status,
            nativeTurnKey: output.event.nativeTurnRef?.nativeTurnKey,
          }),
        );
      }
      if (output.kind === "interaction") {
        console.log(
          JSON.stringify({ interaction: output.interaction.type, title: output.interaction.title }),
        );
        if (output.interaction.type === "approval") {
          const action = output.interaction.actions.find((action) => action.effect === "deny");
          assert.ok(action);
          await session.execute({
            type: "interaction.respond",
            interactionId: output.interaction.interactionId,
            response: { type: "approval", actionId: action.id },
          });
        }
      }
    }
  })();
  const run = async (text) => {
    const turnId = randomUUID();
    const terminal = new Promise((resolve) => terminals.set(turnId, resolve));
    const accepted = await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text }],
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const result = await terminal;
    assert.equal(result.outcome.status, "succeeded", JSON.stringify(result));
    assert.ok(result.nativeTurnRef);
    assert.equal(
      outputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.completed" &&
          output.event.turnId === turnId,
      ).length,
      1,
    );
    return result.nativeTurnRef;
  };
  const turnRefs = resume?.turnRefs ?? [];
  if (resume) {
    const snapshot = await session.readSnapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.deepEqual(
      snapshot.value.turns.map((turn) => turn.nativeTurnRef),
      turnRefs,
    );
    console.log(JSON.stringify({ resumeIdentity: true, turns: turnRefs.length }));
  }
  const chosen =
    inspection.catalog.models.find((model) => model.label === "composer-2.5") ??
    inspection.catalog.models[0];
  assert.equal((await session.execute({ type: "model.select", model: chosen.ref })).ok, true);
  for (const mode of ["ask", "plan", "agent"])
    assert.equal(
      (await session.execute({ type: "permissionMode.select", permissionModeId: mode })).ok,
      true,
    );
  turnRefs.push(
    await run(
      resume
        ? "What exact marker did I ask you to remember earlier? Reply with only that marker; use no tools."
        : "Remember the marker CURSOR_HOST_72941. Reply with exactly that marker and use no tools.",
    ),
  );
  if (!resume) turnRefs.push(await run("Reply with exactly CURSOR_SECOND_OK and use no tools."));
  const snapshot = await session.readSnapshot();
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.deepEqual(
    snapshot.value.turns.map((turn) => turn.nativeTurnRef),
    turnRefs,
  );
  const reply = snapshot.value.turns
    .at(-1)
    .items.filter((item) => item.item.type === "agentMessage")
    .map((item) => item.item.text)
    .join("");
  assert.equal(reply.trim(), resume ? "CURSOR_HOST_72941" : "CURSOR_SECOND_OK");
  const receipt = {
    nativeRef: session.initialState.nativeRef,
    turnRefs,
    models: inspection.catalog.models.length,
    modesRoundTrip: true,
    resumedInFreshProcess: Boolean(resume),
    lastReply: reply,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  await session.close();
  await collect;
  console.log(
    JSON.stringify({
      pass: true,
      models: receipt.models,
      turns: turnRefs.length,
      resumedInFreshProcess: Boolean(resume),
      lastReply: reply,
    }),
  );
} finally {
  clearTimeout(timer);
  await adapter.close();
}
