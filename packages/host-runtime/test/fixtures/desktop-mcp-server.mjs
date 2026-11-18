import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const waiting = new Map();
const questions = new Map();
let calls = 0;
function record(value) {
  if (process.env.FIXTURE_EVENTS)
    appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(value) + "\n");
}
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
if (process.env.FIXTURE_IGNORE_SHUTDOWN === "1") {
  process.on("SIGTERM", () => record({ event: "ignored-termination" }));
  setInterval(() => {}, 1_000);
}
record({ event: "started", pid: process.pid, parent: process.ppid });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  record({ event: "received", method: message.method });
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "desktop-mcp-fixture", version: "1" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      id: message.id,
      result: {
        tools: ["echo", "ask", "wait", "measure"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      },
    });
  } else if (message.method === "tools/call") {
    if (message.params.name === "measure") {
      send({
        id: message.id,
        result: {
          content: [{ type: "text", text: "measured" }],
          structuredContent: { length: message.params.arguments.input.length },
        },
      });
    } else if (message.params.name === "ask") {
      const id = `question-${message.id}`;
      questions.set(id, message.id);
      send({
        id,
        method: "elicitation/create",
        params: {
          message: "Fixture approval",
          requestedSchema: {
            type: "object",
            properties: { allow: { type: "boolean" } },
            required: ["allow"],
          },
        },
      });
    } else if (message.params.name === "wait") {
      waiting.set(message.id, true);
    } else {
      const value = {
        arguments: message.params.arguments,
        meta: message.params._meta,
        pid: process.pid,
        parent: process.ppid,
        cwd: process.cwd(),
        marker: process.env.FIXTURE_MARKER,
        browserPipe: process.env.BROWSER_USE_ACCESS_PIPE_PATH,
        calls: ++calls,
      };
      if (message.params._meta?.progressToken !== undefined) {
        send({
          method: "notifications/progress",
          params: { progressToken: message.params._meta.progressToken, progress: 1, total: 1 },
        });
      }
      send({
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        },
      });
    }
  } else if (message.method === "notifications/cancelled") {
    record({ event: "cancelled", id: message.params.requestId });
    if (waiting.delete(message.params.requestId))
      send({ id: message.params.requestId, error: { code: -32800, message: "Cancelled" } });
  } else if (!message.method && questions.has(message.id)) {
    const id = questions.get(message.id);
    questions.delete(message.id);
    send({
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(message.result) }],
        structuredContent: message.result,
      },
    });
  }
}
