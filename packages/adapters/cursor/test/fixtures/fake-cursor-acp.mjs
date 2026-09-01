#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CURSOR_ACP_MODE ?? "default";
const identity = process.env.FAKE_CURSOR_IDENTITY ?? "cursor";
const loadSession = process.env.FAKE_CURSOR_ACP_LOAD_SESSION !== "0";

if (process.env.FAKE_CURSOR_ACP_PROBE) {
  writeFileSync(
    process.env.FAKE_CURSOR_ACP_PROBE,
    `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`,
  );
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  if (identity === "grok") {
    process.stdout.write("Grok Build TUI\n\nUsage: agent [OPTIONS] [PROMPT] [COMMAND]\n");
  } else {
    process.stdout.write(
      [
        "Usage: agent [options] [command] [prompt...]",
        "",
        "Start the Cursor Agent",
        "",
        "Commands:",
        "  acp    Start the Cursor Agent as an ACP (Agent Client Protocol) server",
        "",
      ].join("\n"),
    );
  }
  process.exit(0);
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(identity === "grok" ? "grok 1.0.13\n" : "2026.08.25-3e8eec8\n");
  process.exit(0);
}

if (mode === "missing-acp") {
  process.stderr.write("unknown command\n");
  process.exit(2);
}

const sessions = new Map();
const pendingPrompts = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const { id, method, params } = message;
  if (method === "initialize") {
    if (mode === "exit-after-init") {
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession },
        authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
      });
      process.exit(2);
      return;
    }
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
    });
    if (mode === "malformed") {
      process.stdout.write("this is not json\n");
    }
    return;
  }
  if (method === "authenticate") {
    respond(id, {});
    return;
  }
  if (method === "session/new") {
    const sessionId = `cursor-session-${randomUUID()}`;
    sessions.set(sessionId, { cwd: params?.cwd ?? process.cwd(), events: [] });
    respond(id, { sessionId });
    return;
  }
  if (method === "session/load") {
    if (!loadSession) {
      fail(id, -32601, "Method not found");
      return;
    }
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      fail(id, -32602, "sessionId is required");
      return;
    }
    const existing = sessions.get(sessionId) ?? { cwd: params?.cwd ?? process.cwd(), events: [] };
    sessions.set(sessionId, existing);
    for (const event of existing.events) {
      notify("session/update", { sessionId, update: event });
    }
    respond(id, { sessionId });
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    const text = params?.prompt?.find((part) => part?.type === "text")?.text ?? "";
    const session = sessions.get(sessionId);
    if (!session) {
      fail(id, -32001, `Session ${sessionId} not found`);
      return;
    }
    if (mode === "exit-on-prompt") {
      process.exit(3);
      return;
    }
    if (mode === "hang-prompt") {
      pendingPrompts.set(sessionId, id);
      return;
    }
    const user = { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
    const agent = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `echo:${text}` },
    };
    session.events.push(user, agent);
    notify("session/update", { sessionId, update: user });
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" } },
    });
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }
  if (method === "session/cancel") {
    const sessionId = params?.sessionId;
    const promptId = pendingPrompts.get(sessionId);
    if (promptId !== undefined) {
      pendingPrompts.delete(sessionId);
      respond(promptId, { stopReason: "cancelled" });
    }
    if (id !== undefined) respond(id, {});
    return;
  }
  if (typeof method === "string") fail(id, -32601, `Method not found: ${method}`);
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.length === 0) continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  await handle(parsed);
}
