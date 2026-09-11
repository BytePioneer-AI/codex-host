import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const scenario = process.argv[2];
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
  else if (message.method === "session/prompt") result = { stopReason: "end_turn" };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
}
