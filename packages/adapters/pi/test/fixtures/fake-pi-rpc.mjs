import process from "node:process";

const scenario = process.env.CODEXHOST_FAKE_PI_RESPONSE ?? "final-only";
let buffer = Buffer.alloc(0);

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, data) {
  output({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    data,
  });
}

function handle(command) {
  if (command.type === "get_state") {
    response(command, {
      sessionId: "synthetic-session",
      sessionFile: null,
      model: { provider: "synthetic-provider", id: "synthetic-model" },
    });
    return;
  }
  if (command.type !== "prompt") {
    response(command);
    return;
  }

  response(command);
  if (scenario === "final-only") {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "synthetic final text" }],
    };
    output({ type: "message_start", message });
    output({ type: "message_end", message });
  }
  output({ type: "agent_settled" });
}

process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  let newline = buffer.indexOf(0x0a);
  while (newline >= 0) {
    const frame = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (frame.length > 0) handle(JSON.parse(frame.toString("utf8")));
    newline = buffer.indexOf(0x0a);
  }
});

process.stdin.on("end", () => process.exit(0));
