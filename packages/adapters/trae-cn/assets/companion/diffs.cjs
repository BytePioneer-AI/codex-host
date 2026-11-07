const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled"]);

function failure(message) {
  return Object.assign(new Error(message), { code: "protocolError" });
}

/** Native plan contents omit file bodies; the desktop reads its message snapshot. */
async function withFileDiffs(native, message, sessionId, projectId) {
  if (message.role !== "assistant" || !TERMINAL.has(message.status)) return message;
  let content;
  try {
    content = typeof message.content === "string" ? JSON.parse(message.content) : message.content;
  } catch {
    return message;
  }
  const plans = content?.messages
    ?.filter(
      (entry) =>
        entry.type === "plan_item" &&
        (entry.plan_item?.tool_call_info?.result?.data?.can_show_diff === true ||
          (["DeleteFile", "delete_file"].includes(entry.plan_item?.tool_call_info?.name) &&
            ["success", "failed", "canceled", "cancelled"].includes(
              entry.plan_item?.tool_call_info?.result?.status,
            ))),
    )
    .map((entry) => entry.plan_item);
  if (!plans?.length) return message;
  if (
    typeof message.reply_to_message_id !== "string" ||
    !message.reply_to_message_id ||
    plans.some((plan) => typeof plan.id !== "string" || !plan.id)
  )
    throw failure("Native file edits have no originating message or plan identity");
  const result = await native.call("snapshot", "get_message_ai_edit_file_diff_list", {
    project_id: projectId,
    session_id: sessionId,
    message_id: message.reply_to_message_id,
  });
  if (!Array.isArray(result?.file_diffs)) throw failure("Invalid native message file diffs");
  const fileDiffs = result.file_diffs.map((diff) => {
    // Native deletion snapshots use null for the absent side, and creation may
    // do the same. Only that action's absent side can mean an empty document.
    const before =
      diff?.file_action === "added" && diff.before_content === null ? "" : diff?.before_content;
    const after =
      diff?.file_action === "deleted" && diff.after_content === null ? "" : diff?.after_content;
    if (
      !diff ||
      typeof diff.file_path !== "string" ||
      !diff.file_path.trim() ||
      !["added", "modified", "deleted"].includes(diff.file_action) ||
      typeof before !== "string" ||
      typeof after !== "string"
    )
      throw failure("Native file diff is missing its action or complete contents");
    return {
      file_path: diff.file_path,
      file_action: diff.file_action,
      before_content: before,
      after_content: after,
    };
  });
  const bytes = fileDiffs.reduce(
    (total, diff) =>
      total +
      Buffer.byteLength(diff.before_content, "utf8") +
      Buffer.byteLength(diff.after_content, "utf8"),
    0,
  );
  if (bytes > 2 * 1024 * 1024)
    throw Object.assign(new Error("Native message file diffs exceed the 2 MiB content limit"), {
      code: "unsupported",
    });
  return { ...message, fileDiffs, fileDiffSourceIds: plans.map((plan) => plan.id) };
}

module.exports = { withFileDiffs };
