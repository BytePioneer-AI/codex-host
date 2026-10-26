import { createInterface } from "node:readline";

// Synthetic ACP server: no Devin installation, authentication or model requests.
const sessionId = "fixture-session";
const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] };
const model = {
  id: "model",
  category: "model",
  name: "Model",
  type: "select",
  currentValue: "fixture",
  options: [{ value: "fixture", name: "Fixture" }],
};
const thoughts = (value) => ({
  id: "opaque/effort",
  category: "thought_level",
  name: "Effort",
  type: "select",
  currentValue: value,
  options: ["low", "high"].map((value) => ({ value, name: value })),
});
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const notify = (configOptions) =>
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions } },
  });
let loaded = false;
let promptId;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  let result = {};
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
      break;
    case "session/load":
      result = { modes, configOptions: loaded ? [model] : [model, thoughts("low")] };
      if (!loaded) setTimeout(() => notify([model, thoughts("high")]), 50);
      loaded = true;
      break;
    case "session/prompt":
      promptId = message.id;
      notify([model, thoughts("low")]);
      continue;
    case "session/set_config_option":
      result = { configOptions: [model, thoughts(message.params.value)] };
      break;
    case "session/cancel":
      send({ id: promptId, result: { stopReason: "cancelled" } });
      continue;
  }
  if (message.id !== undefined) send({ id: message.id, result });
}
