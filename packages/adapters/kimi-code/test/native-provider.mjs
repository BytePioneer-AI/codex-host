// Opt-in integration: actual Kimi 2.0.2, isolated profile, loopback-only synthetic Provider.
// Run after building the package. No user credentials or remote model calls are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KimiCodeAdapter } from "../dist/index.js";
import { startKimiTransport } from "../dist/transport.js";

const root = await mkdtemp(path.join(tmpdir(), "codexhost-kimi-provider-"));
const cwd = path.join(root, "workspace"),
  profile = path.join(root, "profile");
await Promise.all([mkdir(cwd), mkdir(profile)]);
const requests = [];
const providerErrors = [];
const releaseStreams = [];
const heldConnectionClosed = Promise.withResolvers();
const answer = "Native loop verified.";
const provider = createServer((request, response) => {
  void (async () => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      assert.ok(body.length < 2 * 1024 * 1024, "Synthetic request exceeds 2 MiB");
    }
    const data = JSON.parse(body || "{}");
    requests.push({ route: request.url, model: data.model, stream: data.stream });
    assert.ok(requests.length <= 6, "Unexpected Provider request loop");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(data.model, "smoke");
    assert.equal(data.stream, true);
    const chunk = {
      id: `chatcmpl-local-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "smoke",
    };
    const send = (delta, finish_reason = null, usage) =>
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length === 5) {
      // Never send a finish_reason or [DONE]; only a genuine native abort can end this response.
      response.once("close", () => heldConnectionClosed.resolve());
      send({ role: "assistant", content: "Holding " });
      await heldConnectionClosed.promise;
      return;
    }
    if (requests.length === 2 || requests.length === 3) {
      const name = requests.length === 2 ? "Write" : "AskUserQuestion";
      const tool = data.tools?.find((entry) => entry.function?.name === name)?.function;
      assert.ok(tool, "Native request did not advertise " + name);
      const args =
        name === "Write"
          ? { path: "native-probe.txt", content: "isolated native tool verified\n" }
          : {
              questions: [
                {
                  question: "Which test result should be recorded?",
                  header: "Probe",
                  options: [{ label: "Confirmed" }, { label: "Retry" }],
                  multi_select: false,
                },
              ],
              background: false,
            };
      for (const key of tool.parameters.required ?? [])
        assert.ok(key in args, "Missing advertised tool argument " + key);
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_" + name,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
      response.end("data: [DONE]\n\n");
      return;
    }
    if (requests.length === 4) {
      const toolResult = data.messages.filter((message) => message.role === "tool").at(-1);
      assert.ok(
        JSON.stringify(toolResult).includes("Confirmed"),
        "Native question answer did not reach Provider",
      );
    }
    const partialObserved = new Promise((resolve) => releaseStreams.push(resolve));
    send({ role: "assistant", content: "Native " });
    // Release the rest only after the public output stream exposes the first fragment.
    await partialObserved;
    send({ content: "loop verified." });
    send({}, "stop", { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
    response.end("data: [DONE]\n\n");
  })().catch((error) => {
    providerErrors.push(error instanceof Error ? error.message : "Synthetic Provider failed");
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const allowed = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "userprofile",
  "localappdata",
  "appdata",
  "programfiles",
  "programfiles(x86)",
]);
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
  ),
  KIMI_CODE_HOME: profile,
  NO_COLOR: "1",
};
const adapter = new KimiCodeAdapter({ environment });
const report = {
  native: "2.0.2",
  provider: "local deterministic OpenAI-compatible SSE fixture",
  isolatedProfile: true,
  isolatedCwd: true,
  externalModelCalls: 0,
};

async function runTurn(
  session,
  turnId,
  withTools = false,
  iterator = session.outputs[Symbol.asyncIterator](),
) {
  let approvals = 0,
    questions = 0;
  const outputs = [];
  const completed = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const output = next.value;
      outputs.push(output);
      if (output.kind === "interaction") {
        const interaction = output.interaction;
        const response =
          interaction.type === "approval"
            ? {
                type: "approval",
                actionId: interaction.actions.find((action) => action.effect === "allowOnce")?.id,
              }
            : {
                type: "question",
                answers: Object.fromEntries(
                  interaction.questions.map((question) => [
                    question.id,
                    [question.options[0].value],
                  ]),
                ),
              };
        if (interaction.type === "approval") approvals++;
        else questions++;
        const responded = await session.execute({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response,
        });
        assert.equal(responded.ok, true, JSON.stringify(responded));
      }
      if (
        output.kind === "event" &&
        output.event.type === "item.started" &&
        output.event.item.type === "agentMessage" &&
        output.event.item.text === "Native "
      )
        releaseStreams.at(-1)?.();
      if (output.kind === "event" && output.event.type === "turn.completed") return output.event;
    }
    throw new Error("Native output stream ended before turn completion");
  })();
  const timeout = setTimeout(() => {
    void session.close();
  }, 15_000);
  try {
    const accepted = await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "Reply with a short acknowledgement." }],
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const end = await completed;
    assert.equal(end.outcome.status, "succeeded", JSON.stringify(end));
    assert.ok(end.nativeTurnRef);
    const starts = outputs.filter(
      (output) =>
        output.kind === "event" &&
        output.event.type === "item.started" &&
        output.event.item.type === "agentMessage",
    );
    const updates = outputs.filter(
      (output) =>
        output.kind === "event" &&
        output.event.type === "item.updated" &&
        output.event.update.type === "text.append",
    );
    const items = outputs
      .filter((output) => output.kind === "event" && output.event.type === "item.completed")
      .map((output) => output.event.snapshot);
    assert.equal(starts.length, 1);
    assert.ok(updates.length > 0, "Native streaming partial text was not observed");
    assert.equal(
      starts[0].event.item.text + updates.map((output) => output.event.update.text).join(""),
      answer,
    );
    assert.equal(
      items.find((snapshot) => snapshot.item.type === "agentMessage")?.item.text,
      answer,
    );
    const history = await session.readSnapshot();
    assert.equal(history.ok, true, JSON.stringify(history));
    const turn = history.value.turns.at(-1);
    assert.deepEqual(turn.nativeTurnRef, end.nativeTurnRef);
    assert.deepEqual(turn.items, items);
    assert.equal(turn.outcome.status, "succeeded");
    if (withTools) {
      assert.equal(approvals, 1, "Expected one native file-write approval");
      assert.equal(questions, 1, "Expected one native question");
      assert.equal(
        await readFile(path.join(cwd, "native-probe.txt"), "utf8"),
        "isolated native tool verified\n",
      );
      assert.equal(items.filter((snapshot) => snapshot.item.type === "toolExecution").length, 2);
      Object.assign(report, { nativeTool: true, nativeApproval: true, nativeQuestion: true });
    }
    return history.value;
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelThenContinue(session) {
  const iterator = session.outputs[Symbol.asyncIterator]();
  const turnId = "native-provider-cancelled";
  const outputs = [];
  let requested = false;
  const timeout = setTimeout(() => {
    void session.close();
  }, 15_000);
  try {
    const started = await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "Hold the local response for cancellation." }],
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false, "Session closed before a native cancellation terminal");
      const output = next.value;
      outputs.push(output);
      if (output.kind !== "event") continue;
      if (
        output.event.type === "item.started" &&
        output.event.item.type === "agentMessage" &&
        output.event.item.text === "Holding "
      ) {
        assert.equal(requested, false);
        requested = true;
        const cancelling = session.execute({ type: "turn.cancel", turnId });
        const premature = await session.execute({
          type: "turn.start",
          turnId: "must-not-start",
          input: [{ type: "text", text: "Premature continuation must be rejected." }],
        });
        assert.equal(premature.ok, false);
        assert.equal(premature.error.code, "sessionBusy");
        assert.deepEqual(await cancelling, { ok: true, value: { cancellationRequested: true } });
      }
      if (output.event.type === "turn.completed") {
        assert.equal(requested, true);
        assert.equal(output.event.turnId, turnId);
        assert.equal(output.event.outcome.status, "cancelled", JSON.stringify(output.event));
        assert.ok(
          output.event.nativeTurnRef,
          "A forced close is not evidence of native cancellation",
        );
        break;
      }
    }
    await heldConnectionClosed.promise;
    assert.ok(
      !outputs.some((output) => output.kind === "event" && output.event.type === "session.faulted"),
    );
    const snapshot = await session.readSnapshot();
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.equal(snapshot.value.turns.at(-1).outcome.status, "cancelled");
    assert.equal(snapshot.value.turns.length, 3);
    // Keep the same public Session and the same AsyncIterator after the native terminal.
    const continued = await runTurn(session, "native-provider-after-cancel", false, iterator);
    assert.equal(continued.turns.length, 4);
    assert.equal(continued.turns[2].outcome.status, "cancelled");
    assert.equal(continued.turns[3].outcome.status, "succeeded");
    Object.assign(report, {
      nativeCancellation: true,
      cancelledStreamClosed: true,
      cancellationBusyGuard: true,
      sameSessionContinuation: true,
      sameOutputConsumer: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const setup = await startKimiTransport({ cwd, environment });
  try {
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    await setup.request("/api/v1/providers", "POST", {
      id: "local",
      type: "openai",
      api_key: "synthetic-local-only",
      base_url: `http://127.0.0.1:${address.port}/v1`,
      models: [{ model: "smoke", max_context_size: 131072, max_output_size: 4096 }],
    });
    const models = await setup.request("/api/v1/models");
    assert.equal(models.items.length, 1);
    assert.equal(models.items[0].model, "local/smoke");
    await setup.request("/api/v1/config", "POST", {
      default_model: models.items[0].model,
      default_provider: "local",
      telemetry: false,
    });
  } finally {
    await setup.close();
  }
  const inspection = await adapter.inspect({ cwd });
  assert.equal(inspection.status, "ready", JSON.stringify(inspection));
  assert.ok(inspection.catalog.defaultModel);
  // Native 2.0.2 does not apply the global default to an unconfigured new Session.
  // Exercise delegation's omitted model: the Adapter must apply the native configured default.
  const opened = await adapter.open({
    kind: "create",
    cwd,
    executionPolicy: "unattended-full-access",
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const ref = opened.value.initialState.nativeRef;
  assert.ok(ref);
  assert.deepEqual(opened.value.initialState.effectiveModel, inspection.catalog.defaultModel);
  assert.equal(opened.value.initialState.effectivePermissionModeId, "yolo");
  const first = await runTurn(opened.value, "native-provider-first");
  assert.equal(first.turns.length, 1);
  await opened.value.close();
  const resumed = await adapter.open({ kind: "resume", cwd, nativeRef: ref });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  // Retain the existing manual approval coverage after proving unattended creation.
  assert.equal(
    (await resumed.value.execute({ type: "permissionMode.select", permissionModeId: "manual" })).ok,
    true,
  );
  const restored = await resumed.value.readSnapshot();
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual(restored.value.turns[0].nativeTurnRef, first.turns[0].nativeTurnRef);
  assert.deepEqual(restored.value.turns[0].items, first.turns[0].items);
  const second = await runTurn(resumed.value, "native-provider-second", true);
  assert.equal(second.turns.length, 2);
  assert.deepEqual(second.turns[0].nativeTurnRef, first.turns[0].nativeTurnRef);
  assert.deepEqual(second.turns[0].items, first.turns[0].items);
  assert.equal(requests.length, 4);
  assert.deepEqual(providerErrors, []);
  await resumed.value.close();
  const reloaded = await adapter.open({ kind: "resume", cwd, nativeRef: ref });
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded));
  const persisted = await reloaded.value.readSnapshot();
  assert.equal(persisted.ok, true, JSON.stringify(persisted));
  assert.deepEqual(
    persisted.value.turns.map(({ nativeTurnRef, items }) => ({ nativeTurnRef, items })),
    second.turns.map(({ nativeTurnRef, items }) => ({ nativeTurnRef, items })),
  );
  await cancelThenContinue(reloaded.value);
  assert.equal(requests.length, 6);
  assert.deepEqual(providerErrors, []);
  await reloaded.value.close();
  Object.assign(report, {
    ready: true,
    delegationNativeDefault: true,
    successfulTurns: 3,
    cancelledTurns: 1,
    streamingText: true,
    liveHistoryItemsEqual: true,
    nonemptyResume: true,
    persistedToolHistory: true,
  });
} finally {
  // Diagnostics contain only request count/routing, never headers or prompt bodies.
  Object.assign(report, { providerRequests: requests.length, providerErrors });
  await adapter.close();
  for (const release of releaseStreams) release();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  const resolved = path.resolve(root);
  assert.ok(
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith("codexhost-kimi-provider-"),
  );
  await rm(resolved, { recursive: true, force: true });
  console.log(JSON.stringify({ ...report, cleanup: true }));
}
