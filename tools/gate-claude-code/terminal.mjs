const CANCEL_TERMINAL_REASONS = new Set(["aborted_streaming", "aborted_tools"]);
const KNOWN_MESSAGE_TYPES = new Set([
  "assistant",
  "auth_status",
  "control_cancel_request",
  "control_request",
  "control_response",
  "hook_progress",
  "prompt_suggestion",
  "rate_limit_event",
  "result",
  "stream_event",
  "system",
  "tool_progress",
  "tool_use_summary",
  "user",
]);

export function classifyClaudeResult(
  result,
  { cancelRequested = false, assistantErrors = [] } = {},
) {
  if (!result || result.type !== "result") {
    return { outcome: "invalid", reason: "missing_result" };
  }

  const terminalReason =
    typeof result.terminal_reason === "string" ? result.terminal_reason : "missing";
  if (cancelRequested && CANCEL_TERMINAL_REASONS.has(terminalReason)) {
    return { outcome: "cancelled", reason: terminalReason };
  }

  const hasAssistantError = assistantErrors.some(
    (error) => typeof error === "string" && error.length > 0,
  );
  const completed = terminalReason === "completed" || terminalReason === "missing";
  if (
    result.subtype === "success" &&
    result.is_error === false &&
    completed &&
    !hasAssistantError
  ) {
    return { outcome: "succeeded", reason: terminalReason };
  }

  if (CANCEL_TERMINAL_REASONS.has(terminalReason)) {
    return {
      outcome: "failed",
      reason: cancelRequested ? terminalReason : `unrequested_${terminalReason}`,
    };
  }

  if (hasAssistantError) return { outcome: "failed", reason: "assistant_error" };
  if (result.is_error === true) return { outcome: "failed", reason: terminalReason };
  return { outcome: "failed", reason: `inconsistent_${terminalReason}` };
}

export function assistantErrors(messages) {
  return messages.flatMap((message) =>
    message?.type === "assistant" && typeof message.error === "string" ? [message.error] : [],
  );
}

export function summarizeNativeMessages(messages, { cancelRequested = false } = {}) {
  const typeCounts = {};
  const subtypeCounts = {};
  const unknownTypeCounts = {};
  let sessionMissingCount = 0;
  const sessionIds = new Set();
  const results = [];

  for (const message of messages) {
    const type = typeof message?.type === "string" ? message.type : "<missing>";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    if (!KNOWN_MESSAGE_TYPES.has(type)) {
      unknownTypeCounts[type] = (unknownTypeCounts[type] ?? 0) + 1;
    }
    if (typeof message?.subtype === "string") {
      subtypeCounts[message.subtype] = (subtypeCounts[message.subtype] ?? 0) + 1;
    }
    if (typeof message?.session_id === "string") sessionIds.add(message.session_id);
    else sessionMissingCount += 1;
    if (type === "result") results.push(message);
  }

  const errors = assistantErrors(messages);
  return {
    typeCounts,
    subtypeCounts,
    unknownTypeCounts,
    sessionCount: sessionIds.size,
    sessionMissingCount,
    resultCount: results.length,
    terminal:
      results.length === 1
        ? classifyClaudeResult(results[0], { cancelRequested, assistantErrors: errors })
        : { outcome: "invalid", reason: `result_count_${results.length}` },
    assistantErrorKinds: [...new Set(errors)].sort(),
  };
}
