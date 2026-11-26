#!/usr/bin/env node
// Synthetic OmO classic stdio RPC peer for codexhost transport tests.
// Written for this repository; no OmO source, documentation sample, or asset was
// copied. It speaks only the frame shapes the transport layer consumes.
import fs from "node:fs";
import path from "node:path";
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
  permissionPresetSource: "host_default",
  permissionPresetStatus: "applied",
  effectivePermissionPreset: "ask",
};

if (process.env.FAKE_OMO_PENDING_DIALOGS === "none") state.pendingDialogs = [];
if (process.env.FAKE_OMO_STREAMING === "true") state.isStreaming = true;
if (process.env.FAKE_OMO_SESSION_FILE) {
  // Real 5.1.83 creates the session file at Session start, before any user
  // message, and keeps it after a no-conversation close (task-9 evidence).
  state.sessionFile = process.env.FAKE_OMO_SESSION_FILE;
  fs.mkdirSync(path.dirname(state.sessionFile), { recursive: true });
  fs.writeFileSync(
    state.sessionFile,
    JSON.stringify({ type: "session", id: state.sessionId }) + "\n",
  );
}

let clientInfo = null;
const withheld = [];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Commands the gate/tests must observe after the peer has already exited. */
function controlLog(command) {
  const file = process.env.FAKE_OMO_CONTROL_LOG;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(command)}\n`);
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
  const response = {
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: message,
  };
  if (errorCode) response.errorCode = errorCode;
  write(response);
}

// ---------------------------------------------------------------- session peer
//
// A synthetic classic-RPC session surface for the Harness Session tests: the
// prompt/abort/dialog commands, a durable entry log that `get_entries` and
// `get_tree` answer from, and named Turn scripts that emit the documented event
// shapes. Nothing here is copied from OmO.

const sessionEntries = [];
const sessionReceived = {
  prompts: [],
  aborts: [],
  uiResponses: [],
  steers: [],
  clearQueues: [],
  commands: [],
  setModels: [],
  setThinkingLevels: [],
  setPermissionPresets: [],
};
let sessionEntrySeq = 0;
let sessionTurnSeq = 0;
let sessionLastClientTurnId = null;
let sessionWaitingForAbort = false;
let sessionDialogState = "none";
const sessionControls = {
  promptError: process.env.FAKE_OMO_PROMPT_ERROR ?? null,
  turnScript: process.env.FAKE_OMO_TURN_SCRIPT ?? "full",
  disposition: process.env.FAKE_OMO_PROMPT_DISPOSITION ?? null,
  modelError: process.env.FAKE_OMO_SET_MODEL_ERROR ?? null,
  thinkingErrorMessage: process.env.FAKE_OMO_SET_THINKING_MESSAGE ?? null,
  permissionError: process.env.FAKE_OMO_SET_PERMISSION_ERROR ?? null,
  permissionStatus: process.env.FAKE_OMO_SET_PERMISSION_STATUS ?? "applied",
  modelReceipt: process.env.FAKE_OMO_SET_MODEL_RECEIPT ?? "done",
  confirmModel: process.env.FAKE_OMO_SET_MODEL_CONFIRM !== "false",
  confirmThinking: process.env.FAKE_OMO_SET_THINKING_CONFIRM !== "false",
  confirmPermission: process.env.FAKE_OMO_SET_PERMISSION_CONFIRM !== "false",
  promptTurnId: process.env.FAKE_OMO_PROMPT_NO_TURN_ID !== "1",
  steerMode: process.env.FAKE_OMO_STEER_MODE ?? "queue",
};

// Native same-Turn steering surface: a turn script parks inside an open root
// tool call, the `steer` command answers per mode, and the continuation's user
// entry is appended only when the engine actually consumes the input.
const sessionSteer = {
  toolOpen: false,
  toolCallId: "call-steer-1",
  toolCommand: "ping -n 20 127.0.0.1",
  idleQueue: [],
};

// Configuration surface: the live catalog the peer offers, mirrored to the
// real engine's command set (get_protocol_info / get_available_models /
// get_available_thinking_levels / set_model / set_thinking_level /
// set_permission_preset). Shapes follow the documented protocol; values are
// synthetic.
const sessionConfig = {
  models: [
    {
      provider: "synthetic-provider",
      id: "synthetic-model",
      name: "Synthetic Model",
      reasoning: true,
      supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      contextWindow: 128000,
      maxTokens: 8192,
    },
    {
      provider: "synthetic-provider",
      id: "other-model",
      name: "Synthetic Other",
      reasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high"],
      contextWindow: 64000,
      maxTokens: 4096,
    },
  ],
  protocolCapabilities: [
    "multi_session",
    "session_model_scope",
    "effect_ledger",
    "set_permission_preset_v1",
  ],
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
  state.currentTurnId = null;
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
  state.currentTurnId = null;
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

/** Ends the parked steer tool call once; a second call is a no-op. */
function endSteerTool(clientTurnId) {
  if (!sessionSteer.toolOpen) return false;
  sessionSteer.toolOpen = false;
  write({
    type: "tool_execution_end",
    clientTurnId,
    toolCallId: sessionSteer.toolCallId,
    toolName: "bash",
    result: { content: [{ type: "text", text: "hello" }], details: { exitCode: 0 } },
    isError: false,
  });
  return true;
}

/** Publishes the steer continuation's answer and the Turn terminal. */
function finishSteerTurn(text) {
  const clientTurnId = sessionLastClientTurnId;
  endSteerTool(clientTurnId);
  finishInteractiveTurn(clientTurnId, text);
}

function runTurnScript(script, clientTurnId) {
  switch (script) {
    case "steer-window": {
      // Parks inside an open root tool call so a native steer has a live window.
      write({ type: "turn_start", clientTurnId });
      write({
        type: "message_start",
        clientTurnId,
        message: { role: "assistant", content: [], timestamp: Date.now() },
      });
      write({
        type: "message_update",
        clientTurnId,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Running" },
      });
      write({
        type: "message_end",
        clientTurnId,
        message: {
          ...assistantText("Running"),
          content: [
            { type: "text", text: "Running" },
            {
              type: "toolCall",
              id: sessionSteer.toolCallId,
              name: "bash",
              arguments: { command: sessionSteer.toolCommand },
            },
          ],
          stopReason: "toolUse",
        },
      });
      sessionSteer.toolOpen = true;
      write({
        type: "tool_execution_start",
        clientTurnId,
        toolCallId: sessionSteer.toolCallId,
        toolName: "bash",
        args: { command: sessionSteer.toolCommand },
      });
      return;
    }
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
    case "eval-shell": {
      // Captured real 5.1.83 shape: shell commands run inside the `eval` tool
      // with {language, code, summary} args (task-9 trace).
      write({ type: "turn_start", clientTurnId });
      events([
        {
          type: "tool_execution_start",
          clientTurnId,
          toolCallId: "call-eval-1",
          toolName: "eval",
          args: {
            language: "js",
            code: 'const r = await tool.bash({ command: "ping -n 30 127.0.0.1", timeout: 120 });',
            summary: "Running a long shell command",
          },
        },
        {
          type: "tool_execution_update",
          clientTurnId,
          toolCallId: "call-eval-1",
          toolName: "eval",
          partialResult: { content: [{ type: "text", text: "Pinging 127.0.0.1" }] },
        },
        {
          type: "tool_execution_end",
          clientTurnId,
          toolCallId: "call-eval-1",
          toolName: "eval",
          result: {
            content: [{ type: "text", text: "Pinging 127.0.0.1 with 30 bytes of data" }],
            details: {},
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
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "DONE" },
      });
      write({ type: "message_end", clientTurnId, message: assistantText("DONE") });
      write({
        type: "agent_end",
        clientTurnId,
        messages: [assistantText("DONE")],
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
    case "get_protocol_info":
      respond(command, {
        protocolVersion: 1,
        serverVersion: "5.1.83",
        capabilities: sessionConfig.protocolCapabilities,
        mode: "classic",
        instanceId: "synthetic-instance",
        generation: 1,
        engineVersion: "5.1.83",
        engineOrdinal: [5, 1, 83, 0, 0],
        method_classes: { version: 1, digest: "synthetic" },
        dynamic_versions: {},
      });
      return true;
    case "get_available_models":
      respond(command, { models: sessionConfig.models });
      return true;
    case "get_available_thinking_levels": {
      const row = sessionConfig.models.find(
        (model) =>
          state.model && model.provider === state.model.provider && model.id === state.model.id,
      );
      respond(command, { levels: row ? row.supportedThinkingLevels : ["off"] });
      return true;
    }
    case "set_model": {
      sessionReceived.setModels.push({ ...command });
      if (sessionControls.modelError) {
        respondError(command, sessionControls.modelError);
        return true;
      }
      const row = sessionConfig.models.find(
        (model) => model.provider === command.provider && model.id === command.modelId,
      );
      if (sessionControls.confirmModel && row) {
        state.model = {
          provider: command.provider,
          id: command.modelId,
          name: row.name,
          reasoning: row.reasoning,
        };
      }
      // The engine broadcasts the switch; the transport drops it as startup
      // chatter by design (effective state comes from get_state).
      write({ type: "model_changed", model: { provider: command.provider, id: command.modelId } });
      respond(command, {
        ...(row ?? {
          provider: command.provider,
          id: command.modelId,
          name: "Unknown Synthetic Model",
          reasoning: true,
        }),
        ...(command.effectId
          ? {
              effectId: command.effectId,
              state: sessionControls.modelReceipt,
              effect: {
                effectId: command.effectId,
                kind: "set_model",
                state: sessionControls.modelReceipt,
                disposition: "applied",
              },
            }
          : {}),
      });
      return true;
    }
    case "set_thinking_level": {
      sessionReceived.setThinkingLevels.push({ ...command });
      if (sessionControls.thinkingErrorMessage) {
        // The engine refuses an unsupported level without an errorCode.
        respondError(command, null, sessionControls.thinkingErrorMessage);
        return true;
      }
      if (sessionControls.confirmThinking) state.thinkingLevel = command.level;
      write({ type: "thinking_level_changed", level: command.level });
      respond(
        command,
        command.effectId
          ? {
              effectId: command.effectId,
              state: "done",
              effect: {
                effectId: command.effectId,
                kind: "set_thinking_level",
                state: "done",
                disposition: "applied",
              },
            }
          : {},
      );
      return true;
    }
    case "set_permission_preset": {
      sessionReceived.setPermissionPresets.push({ ...command });
      if (sessionControls.permissionError) {
        respondError(command, sessionControls.permissionError);
        return true;
      }
      state.permissionPreset = command.permissionPreset;
      state.permissionPresetSource = "client";
      state.permissionPresetStatus = "applied";
      if (sessionControls.confirmPermission) {
        state.effectivePermissionPreset = command.permissionPreset;
      }
      respond(command, {
        permissionPreset: command.permissionPreset,
        permissionPresetSource: "client",
        permissionPresetStatus: sessionControls.permissionStatus,
      });
      return true;
    }
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
      if ("modelError" in command) sessionControls.modelError = command.modelError;
      if ("thinkingErrorMessage" in command)
        sessionControls.thinkingErrorMessage = command.thinkingErrorMessage;
      if ("permissionError" in command) sessionControls.permissionError = command.permissionError;
      if ("permissionStatus" in command)
        sessionControls.permissionStatus = command.permissionStatus;
      if ("modelReceipt" in command) sessionControls.modelReceipt = command.modelReceipt;
      if ("confirmModel" in command) sessionControls.confirmModel = command.confirmModel;
      if ("confirmThinking" in command) sessionControls.confirmThinking = command.confirmThinking;
      if ("confirmPermission" in command)
        sessionControls.confirmPermission = command.confirmPermission;
      if ("promptTurnId" in command) sessionControls.promptTurnId = command.promptTurnId;
      if (typeof command.steerMode === "string") sessionControls.steerMode = command.steerMode;
      respond(command, { ...sessionControls });
      return true;
    }
    case "steer.tool-end": {
      const ended = endSteerTool(sessionLastClientTurnId);
      respond(command, { ended });
      return true;
    }
    case "steer.finish": {
      finishSteerTurn("finished");
      respond(command, { finished: true });
      return true;
    }
    case "clear_queue": {
      sessionReceived.clearQueues.push({ ...command });
      controlLog({ type: "clear_queue" });
      respond(command, { steering: sessionSteer.idleQueue.splice(0), followUp: [] });
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
      const nativeTurnId = `native-turn-${sessionTurnSeq}`;
      const script = sessionControls.turnScript;
      if (sessionControls.disposition === "handled") {
        respond(command, { disposition: "handled" });
        return true;
      }
      state.currentTurnId = nativeTurnId;
      respond(command, {
        disposition: "started",
        ...(sessionControls.promptTurnId ? { turnId: nativeTurnId } : {}),
        clientTurnId: command.clientTurnId ?? null,
      });
      queueMicrotask(() => runTurnScript(script, command.clientTurnId ?? null));
      return true;
    }
    case "steer": {
      sessionReceived.steers.push({ ...command });
      const expected = command.expectedTurnId;
      const mode = sessionControls.steerMode;
      const targetRunning =
        sessionSteer.toolOpen && state.currentTurnId !== null && expected === state.currentTurnId;
      if (mode === "conflict" || !targetRunning) {
        // The native `expectedTurnId` guard: nothing is queued for another turn.
        respondError(command, "turn_conflict", "no running turn matches expectedTurnId");
        if (sessionSteer.toolOpen) queueMicrotask(() => finishSteerTurn("conflict"));
        return true;
      }
      if (mode === "handled") {
        respond(command, { disposition: "handled" });
        queueMicrotask(() => finishSteerTurn("handled"));
        return true;
      }
      if (mode === "late-settle") {
        // The target settles before the answer is written; the text only joins
        // the idle queue and must be removable by clear_queue.
        sessionSteer.idleQueue.push(command.message);
        finishSteerTurn("settled first");
        setTimeout(() => respond(command, { disposition: "queued" }), 25).unref?.();
        return true;
      }
      if (mode === "withhold") {
        setTimeout(() => finishSteerTurn("no answer"), 30).unref?.();
        return true;
      }
      if (mode === "queue-silent") {
        // Acknowledged admission with no persisted user entry: the settlement
        // count proves the input never joined the Turn.
        sessionSteer.idleQueue.push(command.message);
        respond(command, { disposition: "queued" });
        queueMicrotask(() => finishSteerTurn("silent"));
        return true;
      }
      appendUserEntry(command.message);
      respond(command, { disposition: "queued" });
      queueMicrotask(() => finishSteerTurn("both"));
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
