const path = require("node:path");

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function plans(item) {
  if (item.role !== "assistant") return [];
  let content;
  try {
    content = typeof item.content === "string" ? JSON.parse(item.content) : item.content;
  } catch {
    throw fail("protocolError", "Invalid native command history");
  }
  if (!record(content) || !Array.isArray(content.messages)) return [];
  return content.messages.flatMap((entry) =>
    entry?.type === "plan_item" && record(entry.plan_item) ? [entry.plan_item] : [],
  );
}

const BACKGROUND_STATUSES = new Set([
  "runningskipped",
  "running_skipped",
  "running_in_background",
  "timed_out_moved_to_background",
  "manually_backgrounded",
  "background",
]);

/** The stable selector comes from the owning native message, never caller guesses. */
function backgroundCommand(item, plan) {
  const tool = plan.tool_call_info;
  if (tool?.name !== "RunCommand") return undefined;
  const params = tool.params;
  const result = tool.result;
  const data = result?.data;
  if (!record(params) || !record(data)) return undefined;
  if (
    ["failed", "error", "skipped", "canceled", "cancelled"].includes(result.status) &&
    !data.command_id
  )
    return undefined;
  const status = typeof data.status === "string" ? data.status.toLowerCase() : undefined;
  const background =
    params.blocking === false ||
    data.is_background === true ||
    !!data.run_command_to_bg_reason ||
    !!data.runCommandToBgReason ||
    BACKGROUND_STATUSES.has(status) ||
    result.status === "skipped_run" ||
    plan.confirm_info?.confirm_status === "skipped_run";
  if (!background) return undefined;
  if (
    !identifier(item.reply_to_message_id) ||
    !identifier(plan.id) ||
    !identifier(data.command_id) ||
    !identifier(tool.meta?.llm_toolcall_id) ||
    typeof params.command !== "string" ||
    !params.command.trim() ||
    typeof params.cwd !== "string"
  )
    throw fail("unsupported", "Native background command has no stable execution selector");
  return {
    messageId: item.reply_to_message_id,
    planItemId: plan.id,
    commandId: data.command_id,
    toolCallId: tool.meta.llm_toolcall_id,
    command: params.command,
    cwd: params.cwd,
  };
}

async function readCommandStatus(native, sessionId, projectId, owner) {
  const value = await native.call(
    "toolcall",
    "check_toolhost_command_status",
    {
      session_id: sessionId,
      command_id: owner.commandId,
      tool_call_id: owner.toolCallId,
      plan_item_id: owner.planItemId,
      output_character_count: 16384,
      output_priority: "bottom",
    },
    { chat_session_id: sessionId, project_id: projectId },
  );
  if (value?.found === false)
    throw fail("unavailable", "Native background command state is unavailable; do not restart it");
  const result = value?.result;
  const normalize = (cwd) => {
    const resolved = path.resolve(cwd);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (
    value?.found !== true ||
    value.commandId !== owner.commandId ||
    !record(result) ||
    result.command_id !== owner.commandId ||
    result.command !== owner.command ||
    typeof result.cwd !== "string" ||
    normalize(result.cwd) !== normalize(owner.cwd) ||
    typeof result.output !== "string" ||
    result.output.length > 16384 ||
    !Number.isSafeInteger(result.total_bytes) ||
    result.total_bytes < 0 ||
    typeof result.stdout_complete !== "boolean" ||
    typeof result.user_aborted !== "boolean"
  )
    throw fail("protocolError", "Invalid native background command status or ownership");
  const running = result.status === "running";
  if (
    (!running && !["completed", "exited", "failed", "stopped", "killed"].includes(result.status)) ||
    (running && result.exit_code !== null && result.exit_code !== undefined) ||
    (!running && !Number.isSafeInteger(result.exit_code) && !result.user_aborted)
  )
    throw fail("protocolError", "Native background command has no confirmed outcome");
  // A process exit can precede the final output flush. Keep observing until
  // Native confirms both facts; a launch/exit receipt alone is insufficient.
  const pending = running || !result.stdout_complete;
  return {
    messageId: owner.messageId,
    planItemId: owner.planItemId,
    commandId: owner.commandId,
    status: pending
      ? "running"
      : result.user_aborted
        ? "cancelled"
        : result.exit_code === 0 && ["completed", "exited"].includes(result.status)
          ? "succeeded"
          : "failed",
    output: result.output,
    outputTruncated: result.total_bytes > Buffer.byteLength(result.output),
    ...(!pending && Number.isSafeInteger(result.exit_code) ? { exitCode: result.exit_code } : {}),
  };
}

async function withCommandStatuses(native, item, sessionId, projectId) {
  const owners = plans(item).flatMap((plan) => {
    const owner = backgroundCommand(item, plan);
    return owner ? [owner] : [];
  });
  if (!owners.length) return item;
  if (owners.length > 100 || new Set(owners.map((owner) => owner.commandId)).size !== owners.length)
    throw fail("unsupported", "Native background command history exceeds supported bounds");
  const commandStatuses = [];
  for (const owner of owners)
    commandStatuses.push(await readCommandStatus(native, sessionId, projectId, owner));
  return { ...item, commandStatuses };
}

module.exports = { backgroundCommand, readCommandStatus, withCommandStatuses };
