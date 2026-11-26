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

if (process.env.FAKE_OMO_PENDING_DIALOGS === "none") state.pendingDialogs = [];
if (process.env.FAKE_OMO_STREAMING === "true") state.isStreaming = true;

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

function respondError(command, errorCode, message = "synthetic refusal") {
  write({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: message,
    errorCode,
  });
}

// ---------------------------------------------------------------- session peer
//
// A synthetic classic-RPC session surface for the Harness Session tests: the
// prompt/abort/dialog commands, a durable entry log that `get_entries` and
// `get_tree` answer from, and named Turn scripts that emit the documented event
// shapes. Nothing here is copied from OmO.

const sessionEntries = [];
const sessionReceived = { prompts: [], aborts: [], uiResponses: [], commands: [] };
let sessionEntrySeq = 0;
let sessionTurnSeq = 0;
let sessionLastClientTurnId = null;
let sessionWaitingForAbort = false;
let sessionDialogState = "none";
const sessionControls = {
  promptError: process.env.FAKE_OMO_PROMPT_ERROR ?? null,
  turnScript: process.env.FAKE_OMO_TURN_SCRIPT ?? "full",
  disposition: process.env.FAKE_OMO_PROMPT_DISPOSITION ?? null,
};

function entryId() {
  sessionEntrySeq += 1;
  return `u-${sessionEntrySeq}`;
}

function appendUserEntry(message) {
  const entry = {
    type: "message",
    id: entryId(),
    parentId: sessionEntries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    inputSource: "rpc",
    message: { role: "user", content: message, timestamp: Date.now() },
  };
  sessionEntries.push(entry);
  if (process.env.FAKE_OMO_NO_USER_ENTRY_EVENT !== "1") {
    write({ type: "entry_appended", entry });
  }
  return entry;
}

function events(frames) {
  for (const frame of frames) write(frame);
}

function assistantText(text, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "synthetic",
    provider: "synthetic-provider",
    model: "synthetic-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    timestamp: Date.now(),
    ...extra,
  };
}

function settle(clientTurnId, aborted = false) {
  if (aborted) {
    write({
      type: "agent_end",
      clientTurnId,
      messages: [],
      willRetry: false,
      aborted: true,
      abortSource: "user",
    });
  }
  write({ type: "agent_settled" });
}

