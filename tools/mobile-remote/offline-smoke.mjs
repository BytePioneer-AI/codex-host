// Real patched app-server binary + production Host composition. Backend/auth are localhost fixtures.
import assert from "node:assert/strict";
import { startNativeServer } from "./native-session.mjs";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { configureReadonlyProbe } from "./model-picker-probe.mjs";
import { startSyntheticHost } from "./synthetic-host.mjs";

const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary))
  throw new Error("Pass the absolute patched app-server binary path");
const reportPath = process.argv[3];
const home = await mkdtemp("/tmp/ch-mobile-native-");
let host;
const catalogPath = process.argv[4];
if (!catalogPath || !path.isAbsolute(catalogPath))
  throw new Error("Pass the pinned official models.json path as fourth argument");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
await writeFile(
  path.join(home, "models.json"),
  JSON.stringify({ models: catalog.models.slice(0, 1) }),
);
const paths = [];
const backend = createServer((request, response) => {
  paths.push(request.url);
  request.resume();
  response.setHeader("content-type", "application/json");
  if (request.url.endsWith("/server/enroll")) {
    response.end(
      JSON.stringify({
        server_id: "synthetic-server",
        environment_id: "synthetic-environment",
        remote_control_token: "synthetic-remote-token",
        expires_at: "2999-01-01T00:00:00Z",
      }),
    );
  } else if (request.url.endsWith("/config/bundle")) response.end("{}");
  else {
    response.statusCode = 404;
    response.end("{}");
  }
});
backend.on("connect", (request, socket) => {
  paths.push(`BLOCKED CONNECT ${request.url}`);
  socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
const wss = new WebSocketServer({ server: backend });
const remoteFrames = [];
const connections = [];
let wire;
wss.on("connection", (socket) => {
  wire = socket;
  connections.push(socket);
  socket.on("message", (data) => {
    const envelope = JSON.parse(data.toString());
    remoteFrames.push(envelope);
    if (envelope.seq_id !== undefined && envelope.type === "server_message") {
      socket.send(
        JSON.stringify({
          type: "ack",
          client_id: envelope.client_id,
          stream_id: envelope.stream_id,
          seq_id: envelope.seq_id,
        }),
      );
    }
  });
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${backend.address().port}/backend-api/`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "synthetic@example.invalid", exp: 32503680000, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_user_id: "synthetic-user", chatgpt_plan_type: "plus" } })}.synthetic`;
await writeFile(
  path.join(home, "auth.json"),
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt,
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      account_id: "synthetic-account",
    },
    last_refresh: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
await writeFile(
  path.join(home, "config.toml"),
  `chatgpt_base_url = ${JSON.stringify(base)}\ncli_auth_credentials_store = "file"\nmodel_provider = "openai"\nmodel_catalog_json = ${JSON.stringify(path.join(home, "models.json"))}\n`,
  { mode: 0o600 },
);
const nativeFrames = [];
let native;
let nativeExited = false;
const diagnosticFile = path.join(home, "app-server.log");
async function launch(socketPath) {
  native = await startNativeServer({
    binary,
    home,
    hostSocket: socketPath,
    testMode: true,
    cliMode: process.argv.includes("--cli"),
    diagnosticFile,
    onMessage: (message) => nativeFrames.push(message),
    environment: {
      HOME: home,
      TMPDIR: home,
      OPENAI_BASE_URL: `${base}openai`,
      HTTP_PROXY: new URL(base).origin,
      HTTPS_PROXY: new URL(base).origin,
      NO_PROXY: "127.0.0.1,localhost",
    },
  });
  void native.closed.then(() => {
    nativeExited = true;
  });
}
async function waitFor(predicate, label, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    if (nativeExited) throw new Error(`app-server exited during ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
let remoteId = 0;
let sequence = 0;
const client = "synthetic-mobile";
let stream = "synthetic-stream";
const nativeRequest = (method, params = {}) => native.request(method, params);
function sendRemote(message) {
  wire.send(
    JSON.stringify({
      type: "client_message",
      client_id: client,
      stream_id: stream,
      seq_id: sequence++,
      message,
    }),
  );
}
async function remoteRequest(method, params = {}) {
  const id = ++remoteId;
  sendRemote({ id, method, params });
  const reply = await waitFor(
    () =>
      remoteFrames.find(
        (frame) =>
          frame.type === "server_message" &&
          frame.client_id === client &&
          frame.stream_id === stream &&
          frame.message.id === id &&
          !frame.message.method,
      ),
    `remote ${method}`,
  );
  assert.equal(reply.message.error, undefined, JSON.stringify(reply.message.error));
  return reply.message.result;
}
let outcome;
try {
  host = await startSyntheticHost({
    onReady: launch,
    allowAdditionalSessions: true,
    createOfficialConnection: () => native.connect(),
  });
  const initialize = {
    clientInfo: { name: "codexhost-isolated-validation", version: "1" },
    capabilities: { experimentalApi: true },
  };
  await waitFor(() => wire?.readyState === 1, "fake remote connection");
  await remoteRequest("initialize", {
    ...initialize,
    clientInfo: { name: "synthetic-phone", version: "1" },
  });
  sendRemote({ method: "initialized" });
  const list = await remoteRequest("thread/list");
  assert.equal(list.data.find((row) => row.id === host.threadId)?.name, host.title);
  for (const method of ["thread/read", "thread/resume"]) {
    const result = await remoteRequest(method, {
      threadId: host.threadId,
      ...(method === "thread/read" ? { includeTurns: true } : {}),
    });
    assert.equal(result.thread.id, host.threadId);
    assert.equal(result.thread.name, host.title);
    assert.match(JSON.stringify(result), /Synthetic native history from the shared owner/);
  }
  await remoteRequest("thread/name/set", {
    threadId: host.threadId,
    name: "renamed over actual remote transport",
  });
  assert.equal(
    (await host.desktop.request("thread/read", { threadId: host.threadId })).thread.name,
    "renamed over actual remote transport",
  );
  const turn = await remoteRequest("turn/start", {
    threadId: host.threadId,
    input: [{ type: "text", text: "Synthetic remote control turn" }],
  });
  await waitFor(
    () =>
      remoteFrames.find(
        (frame) =>
          frame.message?.method === "turn/started" && frame.message.params.turn.id === turn.turn.id,
      ),
    "remote turn started",
  );
  host.adapter.sessions[0].appendText("live remote delta");
  host.adapter.sessions[0].succeedTurn();
  await waitFor(
    () =>
      remoteFrames.find(
        (frame) =>
          frame.message?.method === "turn/completed" &&
          frame.message.params.turn.id === turn.turn.id,
      ),
    "remote completed",
  );
  assert(
    remoteFrames.some(
      (frame) =>
        frame.message?.method === "item/agentMessage/delta" &&
        frame.message.params.delta.includes("live remote delta"),
    ),
  );
  host.adapter.sessions[0].completeCancellationOnRequest();
  const interrupted = await remoteRequest("turn/start", {
    threadId: host.threadId,
    input: [{ type: "text", text: "Synthetic interrupt" }],
  });
  await remoteRequest("turn/interrupt", { threadId: host.threadId, turnId: interrupted.turn.id });
  await waitFor(
    () =>
      remoteFrames.find(
        (frame) =>
          frame.message?.method === "turn/completed" &&
          frame.message.params.turn.id === interrupted.turn.id,
      ),
    "remote interrupted",
  );
  host.adapter.sessions[0].requestApprovalOnNextTurn("Allow synthetic remote action?");
  const approvalTurn = await remoteRequest("turn/start", {
    threadId: host.threadId,
    input: [{ type: "text", text: "Synthetic approval" }],
  });
  const approval = await waitFor(
    () => remoteFrames.find((frame) => frame.message?.method === "mcpServer/elicitation/request"),
    "remote approval",
  );
  sendRemote({ id: approval.message.id, result: { action: "accept", content: {}, _meta: null } });
  await waitFor(
    () => host.adapter.sessions[0].interactionResponses.length === 1,
    "one approval response",
  );
  await waitFor(
    () =>
      remoteFrames.find(
        (frame) =>
          frame.message?.method === "serverRequest/resolved" &&
          frame.message.params.requestId === approval.message.id,
      ),
    "approval resolved",
  );
  host.adapter.sessions[0].succeedTurn();
  await waitFor(
    () =>
      remoteFrames.find(
        (frame) =>
          frame.message?.method === "turn/completed" &&
          frame.message.params.turn.id === approvalTurn.turn.id,
      ),
    "approval turn completed",
  );
  wire.send(JSON.stringify({ type: "client_closed", client_id: client, stream_id: stream }));
  stream = "synthetic-reconnected-stream";
  sequence = 0;
  await remoteRequest("initialize", {
    clientInfo: { name: "synthetic-phone-reconnected", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const restored = await remoteRequest("thread/resume", { threadId: host.threadId });
  assert.match(JSON.stringify(restored), /live remote delta/);
  assert.equal(host.adapter.sessions.length, 1);
  const models = await remoteRequest("model/list");
  assert(models.data.length > 0, "Remote native request returns through same app-server WebSocket");
  assert.equal((await configureReadonlyProbe(native, host.directory)).sandboxMode, "read-only");
  for (const includeLayers of [false, true]) {
    const params = { cwd: host.directory, includeLayers };
    const direct = await nativeRequest("config/read", params);
    const remote = await remoteRequest("config/read", params);
    assert.deepEqual(
      remote,
      direct,
      "Remote bridge must preserve configuration and trust metadata",
    );
  }
  const nativeThreads = await nativeRequest("thread/list");
  assert(!nativeThreads.data.some((row) => row.id === host.threadId));
  assert(!nativeFrames.some((frame) => JSON.stringify(frame).includes(host.threadId)));
  assert.equal(host.adapter.sessions.length, 1);
  assert(
    !paths.some((value) => value.startsWith("BLOCKED")),
    "Unexpected non-local network request",
  );
  const selectedEntry = models.data.find((entry) => entry.displayName === "Fake Secondary");
  assert(selectedEntry, "Production catalog exposes native Harness model labels");
  const selectedModel = selectedEntry.model;
  await remoteRequest("config/batchWrite", {
    edits: [{ keyPath: "model", value: selectedModel, mergeStrategy: "replace" }],
  });
  assert.equal((await remoteRequest("config/read")).config.model, selectedModel);
  assert.notEqual((await nativeRequest("config/read")).config.model, selectedModel);
  const created = await remoteRequest("thread/start", {
    cwd: host.directory,
    model: selectedModel,
    modelProvider: "openai",
    config: { model_reasoning_effort: "low" },
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  assert.equal(created.model, selectedModel);
  assert.equal(host.adapter.sessions.length, 2);
  assert.equal(host.adapter.sessions[1].state.effectiveModel.id, "fake-model-v1.secondary");
  assert.equal(host.adapter.sessions[1].state.effectiveThinkingOptionId, "low");
  const createdTurn = await remoteRequest("turn/start", {
    threadId: created.thread.id,
    model: selectedModel,
    input: [{ type: "text", text: "Synthetic new-thread model routing validation" }],
  });
  host.adapter.sessions[1].appendText("Synthetic new model route confirmed");
  host.adapter.sessions[1].succeedTurn();
  await waitFor(
    () =>
      remoteFrames.some(
        (frame) =>
          frame.message?.method === "turn/completed" &&
          frame.message.params.turn.id === createdTurn.turn.id,
      ),
    "new external thread completion",
  );
  await nativeRequest("account/logout");
  if (wire.readyState === 1)
    sendRemote({
      id: ++remoteId,
      method: "thread/name/set",
      params: { threadId: host.threadId, name: "must-not-run-after-logout" },
    });
  await waitFor(() => wire.readyState !== 1, "remote auth invalidation closes wire");
  assert.equal(
    (await host.desktop.request("thread/read", { threadId: host.threadId })).thread.name,
    "renamed over actual remote transport",
  );
  outcome = {
    passed: true,
    actualPatchedAppServer: true,
    productionLocalSharedHost: true,
    fakeBackendAndAuth: true,
    realPhone: false,
    remoteRpcCount: remoteId,
    sameSessionHistoryTitle: true,
    rename: true,
    streamAndInterrupt: true,
    approvalAndResolved: true,
    reconnectSameHistory: true,
    authInvalidationStopsForwarding: true,
    nativeIsolation: true,
    configResponsePreserved: true,
    explicitReadonlyConfig: true,
    newExternalThreadModelRouted: true,
    newExternalThreadTurnCompleted: true,
    nativeCallbackThroughSameAppServerWebSocket: true,
    remoteWireMessages: remoteFrames.filter((frame) => frame.type === "server_message").length,
    backendPaths: [...new Set(paths)],
  };
} catch (error) {
  outcome = {
    passed: false,
    error: error.message,
    stderr: await readFile(diagnosticFile, "utf8").catch(() => ""),
    backendPaths: [...new Set(paths)],
    nativeFrames,
    remoteFrames,
  };
  process.exitCode = 1;
} finally {
  const nativeCleanup = await native?.close();
  for (const socket of connections) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => backend.close(resolve));
  await host?.close();
  await rm(home, { recursive: true, force: true });
  outcome.cleanup = { ...nativeCleanup, privateDirectoriesRemoved: true };
  outcome.externalRequestsBlocked = paths.filter((value) => value.startsWith("BLOCKED"));
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(outcome, null, 2)}\n`);
  console.log(JSON.stringify(outcome, null, 2));
}
