// A protocol boundary fixture, not a substitute for an entitled TRAE account.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = process.env.TRAE_FIXTURE_ROOT;
const scenario = process.env.TRAE_FIXTURE_SCENARIO;
const file = path.join(root, "sessions.json");
const audit = (method, params) =>
  appendFileSync(
    path.join(root, "audit.jsonl"),
    JSON.stringify({ pid: process.pid, method, params, scope: process.env.TRAE_FIXTURE_VALUE }) +
      "\n",
  );
const args = process.argv.slice(2);
if (args[0] === "models") {
  audit("models", args);
  if (scenario === "duplicate-models") {
    console.log(
      JSON.stringify([
        { id: "duplicate", name: "First" },
        { id: "duplicate", name: "Second" },
      ]),
    );
    process.exit(0);
  }
  if (scenario === "blank-label") {
    console.log(JSON.stringify([{ id: "model", name: "" }]));
    process.exit(0);
  }
  console.log(
    JSON.stringify([
      { id: "provider/model-a", name: "Model A" },
      { id: "provider/model-b", name: "Model B" },
    ]),
  );
} else if (args[0] === "--version") console.log("traecli 0.213.1\ninstallation: public");
else {
  audit("spawn", args);
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const save = (data) => writeFileSync(file, JSON.stringify(data));
  const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  const update = (sessionId, value) =>
    send({ method: "session/update", params: { sessionId, update: value } });
  const pending = new Map();
  let clientId = 1000;
  let prompt;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++clientId;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  const info = (row) => ({
    modes: {
      currentModeId: row.mode,
      availableModes: [
        { id: "default", name: "Default" },
        { id: "bypass_permissions", name: "Bypass" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: row.model,
        options: [
          { value: "provider/model-a", name: "Model A" },
          { value: "provider/model-b", name: "Model B" },
        ],
      },
      ...(row.model.endsWith("a")
        ? [
            {
              id: "effort",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: row.effort,
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ]
        : []),
    ],
  });
  const answer = (message, text, stopReason = "end_turn") => {
    const rows = read(),
      row = rows[message.params.sessionId];
    const event = { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
    row.events.push(event);
    save(rows);
    update(message.params.sessionId, event);
    send({ id: message.id, result: { stopReason } });
  };
  createInterface({ input: process.stdin })
    .on("line", async (line) => {
      const message = JSON.parse(line);
      if (!message.method) {
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message.result);
        }
        return;
      }
      audit(message.method, message.params);
      const { method, params = {} } = message;
      if (method === "initialize") {
        if (scenario === "stall-init") return;
        send({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } },
            agentInfo: { name: "fixture", version: "0.213.1" },
            authMethods: [],
          },
        });
        return;
      }
      if (scenario === "no-auth") {
        send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
        return;
      }
      const rows = read();
      if (method === "session/list") {
        send({
          id: message.id,
          result: {
            sessions: Object.entries(rows).map(([sessionId, row]) => ({
              sessionId,
              cwd: scenario === "foreign-cwd" ? path.dirname(row.cwd) : row.cwd,
            })),
          },
        });
      } else if (method === "session/new") {
        const sessionId = randomUUID();
        rows[sessionId] = {
          cwd: params.cwd,
          model: "provider/model-a",
          effort: "low",
          mode: "default",
          events: [],
        };
        save(rows);
        if (scenario === "slow-new") await new Promise((resolve) => setTimeout(resolve, 150));
        send({ id: message.id, result: { sessionId, ...info(rows[sessionId]) } });
      } else if (method === "session/load") {
        const row = rows[params.sessionId];
        if (!row) {
          send({ id: message.id, error: { code: -32002, message: "Session not found" } });
          return;
        }
        for (const event of scenario === "truncate" ? [] : row.events)
          update(params.sessionId, event);
        send({ id: message.id, result: info(row) });
      } else if (method === "session/set_config_option") {
        const row = rows[params.sessionId];
        if (scenario !== "refuse-config") {
          if (params.configId === "model") row.model = params.value;
          else if (params.configId === "effort") row.effort = params.value;
          save(rows);
        }
        send({ id: message.id, result: { configOptions: info(row).configOptions } });
      } else if (method === "session/set_mode") {
        rows[params.sessionId].mode = params.modeId;
        save(rows);
        send({ id: message.id, result: {} });
      } else if (method === "session/prompt") {
        if (scenario === "exit-prompt") {
          process.exit(3);
          return;
        }
        const row = rows[params.sessionId],
          text = params.prompt[0].text;
        row.events.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
        save(rows);
        if (text === "wait") {
          prompt = message;
          return;
        }
        if (text === "approve") {
          const response = await request("session/request_permission", {
            sessionId: params.sessionId,
            toolCall: { toolCallId: "approval-tool", title: "Fixture command", kind: "execute" },
            options: [
              { optionId: "yes", name: "Allow once", kind: "allow_once" },
              { optionId: "no", name: "Deny", kind: "reject_once" },
            ],
          });
          audit("permission-result", response);
          answer(message, JSON.stringify(response));
        } else if (text === "question") {
          const response = await request("elicitation/create", {
            sessionId: params.sessionId,
            mode: "form",
            message: "Choose colour",
            requestedSchema: {
              type: "object",
              properties: { colour: { type: "string", enum: ["blue", "red"] } },
              required: ["colour"],
            },
          });
          audit("question-result", response);
          answer(message, JSON.stringify(response));
        } else if (text === "tool") {
          for (const event of [
            {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Read and edit",
              kind: "edit",
              status: "in_progress",
              rawInput: { path: "sample.txt" },
            },
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              status: "completed",
              content: [
                { type: "content", content: { type: "text", text: "tool-output" } },
                { type: "diff", path: "sample.txt", oldText: "before\n", newText: "after\n" },
              ],
            },
          ]) {
            row.events.push(event);
            update(params.sessionId, event);
          }
          save(rows);
          answer(message, "tool finished");
        } else answer(message, `reply:${text}:${row.model}:${row.effort}`);
      } else if (method === "session/cancel") {
        if (prompt) {
          const current = prompt;
          prompt = undefined;
          answer(current, "cancelled", "cancelled");
        }
      } else send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    })
    .on("close", () => process.exit(0));
}