function finishInteractiveTurn(clientTurnId, text) {
  write({
    type: "message_start",
    clientTurnId,
    message: { role: "assistant", content: [], timestamp: Date.now() },
  });
  write({
    type: "message_update",
    clientTurnId,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  write({ type: "message_end", clientTurnId, message: assistantText(text) });
  write({ type: "agent_end", clientTurnId, messages: [assistantText(text)], willRetry: false });
  write({ type: "agent_settled" });
}

function runTurnScript(script, clientTurnId) {
  switch (script) {
    case "full": {
      write({ type: "turn_start", clientTurnId });
      write({
        type: "message_start",
        clientTurnId,
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
      events([
        {
          type: "message_update",
          clientTurnId,
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think" },
        },
        {
          type: "message_update",
          clientTurnId,
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" },
        },
        {
          type: "message_update",
          clientTurnId,
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" },
        },
      ]);
      write({
        type: "message_end",
        clientTurnId,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thinking" },
            { type: "text", text: "Hello" },
            { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls" } },
          ],
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      });
      events([
        {
          type: "tool_execution_start",
          clientTurnId,
          toolCallId: "call-bash-1",
          toolName: "bash",
          args: { command: "ls -la", cwd: "/tmp" },
        },
        {
          type: "tool_execution_update",
          clientTurnId,
          toolCallId: "call-bash-1",
          toolName: "bash",
          partialResult: { content: [{ type: "text", text: "file-a\n" }] },
        },
        {
          type: "tool_execution_end",
          clientTurnId,
          toolCallId: "call-bash-1",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "file-a\nfile-b" }],
            details: { exitCode: 0 },
          },
          isError: false,
        },
        {
          type: "tool_execution_start",
          clientTurnId,
          toolCallId: "call-edit-1",
          toolName: "edit",
          args: { path: "/tmp/a.txt" },
        },
        {
          type: "tool_execution_end",
          clientTurnId,
          toolCallId: "call-edit-1",
          toolName: "edit",
          result: {
            content: [{ type: "text", text: "edited" }],
            details: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new" },
          },
          isError: false,
        },
      ]);
      write({
        type: "message_start",
        clientTurnId,
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
      write({
        type: "message_update",
        clientTurnId,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done" },
      });
      write({ type: "message_end", clientTurnId, message: assistantText("Done") });
      write({
        type: "agent_end",
        clientTurnId,
        messages: [assistantText("Done")],
        willRetry: false,
      });
      write({ type: "agent_settled" });
      return;
    }
    case "agent-end-first": {
      write({ type: "turn_start", clientTurnId });
      write({ type: "agent_end", clientTurnId, messages: [], willRetry: true });
      write({
        type: "message_start",
        clientTurnId,
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
      write({
        type: "message_update",
        clientTurnId,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Retried" },
      });
      write({ type: "message_end", clientTurnId, message: assistantText("Retried") });
      write({ type: "agent_end", clientTurnId, messages: [assistantText("Retried")] });
      write({ type: "agent_settled" });
      return;
    }
    case "cancel": {
      write({ type: "turn_start", clientTurnId });
      write({
        type: "message_start",
        clientTurnId,
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
      write({
        type: "message_update",
        clientTurnId,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" },
      });
      state.isStreaming = true;
      sessionWaitingForAbort = true;
      return;
    }
    case "interaction": {
      write({ type: "turn_start", clientTurnId });
      write({
        type: "tool_execution_start",
        clientTurnId,
        toolCallId: "call-edit-1",
        toolName: "edit",
        args: { path: "/tmp/a.txt" },
      });
      write({
        type: "extension_ui_request",
        id: "ui-approve-1",
        method: "select",
        title: "Permission required: edit",
        options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
        toolCallId: "call-edit-1",
      });
      sessionDialogState = "approval";
      return;
    }
    case "interaction-timeout": {
      write({ type: "turn_start", clientTurnId });
      write({
        type: "extension_ui_request",
        id: "ui-confirm-1",
        method: "confirm",
        title: "Clear session?",
        message: "All messages will be lost.",
        timeout: 60,
      });
      sessionDialogState = "timeout";
      setTimeout(() => finishInteractiveTurn(clientTurnId, "after timeout"), 160).unref?.();
      return;
    }
    case "interrupted": {
      write({ type: "turn_start", clientTurnId });
      write({
        type: "tool_execution_start",
        clientTurnId,
        toolCallId: "call-interrupted-1",
        toolName: "bash",
        args: { command: "sleep 60" },
      });
      write({
        type: "tool_execution_end",
        clientTurnId,
        toolCallId: "call-interrupted-1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "interrupted" }],
          details: { interrupted: { reason: "host_restart" } },
        },
        isError: true,
      });
      write({ type: "agent_end", clientTurnId, messages: [] });
      write({ type: "agent_settled" });
      return;
    }
    case "tool-error-recovery": {
      write({ type: "turn_start", clientTurnId });
      write({
        type: "tool_execution_start",
        clientTurnId,
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "false" },
      });
      write({
        type: "tool_execution_end",
        clientTurnId,
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "exit 1" }], details: { exitCode: 1 } },
        isError: true,
      });
      write({
        type: "message_start",
        clientTurnId,
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
      write({
        type: "message_update",
        clientTurnId,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered" },
      });
      write({ type: "message_end", clientTurnId, message: assistantText("Recovered") });
      write({ type: "agent_end", clientTurnId, messages: [assistantText("Recovered")] });
      write({ type: "agent_settled" });
      return;
    }
    case "transcript-fault": {
      write({ type: "turn_start", clientTurnId });
      write({ type: "transcript_write_failed", role: "assistant", errorMessage: "disk full" });
      return;
    }
    case "recovered": {
      write({
        type: "session_recovered",
        cause: "full disk",
        backupPath: "/tmp/session.jsonl.torn-1",
        droppedBytes: 12,
      });
      return;
    }
    default:
      return;
  }
}

function sessionPage(command) {
  const ids = sessionEntries.map((entry) => entry.id);
  let lower = 0;
  if (typeof command.since === "string") {
    const index = ids.indexOf(command.since);
    if (index < 0) return null;
    lower = index + 1;
  }
  let upper = sessionEntries.length;
  if (typeof command.before === "string") {
    const index = ids.indexOf(command.before);
    if (index < 0) return null;
    upper = index;
  }
  const range = sessionEntries.slice(lower, upper);
  if (typeof command.tail === "number") {
    const page = range.slice(Math.max(0, range.length - command.tail));
    const hasMore = range.length > page.length;
    return { entries: page, hasMore, ...(hasMore ? { next_before: page[0].id } : {}) };
  }
  const limit = typeof command.limit === "number" ? command.limit : range.length;
  const page = range.slice(0, limit);
  const hasMore = range.length > page.length;
  return { entries: page, hasMore, ...(hasMore ? { nextSince: page.at(-1).id } : {}) };
}

function handleSession(command) {
  switch (command.type) {
    case "get_state":
      respond(command, { ...state, messageCount: sessionEntries.length });
      return true;
    case "get_tree":
      respond(command, {
        tree: sessionEntries.length === 0 ? [] : [{ entry: sessionEntries[0], children: [] }],
        leafId: sessionEntries.at(-1)?.id ?? null,
      });
      return true;
    case "get_entries": {
      sessionReceived.commands.push("get_entries");
      const page = sessionPage(command);
      if (!page) {
        respondError(command, "not_found", "no such entry");
        return true;
      }
      respond(command, page);
      return true;
    }
    case "probe.received":
      respond(command, {
        ...sessionReceived,
        entries: sessionEntries.map((entry) => ({
          id: entry.id,
          role: entry.message?.role ?? null,
        })),
        dialogState: sessionDialogState,
        isStreaming: state.isStreaming,
      });
      return true;
    case "emit":
      events(Array.isArray(command.frames) ? command.frames : []);
      respond(command, { emitted: Array.isArray(command.frames) ? command.frames.length : 0 });
      return true;
    case "set_controls": {
      if ("promptError" in command) sessionControls.promptError = command.promptError;
      if (typeof command.turnScript === "string") sessionControls.turnScript = command.turnScript;
      if ("disposition" in command) sessionControls.disposition = command.disposition;
      respond(command, { ...sessionControls });
      return true;
    }
    case "prompt": {
      sessionReceived.prompts.push({
        message: command.message,
        clientTurnId: command.clientTurnId ?? null,
      });
      sessionLastClientTurnId = command.clientTurnId ?? null;
      if (sessionControls.promptError) {
        respondError(command, sessionControls.promptError);
        return true;
      }
      appendUserEntry(command.message);
      sessionTurnSeq += 1;
      const script = sessionControls.turnScript;
      if (sessionControls.disposition === "handled") {
        respond(command, { disposition: "handled" });
        return true;
      }
      respond(command, {
        disposition: "started",
        turnId: `native-turn-${sessionTurnSeq}`,
        clientTurnId: command.clientTurnId ?? null,
      });
      queueMicrotask(() => runTurnScript(script, command.clientTurnId ?? null));
      return true;
    }
    case "abort": {
      sessionReceived.aborts.push({ ...command });
      if (process.env.FAKE_OMO_ABORT_ERROR) {
        respondError(command, process.env.FAKE_OMO_ABORT_ERROR);
        return true;
      }
      const delayMs = Number(process.env.FAKE_OMO_ABORT_DELAY_MS ?? 0);
      const idle = process.env.FAKE_OMO_ABORT_IDLE !== "false";
      const answer = () => {
        if (idle) state.isStreaming = false;
        respond(command, { stopped: idle, idle, cleared: 0 });
        if (process.env.FAKE_OMO_ABORT_SETTLES !== "false" && sessionWaitingForAbort) {
          sessionWaitingForAbort = false;
          setTimeout(
            () => {
              state.isStreaming = false;
              settle(sessionLastClientTurnId, true);
            },
            Number(process.env.FAKE_OMO_ABORT_SETTLE_DELAY_MS ?? 40),
          ).unref?.();
        }
      };
      if (delayMs > 0) setTimeout(answer, delayMs).unref?.();
      else answer();
      return true;
    }
    case "extension_ui_response": {
      sessionReceived.uiResponses.push({ ...command });
      respond(command, { accepted: true });
      if (sessionDialogState === "approval") {
        if (command.value === "Deny with feedback") {
          write({
            type: "extension_ui_request",
            id: "ui-feedback-1",
            method: "input",
            title: "Why deny?",
            toolCallId: "call-edit-1",
          });
          sessionDialogState = "feedback";
          return true;
        }
        sessionDialogState = "none";
        queueMicrotask(() => finishInteractiveTurn(sessionLastClientTurnId, "answered"));
        return true;
      }
      if (sessionDialogState === "feedback") {
        sessionDialogState = "none";
        queueMicrotask(() => finishInteractiveTurn(sessionLastClientTurnId, "denied"));
        return true;
      }
      return true;
    }
    default:
      return false;
  }
}

function handle(command) {
  if (scenario.startsWith("session") && handleSession(command)) return;
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
