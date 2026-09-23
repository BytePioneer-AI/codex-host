// Opt-in real MiMo CLI + deterministic localhost model. No user auth/history.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { MimoAdapter } from "../dist/adapter.js";

const root = await mkdtemp(path.join(tmpdir(), "codexhost-mimo-loop-"));
const cwd = path.join(root, "workspace");
const profile = path.join(root, "profile");
await Promise.all([mkdir(cwd), mkdir(profile)]);
let requests = 0;
let holdNext = false;
let held;
const pendingCalls = [];
let providerError;
const requestedModels = [];
const resumedMarker = "mimo-isolated-resumed-environment";
const markerCommand =
  process.platform === "win32"
    ? "Write-Output ($env:CODEXHOST_MIMO_SMOKE_MARKER + '|' + (Get-Location).Path)"
    : 'printf \'%s|%s\\n\' "$CODEXHOST_MIMO_SMOKE_MARKER" "$PWD"';
const mock = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body || "{}");
  requestedModels.push(data.model);
  requests++;
  if (requests > 20 || !request.url.endsWith("/chat/completions")) {
    response.writeHead(429);
    response.end();
    return;
  }
  const chunk = {
    id: `chatcmpl-test-${requests}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "smoke",
  };
  if (data.stream) {
    const isMainRequest = data.tools?.some((tool) => tool.function?.name !== "StructuredOutput");
    if (isMainRequest && pendingCalls.length) {
      const call = pendingCalls.shift();
      const schema = data.tools.find((tool) => tool.function?.name === call.name)?.function
        .parameters;
      if (
        !schema ||
        Object.keys(call.arguments).some((key) => !(key in (schema.properties ?? {}))) ||
        schema.required?.some((key) => !(key in call.arguments))
      ) {
        providerError = new Error(
          `Native advertised schema does not support isolated ${call.name} call`,
        );
        response.writeHead(500);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_smoke_${call.name}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Native loop verified." }, finish_reason: null }] })}\n\n`,
    );
    if (holdNext) {
      holdNext = false;
      held = response;
      return;
    }
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  } else {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ...chunk,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Native loop verified." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    );
  }
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
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
  MIMOCODE_HOME: profile,
  MIMOCODE_PURE: "true",
  MIMOCODE_MIMO_ONLY: "true",
  MIMOCODE_DISABLE_AUTOUPDATE: "true",
  MIMOCODE_DISABLE_CLAUDE_CODE: "true",
  MIMOCODE_CONFIG_CONTENT: JSON.stringify({
    model: "local/smoke",
    small_model: "local/smoke",
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Isolated local stub",
        options: {
          baseURL: `http://127.0.0.1:${mock.address().port}/v1`,
          apiKey: "synthetic-local-only",
          timeout: 10000,
        },
        models: {
          smoke: { name: "Smoke", limit: { context: 128000, output: 1024 } },
          alternate: { name: "Alternate", limit: { context: 128000, output: 1024 } },
        },
      },
    },
  }),
};
const adapter = new MimoAdapter({
  environment,
  command: path.join(
    homedir(),
    ".mimocode",
    "bin",
    process.platform === "win32" ? "mimo.exe" : "mimo",
  ),
});
function observe(session) {
  const outputs = [];
  void (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return outputs;
}
async function until(predicate) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Isolated native test timed out");
}
async function turn(session, outputs, id, cancel = false, interactions = false) {
  holdNext = cancel;
  held = undefined;
  assert.equal(
    (
      await session.execute({
        type: "turn.start",
        turnId: id,
        input: [{ type: "text", text: "Reply briefly." }],
      })
    ).ok,
    true,
  );
  if (cancel) {
    await until(() => held);
    assert.equal((await session.execute({ type: "turn.cancel", turnId: id })).ok, true);
    const conflict = await session.execute({
      type: "turn.start",
      turnId: "too-early",
      input: [{ type: "text", text: "Do not run" }],
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "sessionBusy");
  }
  const answered = new Set();
  let result;
  do {
    result = await until(() => {
      if (providerError) throw providerError;
      return (
        outputs.find(
          (output) =>
            interactions &&
            output.kind === "interaction" &&
            output.interaction.turnId === id &&
            !answered.has(output.interaction.interactionId),
        ) ??
        outputs.find(
          (output) =>
            output.kind === "event" &&
            output.event.type === "turn.completed" &&
            output.event.turnId === id,
        )
      );
    });
    if (result.kind === "interaction") {
      const interaction = result.interaction;
      assert.ok(answered.size < 4, "Unexpected repeated synthetic interactions");
      let answer;
      if (interaction.type === "approval") {
        assert.equal(interaction.title, "bash");
        assert.match(interaction.description, /CODEXHOST_MIMO_SMOKE_MARKER|Write-Output|printf/u);
        answer = { type: "approval", actionId: "once" };
      } else {
        assert.equal(interaction.questions.length, 1);
        assert.equal(interaction.questions[0].prompt, "Confirm the isolated smoke marker.");
        assert.equal(interaction.questions[0].options[0].value, "Verified");
        answer = { type: "question", answers: { [interaction.questions[0].id]: ["Verified"] } };
      }
      const response = await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: answer,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      answered.add(interaction.interactionId);
    }
  } while (result.kind === "interaction");
  assert.equal(
    result.event.outcome.status,
    cancel ? "cancelled" : "succeeded",
    JSON.stringify(result.event),
  );
}
try {
  const inspection = await adapter.inspect({ cwd });
  assert.equal(inspection.status, "ready");
  assert.equal(inspection.capabilities.configuration.selectModel, true);
  const alternate = inspection.catalog.models.find((model) => model.label === "Alternate").ref;
  const opened = await adapter.open({
    kind: "create",
    cwd,
    permissionModeId: "ask",
    environment: { CODEXHOST_MIMO_SMOKE_MARKER: "initial-marker" },
  });
  assert.equal(opened.ok, true);
  let session = opened.value;
  let outputs = observe(session);
  assert.equal((await session.execute({ type: "model.select", model: alternate })).ok, true);
  await turn(session, outputs, "host-first");
  assert.ok(requestedModels.includes("alternate"));
  const ref = session.initialState.nativeRef;
  const first = await session.readSnapshot();
  assert.equal(first.ok, true);
  assert.equal(first.value.turns.length, 1);
  assert.deepEqual(first.value.state.effectiveModel, alternate);
  await session.close();
  const resumed = await adapter.open({
    kind: "resume",
    cwd,
    nativeRef: ref,
    environment: { CODEXHOST_MIMO_SMOKE_MARKER: resumedMarker },
  });
  assert.equal(resumed.ok, true);
  session = resumed.value;
  assert.deepEqual(session.initialState.effectiveModel, alternate);
  outputs = observe(session);
  await turn(session, outputs, "host-resumed");
  const second = await session.readSnapshot();
  assert.equal(second.ok, true);
  assert.equal(second.value.turns.length, 2);
  assert.deepEqual(second.value.turns[0].nativeTurnRef, first.value.turns[0].nativeTurnRef);
  await turn(session, outputs, "host-cancel", true);
  await turn(session, outputs, "host-after-cancel");
  pendingCalls.push(
    {
      name: "bash",
      arguments: {
        command: markerCommand,
        description: "Print isolated environment and working directory",
        workdir: cwd,
        timeout: 10000,
      },
    },
    {
      name: "question",
      arguments: {
        questions: [
          {
            question: "Confirm the isolated smoke marker.",
            header: "Smoke",
            options: [{ label: "Verified", description: "Synthetic test answer" }],
          },
        ],
      },
    },
  );
  await turn(session, outputs, "host-native-tools", false, true);
  assert.equal(pendingCalls.length, 0);
  const nativeTool = outputs.find(
    (output) =>
      output.kind === "event" &&
      output.event.type === "item.completed" &&
      output.event.turnId === "host-native-tools" &&
      output.event.snapshot.item.type === "commandExecution",
  );
  assert.ok(nativeTool, "Missing native command projection");
  assert.equal(nativeTool.event.snapshot.outcome.status, "succeeded");
  assert.ok(
    nativeTool.event.snapshot.item.output.includes(`${resumedMarker}|${cwd}`),
    "Native tool did not receive this open's environment and cwd",
  );
  const nativeInteractions = outputs.filter(
    (output) => output.kind === "interaction" && output.interaction.turnId === "host-native-tools",
  );
  assert.deepEqual(
    nativeInteractions.map((output) => output.interaction.type),
    ["approval", "question"],
  );
  for (const { interaction } of nativeInteractions)
    assert.equal(
      outputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "interaction.closed" &&
          output.event.interactionId === interaction.interactionId,
      ).length,
      1,
    );
  const final = await session.readSnapshot();
  assert.equal(final.ok, true);
  assert.equal(final.value.turns.length, 5);
  assert.equal(
    final.value.turns[4].items.filter((item) => item.item.type === "commandExecution").length,
    1,
  );
  assert.ok(
    final.value.turns[4].items.some(
      (item) =>
        item.item.type === "toolExecution" &&
        item.item.toolName === "question" &&
        JSON.stringify(item.item.output).includes("Verified"),
    ),
  );
  assert.deepEqual(final, await session.readSnapshot());
  await session.close();
  const unattended = await adapter.open({
    kind: "create",
    cwd,
    executionPolicy: "unattended-full-access",
  });
  assert.equal(unattended.ok, true, JSON.stringify(unattended.error));
  session = unattended.value;
  outputs = observe(session);
  assert.equal(session.initialState.effectivePermissionModeId, "full-access");
  const deleteFixture = path.join(cwd, "codexhost-unattended-delete.txt");
  await writeFile(deleteFixture, "isolated test fixture");
  pendingCalls.push({
    name: "bash",
    arguments: {
      command:
        process.platform === "win32"
          ? "Remove-Item -LiteralPath './codexhost-unattended-delete.txt'; Write-Output 'unattended-verified'"
          : "rm -- ./codexhost-unattended-delete.txt && printf unattended-verified",
      description: "Delete only the isolated test fixture",
    },
  });
  const unattendedRequestOffset = requestedModels.length;
  await turn(session, outputs, "host-unattended");
  assert.ok(requestedModels.slice(unattendedRequestOffset).includes("smoke"));
  assert.equal(requestedModels.slice(unattendedRequestOffset).includes("alternate"), false);
  assert.equal(
    outputs.some((output) => output.kind === "interaction"),
    false,
  );
  await assert.rejects(access(deleteFixture), { code: "ENOENT" });
  const unattendedRef = session.initialState.nativeRef;
  await session.close();
  const restored = await adapter.open({ kind: "resume", cwd, nativeRef: unattendedRef });
  assert.equal(restored.ok, true, JSON.stringify(restored.error));
  session = restored.value;
  assert.equal(session.initialState.effectivePermissionModeId, "full-access");
  assert.equal((await session.connection.client.permission.skipAll()).data, true);
  assert.equal((await session.connection.client.permission.autoApproveDelete()).data, true);
  outputs = observe(session);
  await turn(session, outputs, "host-unattended-resumed");
  await session.close();
  // Match an installation with no explicit global model and no recent-model state.
  const fallbackProfile = path.join(root, "fallback-profile");
  await mkdir(fallbackProfile);
  const fallbackConfig = JSON.parse(environment.MIMOCODE_CONFIG_CONTENT);
  delete fallbackConfig.model;
  delete fallbackConfig.small_model;
  fallbackConfig.enabled_providers = ["local"];
  const fallbackAdapter = new MimoAdapter({
    command: adapter.options.command,
    environment: {
      ...environment,
      MIMOCODE_HOME: fallbackProfile,
      MIMOCODE_CONFIG_CONTENT: JSON.stringify(fallbackConfig),
    },
  });
  try {
    const fallback = await fallbackAdapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    assert.equal(fallback.ok, true, JSON.stringify(fallback.error));
    assert.equal((await fallback.value.connection.client.config.get()).data.model, undefined);
    const offset = requestedModels.length;
    await turn(fallback.value, observe(fallback.value), "host-no-default");
    assert.ok(requestedModels.length > offset);
    assert.ok(
      requestedModels.slice(offset).every((model) => ["smoke", "alternate"].includes(model)),
    );
  } finally {
    await fallbackAdapter.close();
  }
  console.log(
    JSON.stringify({
      nativeVersion: execFileSync(adapter.options.command, ["--version"], {
        env: environment,
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      provider: "deterministic localhost stub",
      externalModelCalls: 0,
      nonemptyResume: true,
      cancelledNativeStream: true,
      continueAfterCancel: true,
      stableHistory: true,
      modelSelectionAndResume: true,
      unattendedCreateToolAndResume: true,
      delegationNativeDefault: true,
      delegationWithoutConfiguredDefault: true,
      nativeTool: true,
      perOpenToolEnvironment: true,
      nativeApproval: true,
      nativeQuestion: true,
      providerRequests: requests,
      isolatedProfile: true,
    }),
  );
} finally {
  await adapter.close();
  held?.destroy();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("codexhost-mimo-loop-"))
    throw new Error("Unexpected smoke cleanup path");
  await rm(root, { recursive: true, force: true });
}
