import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.DEVIN_DISCOVERY_SCENARIO ?? "normal";
const info = {
  modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
  configOptions: [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "a",
      options: [{ value: "a", name: "A" }],
    },
  ],
};
const row = (sessionId) => ({ sessionId, cwd: process.cwd(), updatedAt: "2026-10-01T00:00:00Z" });
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
// Closing must also handle a native process that ignores stdin EOF.
if (scenario === "stalled-list" || scenario === "stalled-initialize") setInterval(() => {}, 1_000);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.DEVIN_DISCOVERY_LOG)
    appendFileSync(
      process.env.DEVIN_DISCOVERY_LOG,
      `${JSON.stringify({ pid: process.pid, ...request })}\n`,
    );
  let result;
  switch (request.method) {
    case "initialize":
      if (scenario === "stalled-initialize") continue;
      result = { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } };
      break;
    case "session/list":
      if (scenario === "stalled-list") continue;
      if (scenario === "auth-error" || (scenario === "page-error" && request.params.cursor)) {
        send({
          id: request.id,
          error: {
            code: -32000,
            message: scenario === "auth-error" ? "Authentication required" : "Native page failed",
          },
        });
        continue;
      }
      if (!request.params.cursor) result = { sessions: [row("newer")], nextCursor: "page2" };
      else
        result = {
          sessions: [row("older")],
          ...(scenario === "repeated-cursor" ? { nextCursor: "page2" } : {}),
        };
      break;
    case "session/new":
      result = { sessionId: "selected-session", ...info };
      break;
    case "session/load":
      result = info;
      break;
    default:
      throw new Error(`Unexpected synthetic discovery RPC ${request.method}`);
  }
  if (request.id !== undefined) send({ id: request.id, result });
}
