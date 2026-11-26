#!/usr/bin/env node
// Synthetic OmO classic stdio RPC peer for codexhost transport tests.
// Written for this repository; no OmO source, documentation sample, or asset was
// copied. It speaks only the frame shapes the transport layer consumes.
import process from "node:process";

const scenario = process.env.FAKE_OMO_SCENARIO ?? "normal";

const state = {
  sessionId: "synthetic-session-id",
  sessionFile: "/synthetic/agent/sessions/project/synthetic-session.jsonl",
  model: {
    provider: "synthetic-provider",
    id: "synthetic-model",
    name: "Synthetic Model",
    reasoning: true,
  },
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  messageCount: 0,
  pendingDialogs: [{ id: "synthetic-dialog", method: "confirm", title: "Synthetic" }],
  permissionPreset: "ask",
  effectivePermissionPreset: "ask",
};

let clientInfo = null;
const withheld = [];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, data) {
  const response = { id: command.id, type: "response", command: command.type, success: true };
  if (data !== undefined) response.data = data;
  write(response);
}

// Startup noise the transport layer must drop: fire-and-forget UI updates,
// settings/model notices, and startup bookkeeping entries.
function chatter() {
  write({
    type: "extension_ui_request",
    id: "status-1",
    method: "setStatus",
    statusKey: "boot",
    statusText: "starting",
  });
  write({
    type: "extension_ui_request",
    id: "widget-1",
    method: "setWidget",
    statusKey: "boot",
    widgetLines: ["starting"],
  });
  write({ type: "settings_source_selected", source: "global" });
  write({ type: "model_changed", model: { provider: "synthetic-provider", id: "startup-model" } });
  write({
    type: "entry_appended",
    entry: {
      id: "bookkeeping-1",
      type: "custom",
      customType: "synthetic.startup",
      startupBookkeeping: true,
    },
  });
}

if (scenario !== "silent-start") {
  chatter();
  write({ type: "turn_start" });
  write({ type: "future.additive.event", payload: { ok: true } });
  // A durable, non-bookkeeping entry stays visible.
  write({
    type: "entry_appended",
    entry: { id: "entry-1", type: "custom", customType: "synthetic.kept" },
  });
}

function handle(command) {
  switch (command.type) {
    case "set_client_info":
      clientInfo = command;
      respond(command, { accepted: true });
      return;
    case "get_state":
      respond(command, state);
      return;
    case "probe.client_info":
      respond(command, {
        capabilities: clientInfo?.capabilities ?? null,
        width: clientInfo?.width ?? null,
      });
      return;
    case "probe.environment":
      respond(command, {
        PI_TELEMETRY: process.env.PI_TELEMETRY ?? null,
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? null,
        CODEXHOST_TEST_MARKER: process.env.CODEXHOST_TEST_MARKER ?? null,
      });
      return;
    case "slow":
      if (scenario === "withhold-slow") {
        withheld.push(command);
        return;
      }
      respond(command, { echoed: command.type });
      return;
    case "hold":
      // Never answered: the caller either times out or closes mid-command.
      return;
    case "flush":
      for (const held of withheld.splice(0)) respond(held, { late: true });
      respond(command, { flushed: true });
      return;
    case "refuse":
      write({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: "synthetic refusal",
        errorCode: "streaming",
      });
      return;
    case "chatter-after":
      chatter();
      write({ type: "test.sentinel" });
      respond(command, { sent: true });
      return;
    case "garbage":
      process.stdout.write("this is not JSON\n");
      return;
    case "oversize":
      write({ type: "test.oversize", data: "x".repeat(16 * 1024 * 1024 + 1) });
      return;
    case "stderr":
      process.stderr.write("api_key=sk-synthetic-secret\n");
      respond(command, { wrote: true });
      return;
    case "prompt":
      if (scenario === "exit-mid") process.exit(9);
      respond(command, { disposition: "started" });
      return;
    default:
      respond(command, { echoed: command.type });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (scenario === "silent-start") return;
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  if (scenario === "stubborn") return;
  process.exit(0);
});

if (scenario === "stubborn") {
  // Refuse both clean EOF and SIGTERM so the transport has to escalate.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
