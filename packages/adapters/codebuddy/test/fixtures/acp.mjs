import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const scenario = process.argv[2];
if (scenario === "serve-banner")
  process.stdout.write("Native HTTP Server\nPassword    fixture-password\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result = {};
  if (message.method === "initialize")
    result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  else if (message.method === "session/new") result = { sessionId: "native" };
  else if (message.method === "session/prompt" && scenario === "exit-open-pipes") {
    spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),3000)"], {
      stdio: ["ignore", process.stdout, process.stderr],
      windowsHide: true,
    });
    process.exit(1);
  } else if (
    message.method === "session/set_config_option" ||
    message.method.includes("resolveInterruption")
  )
    continue;
  else if (message.method === "session/prompt" && scenario === "session-end") {
    const update = (update) =>
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "native", update },
        }) + "\n",
      );
    const chunk = (text) =>
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    chunk("before");
    update({
      sessionUpdate: "session_end",
      stopReason: "end_turn",
      _meta: { "codebuddy.ai/requestId": "drain" },
    });
    chunk("after");
    result = { stopReason: "end_turn" };
  } else if (message.method === "session/prompt") result = { stopReason: "end_turn" };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
