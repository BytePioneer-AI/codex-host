/** Isolated native-transport fixture: no model, login or user account access. */
import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const home = process.env.CODEX_HOME;
if (!home) throw new Error("Native fixture requires an isolated Codex home");
const log = (value: unknown) =>
  appendFileSync(path.join(home, "native-calls.jsonl"), JSON.stringify(value) + "\n");
log({ pid: process.pid, type: "startup", feature: process.argv.includes("features.fixture=true") });
const file = path.join(home, "native-thread.json");
let thread: Record<string, unknown> | undefined;
try {
  thread = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
} catch {
  /* First startup. */
}
const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
server.on("listening", () =>
  process.stderr.write(
    `listening on: ws://127.0.0.1:${(server.address() as { port: number }).port}\n`,
  ),
);
server.on("connection", (socket) => {
  socket.on("error", () => undefined);
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString()) as {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (request.id === undefined) return;
    let result: unknown = {};
    if (request.method === "initialize") result = { userAgent: "fixture" };
    else if (request.method === "account/read")
      result = { account: null, requiresOpenaiAuth: false };
    else if (request.method === "thread/start") {
      thread = {
        id: randomUUID(),
        cwd: home,
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 1,
        status: { type: "idle" },
        turns: [],
      };
      result = { thread };
    } else if (request.method === "thread/read" || request.method === "thread/resume")
      result = { thread };
    else if (request.method === "turn/start") {
      const turnId = randomUUID();
      result = { turn: { id: turnId, status: "inProgress", items: [] } };
      log({ pid: process.pid, type: "turn/start", threadId: thread?.id });
      setTimeout(() => {
        const turn = {
          id: turnId,
          status: "completed",
          items: [{ id: "reply", type: "agentMessage", text: "native turn survived Desktop exit" }],
        };
        thread = { ...thread, turns: [turn] };
        writeFileSync(file, JSON.stringify(thread));
        log({ pid: process.pid, type: "turn/completed" });
        if (socket.readyState === socket.OPEN)
          socket.send(
            JSON.stringify({ method: "turn/completed", params: { threadId: thread.id, turn } }),
          );
      }, 400);
    } else if (request.method === "thread/list")
      result = { data: thread ? [thread] : [], nextCursor: null };
    else if (request.method === "thread/turns/list")
      result = { data: thread?.turns ?? [], nextCursor: null };
    else if (request.method === "model/list") result = { data: [] };
    socket.send(JSON.stringify({ id: request.id, result }));
  });
});
process.on("SIGTERM", () => {
  for (const client of server.clients) client.terminate();
  server.close();
});
