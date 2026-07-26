import { spawn } from "node:child_process";
import process from "node:process";

const scenario = process.env.CODEXHOST_FAKE_PI_SCENARIO ?? "normal";
let buffer = Buffer.alloc(0);
let child;

function output(value) {
  process.stdout.write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function response(command, data) {
  output({ id: command.id, type: "response", command: command.type, success: true, data });
}

function handle(command) {
  if (scenario === "crash") process.exit(23);
  if (scenario === "stdout-eof") {
    process.stdout.destroy();
    process.stdout._handle?.close();
    return;
  }
  if (scenario === "malformed") {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (scenario === "oversized-frame") {
    process.stdout.write("x".repeat(65));
    return;
  }
  if (scenario === "stderr") process.stderr.write("bounded fake diagnostic\n");
  if (scenario === "unknown-response") {
    output({ id: "req-unknown", type: "response", command: command.type, success: true });
    return;
  }
  if (scenario === "duplicate-response") {
    response(command);
    response(command);
    return;
  }
  if (["hang", "refuse-close"].includes(scenario)) return;
  if (scenario === "interleaved") {
    output({ type: "unknown_future_event", payload: { value: "line\\u2028separator" } });
    output({ type: "agent_start" });
    response(command, { echoed: command.value });
    output({ type: "agent_settled" });
    return;
  }
  if (scenario === "chunked-utf8") {
    const value = {
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: "A-utf8-漢字-B",
    };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    return;
  }
  if (["spawn-child", "spawn-child-refuse-close"].includes(scenario)) {
    child ??= spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      stdio: "ignore",
    });
    response(command, { childPid: child.pid });
    return;
  }
  response(command, { echoed: command.value });
}

if (scenario === "backpressure") {
  setInterval(() => {}, 1_000);
} else {
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (frame.length > 0) handle(JSON.parse(frame.toString("utf8")));
    }
  });
}

if (scenario !== "backpressure") {
  process.stdin.on("end", () => {
    if (["refuse-close", "spawn-child-refuse-close"].includes(scenario)) return;
    process.exit(0);
  });
}
