import readline from "node:readline";
const scenario = process.argv[2];
const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
let promptId;
let authenticated = false;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (scenario === "hang-startup") return;
    send({
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
    });
  } else if (message.method === "authenticate") {
    if (scenario === "hang-auth") return;
    if (scenario === "prepare-once" && authenticated) process.exit(9);
    authenticated = true;
    send({ id: message.id, result: {} });
  } else if (message.method === "session/new" || message.method === "session/load") {
    send({
      id: message.id,
      result: {
        sessionId,
        configOptions:
          scenario === "cached-models" || scenario === "changed-models"
            ? [
                {
                  id: "model",
                  name: "Model",
                  type: "select",
                  currentValue: "model",
                  options: [{ value: "model", name: "Model" }],
                },
              ]
            : [],
        models: { currentModelId: "model", availableModels: [{ modelId: "model", name: "Model" }] },
      },
    });
  } else if (message.method === "cursor/list_available_models") {
    if (scenario === "hang-models" || scenario === "cached-models") return;
    send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  } else if (message.method === "session/set_config_option") {
    if (scenario !== "hang-config") send({ id: message.id, result: { configOptions: [] } });
  } else if (message.method === "session/prompt") {
    if (scenario === "exit") {
      process.exit(7);
    }
    promptId = message.id;
    send({
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "shell-1", title: "Synthetic shell" },
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
      },
    });
  } else if (message.method === "session/cancel") {
    send({ id: promptId, result: { stopReason: "cancelled" } });
  } else if (message.id === "permission") {
    if (message.result?.outcome?.optionId !== "deny") process.exit(8);
    send({ id: promptId, result: { stopReason: "end_turn" } });
  }
});
lines.on("close", () => process.exit(0));
