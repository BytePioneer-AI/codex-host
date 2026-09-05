// Feasibility probe only: this does not enable Desktop message editing.
// Live mode invokes the company wrapper and sends six short test prompts.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
const command = process.env.CODEXHOST_CLAUDE_HISTORY_PROBE_COMMAND;
if (!command) throw Error("Set CODEXHOST_CLAUDE_HISTORY_PROBE_COMMAND to a Claude Code executable");
const live = process.env.CODEXHOST_CLAUDE_HISTORY_PROBE_LIVE === "1";
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-history-native-")));
const cwd = path.join(root, "workspace");
const config = live
  ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
  : path.join(root, "config");
await fs.mkdir(cwd);
if (!live) await fs.mkdir(config);
process.env.CLAUDE_CONFIG_DIR = config;
const requests = [];
const server = http.createServer(async (req, res) => {
  let data = "";
  for await (const b of req) data += b;
  const body = JSON.parse(data || "{}");
  if (req.url.includes("/count_tokens")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"input_tokens":10}');
    return;
  }
  if (!req.url.includes("/messages")) {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  requests.push(body.messages);
  const msg = {
    id: "msg_" + randomUUID(),
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: "PROBE_OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
  if (!body.stream) {
    res.end(JSON.stringify(msg));
    return;
  }
  for (const [event, value] of [
    [
      "message_start",
      { type: "message_start", message: { ...msg, content: [], stop_reason: null } },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROBE_OK" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ])
    res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const env = {
  ...process.env,
  ANTHROPIC_API_KEY: "local-probe",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
for (const key of Object.keys(env)) {
  if (
    (key.startsWith("ANTHROPIC_") && !["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"].includes(key)) ||
    key.startsWith("CLAUDE_CODE_USE_") ||
    key === "AWS_BEARER_TOKEN_BEDROCK"
  )
    delete env[key];
}
if (live) {
  for (const key of Object.keys(env))
    if (
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_CODE_USE_") ||
      key === "AWS_BEARER_TOKEN_BEDROCK"
    )
      delete env[key];
}
const common = {
  cwd,
  env,
  ...(!live ? { model: "claude-sonnet-4-6" } : {}),
  tools: [],
  settingSources: live ? ["user"] : [],
  persistSession: true,
  pathToClaudeCodeExecutable: command,
  thinking: { type: "disabled" },
};
async function run(options, prompt) {
  const q = query({ prompt, options: { ...common, ...options } });
  const messages = [];
  try {
    for await (const m of q) if (["assistant", "result"].includes(m.type)) messages.push(m);
    assert.equal(messages.at(-1)?.type, "result");
    assert.equal(messages.at(-1)?.subtype, "success");
    return messages;
  } finally {
    q.close();
  }
}
async function files(id) {
  try {
    const text = await fs.readFile(
      path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), id + ".jsonl"),
      "utf8",
    );
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
const report = { root, mode: live ? "company-wrapper-live" : "local-model" };
try {
  const source = randomUUID();
  await run({ sessionId: source }, "Reply with exactly FIRST_KEPT. Do not use tools.");
  await run({ resume: source }, "Reply with exactly SECOND_REMOVED. Do not use tools.");
  const records = await files(source);
  report.source = {
    id: source,
    records: records?.map((r) => ({ type: r.type, subtype: r.subtype, uuid: r.uuid })),
  };
  const boundary = records.find((r) => r.type === "assistant").uuid;
  const sourceMessages = await getSessionMessages(source, { dir: cwd });
  const fork = await forkSession(source, { dir: cwd, upToMessageId: boundary });
  const prefix = await getSessionMessages(fork.sessionId, { dir: cwd });
  assert.notEqual(fork.sessionId, source);
  assert.deepEqual(
    prefix.map(({ type, message }) => ({ type, message })),
    sourceMessages.slice(0, 2).map(({ type, message }) => ({ type, message })),
  );
  assert.ok(prefix.every((m) => !sourceMessages.some((original) => original.uuid === m.uuid)));
  report.nativeFork = {
    id: fork.sessionId,
    messages: (await getSessionMessages(fork.sessionId, { dir: cwd })).map((r) => r.type),
  };
  await run({ resume: fork.sessionId }, "Reply with exactly EDITED_SECOND. Do not use tools.");
  report.nativeFork.request = requests.at(-1);
  const derivedMessages = await getSessionMessages(fork.sessionId, { dir: cwd });
  assert.equal(derivedMessages.filter((m) => m.type === "user").length, 2);
  assert.ok(!JSON.stringify(derivedMessages).includes("SECOND_REMOVED"));
  const empty = randomUUID();
  const reservation = path.join(root, "pending-empty.json");
  await fs.writeFile(
    reservation,
    JSON.stringify({ version: 1, sessionId: empty, cwd, phase: "pending" }),
    { flag: "wx", mode: 0o600 },
  );
  const stored = JSON.parse(await fs.readFile(reservation, "utf8"));
  if (stored.phase !== "pending" || stored.cwd !== cwd || stored.sessionId !== empty)
    throw Error("Invalid reservation");
  report.emptyBeforeSend = {
    id: stored.sessionId,
    turns: [],
    nativeTranscript: await files(empty),
  };
  await fs.writeFile(reservation, JSON.stringify({ ...stored, phase: "started" }));
  report.emptyResume = await run(
    { sessionId: stored.sessionId },
    "Reply with exactly EDITED_FIRST. Do not use tools.",
  );
  report.emptyRequest = requests.at(-1);
  report.emptyNativeIdentityMatches = report.emptyResume.every(
    (m) => m.session_id === stored.sessionId,
  );
  report.emptyColdMessages = (await getSessionMessages(empty, { dir: cwd })).map((m) => m.type);
  assert.deepEqual(report.emptyColdMessages, ["user", "assistant"]);
  assert.equal(report.emptyNativeIdentityMatches, true);
  await run({ resume: empty }, "Reply with exactly AFTER_EDITED_FIRST. Do not use tools.");
  report.emptyColdRequest = requests.at(-1);
  const resumeAt = randomUUID();
  await run(
    { resume: source, forkSession: true, resumeSessionAt: boundary, sessionId: resumeAt },
    "Reply with exactly NATIVE_RESUME_AT. Do not use tools.",
  );
  report.resumeAtRequest = requests.at(-1);
  report.emptySourceUnchanged = JSON.stringify(await files(source)) === JSON.stringify(records);
  report.requests = requests.length;
  assert.equal(report.emptySourceUnchanged, true);
  if (!live) {
    assert.ok(!JSON.stringify(report.nativeFork.request).includes("SECOND_REMOVED"));
    assert.ok(!JSON.stringify(report.emptyRequest).includes("FIRST_KEPT"));
    assert.ok(!JSON.stringify(report.emptyRequest).includes("SECOND_REMOVED"));
    assert.ok(JSON.stringify(report.emptyColdRequest).includes("EDITED_FIRST"));
    assert.ok(!JSON.stringify(report.resumeAtRequest).includes("SECOND_REMOVED"));
  }
  report.ok = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ok: report.ok === true,
      mode: report.mode,
      reportPath: path.join(root, "report.json"),
      emptyNativeIdentityMatches: report.emptyNativeIdentityMatches,
      emptyColdMessages: report.emptyColdMessages,
      sourceUnchanged: report.emptySourceUnchanged,
      error: report.error,
    }),
  );
}
