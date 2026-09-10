import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHarnessPlugins } from "../packages/host-runtime/dist/index.js";

const root = process.argv[2];
const cwd = path.resolve(process.argv[3]);
const diagnostics = [];
const registry = await loadHarnessPlugins({
  roots: [root],
  context: { environment: process.env, platform: process.platform, managedRemoteHost: false },
  diagnose: (value) => diagnostics.push(value),
});
assert.deepEqual(diagnostics, []);
assert.deepEqual(
  registry.list().map((item) => item.id),
  ["cursor-cli"],
);
const adapter = registry.adapters.get("cursor-cli");
const receipt = {
  pluginLoaded: true,
  permissionRequests: 0,
  permissionRejected: false,
  cancelTerminal: null,
  terminalCount: 0,
  nativeRef: null,
};
let session;
const deadline = setTimeout(() => {
  console.error("Control smoke timeout");
  void registry.close();
  process.exitCode = 1;
}, 120_000);
try {
  const inspection = await adapter.inspect({ cwd });
  assert.equal(inspection.status, "ready");
  const composer = inspection.catalog.models.find((model) => model.label === "composer-2.5");
  const opened = await adapter.open({
    kind: "create",
    cwd,
    ...(composer ? { model: composer.ref } : {}),
  });
  assert.equal(opened.ok, true, JSON.stringify(opened.ok ? {} : opened.error));
  session = opened.value;
  receipt.nativeRef = session.initialState.nativeRef;
  let phase = "permission";
  let resolveTurn;
  let cancelSent = false;
  const collect = (async () => {
    for await (const output of session.outputs) {
      if (output.kind === "interaction") {
        assert.equal(output.interaction.type, "approval");
        receipt.permissionRequests++;
        const action = output.interaction.actions.find((action) => action.effect === "deny");
        assert.ok(action);
        assert.equal(
          (
            await session.execute({
              type: "interaction.respond",
              interactionId: output.interaction.interactionId,
              response: { type: "approval", actionId: action.id },
            })
          ).ok,
          true,
        );
        receipt.permissionRejected = true;
      } else if (output.event.type === "turn.completed") {
        receipt.terminalCount++;
        resolveTurn(output.event);
      } else if (phase === "cancel" && !cancelSent && output.event.type === "item.updated") {
        cancelSent = true;
        assert.equal(
          (await session.execute({ type: "turn.cancel", turnId: output.event.turnId })).ok,
          true,
        );
      }
    }
  })();
  const run = async (text) => {
    const terminal = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    assert.equal(
      (
        await session.execute({
          type: "turn.start",
          turnId: randomUUID(),
          input: [{ type: "text", text }],
        })
      ).ok,
      true,
    );
    return terminal;
  };
  const permission = await run(
    "Use the Shell tool once to run this harmless PowerShell command: Write-Output CURSOR_PERMISSION_OK. If approval is denied, do not retry or use another tool; reply DENIED and stop.",
  );
  assert.equal(permission.outcome.status, "succeeded", JSON.stringify(permission));
  assert.ok(receipt.permissionRejected, "No real native permission request was observed");
  phase = "cancel";
  const cancelled = await run(
    "Without using tools, output all integers from 1 to 10000, one per line. Do not abbreviate the output.",
  );
  assert.equal(cancelled.outcome.status, "cancelled", JSON.stringify(cancelled));
  receipt.cancelTerminal = cancelled.outcome.status;
  receipt.cancelNativeTurnRef = cancelled.nativeTurnRef ?? null;
  await session.close();
  await collect;
  assert.equal(receipt.terminalCount, 2);
  await writeFile(
    path.join(cwd, "cursor-controls-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  clearTimeout(deadline);
  await registry.close();
}
