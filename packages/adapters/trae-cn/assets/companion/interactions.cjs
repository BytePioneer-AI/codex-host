function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parse(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw fail("protocolError", "Invalid native interaction history");
  }
}

/** Native pending assistant Items are not durable yet. Keep only live confirmation state. */
class NativeInteractions {
  constructor() {
    this.sessions = new Map();
  }
  expire(sessionId) {
    this.sessions.delete(sessionId);
  }
  observe(sessionId, event) {
    if (!record(event)) return;
    if (event.event === "done") {
      this.expire(sessionId);
      return;
    }
    const payload = event.payload;
    if (!record(payload)) return;
    const messageId = payload.reply_to_message_id;
    if (typeof messageId !== "string" || !messageId) return;
    let state = this.sessions.get(sessionId);
    if (!state || state.messageId !== messageId) {
      state = { messageId, plans: new Map() };
      this.sessions.set(sessionId, state);
    }
    if (event.event !== "plan_item" || typeof payload.id !== "string") return;
    const confirm = payload.confirm_info;
    if (
      record(confirm) &&
      confirm.confirm_status === "unconfirmed" &&
      confirm.auto_confirm !== true &&
      typeof confirm.interaction_instance_id === "string" &&
      confirm.interaction_instance_id &&
      record(payload.tool_call_info)
    ) {
      state.plans.set(payload.id, {
        id: payload.id,
        task_id: payload.task_id,
        confirm_info: confirm,
        tool_call_info: {
          id: payload.tool_call_info.id,
          name: payload.tool_call_info.name,
          params: payload.tool_call_info.params,
        },
      });
    } else if (
      (record(confirm) &&
        (confirm.confirm_status !== "unconfirmed" || confirm.auto_confirm === true)) ||
      ["success", "failed", "canceled", "cancelled"].includes(
        payload.tool_call_info?.result?.status,
      )
    )
      state.plans.delete(payload.id);
  }
  current(sessionId, messageId, planItemId) {
    const state = this.sessions.get(sessionId);
    const plan = state?.messageId === messageId ? state.plans.get(planItemId) : undefined;
    return plan ? { sessionId, messageId, plan } : undefined;
  }
}

/** Revalidate the current event-owned instance; never accept client-supplied question definitions. */
function questionDecision(current, input) {
  if (input.kind !== "question")
    throw fail("unsupported", "Native approval response is not implemented yet");
  if (
    (current && current.sessionId !== input.sessionId) ||
    typeof input.messageId !== "string" ||
    typeof input.planItemId !== "string" ||
    typeof input.interactionId !== "string" ||
    !input.interactionId
  )
    throw fail("invalidRequest", "Missing native interaction identity");
  if (!current || current.messageId !== input.messageId)
    throw fail("invalidState", "Native question is no longer active");
  const plan = current.plan?.id === input.planItemId ? current.plan : undefined;
  const confirm = plan?.confirm_info;
  const tool = plan?.tool_call_info;
  if (
    tool?.name !== "AskUserQuestion" ||
    !record(confirm) ||
    confirm.auto_confirm ||
    confirm.confirm_status !== "unconfirmed" ||
    confirm.interaction_instance_id !== input.interactionId
  )
    throw fail("invalidState", "Native question was closed or superseded");
  const params = parse(tool.params);
  const questions = params?.questions;
  if (!Array.isArray(questions) || !questions.length)
    throw fail("protocolError", "Native question has no questions");
  const data = {
    chat_session_id: input.sessionId,
    plan_item_id: input.planItemId,
    interaction_instance_id: input.interactionId,
    tool_name: "AskUserQuestion",
    type: "tool_confirm",
    decision: input.cancelled === true ? "skip" : "confirm",
  };
  if (input.cancelled === true) return data;
  if (!Array.isArray(input.answers) || input.answers.length !== questions.length)
    throw fail("invalidRequest", "Answer every native question");
  const answers = questions.map((question, index) => {
    if (
      !record(question) ||
      typeof question.question !== "string" ||
      !Array.isArray(question.options) ||
      !question.options.every(
        (option) => record(option) && typeof option.label === "string" && option.label,
      )
    )
      throw fail("protocolError", "Unsupported native question format");
    const labels = new Set(question.options.map((option) => option.label));
    if (labels.size !== question.options.length)
      throw fail("protocolError", "Native question has duplicate option labels");
    const values = input.answers[index];
    if (
      !Array.isArray(values) ||
      !values.length ||
      !values.every((value) => typeof value === "string" && value.trim()) ||
      new Set(values).size !== values.length ||
      (!question.multiSelect && values.length !== 1)
    )
      throw fail("invalidRequest", "Invalid native question answer");
    const other = values.filter((value) => !labels.has(value));
    if (other.length > 1 || other.some((value) => value.length > 1000))
      throw fail(
        "invalidRequest",
        "Native question accepts one other answer of at most 1000 characters",
      );
    return {
      selected_options: [
        ...values.filter((value) => labels.has(value)),
        ...(other.length ? ["__other__"] : []),
      ],
      ...(other.length ? { custom_input: other[0] } : {}),
    };
  });
  // Ignore the model's prefilled params.answers. Only the current explicit reply
  // is sent back, using the same JSON-string params format as the desktop client.
  return { ...data, params: JSON.stringify({ questions, answers }) };
}

const fileTools = new Set([
  "create_file",
  "edit_file_search_replace",
  "Edit",
  "MultiEdit",
  "SearchReplace",
  "write_to_file",
  "Write",
  "NotebookEdit",
  "Read",
  "view_file",
  "view_files",
  "delete_file",
  "DeleteFile",
]);

function approvalKind(tool, params) {
  if (!record(params)) throw fail("protocolError", "Invalid native approval parameters");
  if (tool?.name === "RunCommand") {
    if (typeof params.command !== "string" || !params.command.trim())
      throw fail("protocolError", "Native command approval has no command");
    return "command";
  }
  if (["run_mcp", "ReadMcpResource"].includes(tool?.name)) {
    const server = tool.name === "ReadMcpResource" ? params.server : params.server_name;
    const target = tool.name === "ReadMcpResource" ? params.uri : params.tool_name;
    if (
      typeof server !== "string" ||
      !server.trim() ||
      typeof target !== "string" ||
      !target.trim()
    )
      throw fail("protocolError", "Native MCP approval has no server or target");
    if (params.args !== undefined && Buffer.byteLength(JSON.stringify(params.args), "utf8") > 16384)
      throw fail("unsupported", "Native MCP approval arguments exceed 16 KiB");
    return "mcp";
  }
  if (fileTools.has(tool?.name)) {
    const paths =
      params.file_paths ??
      [params.file_path ?? params.path ?? params.notebook_path, params.renameFilePath].filter(
        Boolean,
      );
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 100 ||
      !paths.every((path) => typeof path === "string" && path.trim() && path.length <= 4096)
    )
      throw fail("protocolError", "Native file approval has no valid paths");
    if (typeof tool.id !== "string" || !tool.id.trim())
      throw fail("protocolError", "Native file approval has no tool-call identity");
    return ["delete_file", "DeleteFile"].includes(tool.name) ? "delete" : "file";
  }
  throw fail("unsupported", "This native tool confirmation is not implemented");
}

/** Per-execution confirmation only; never grant task/device rules or change global policy. */
function approvalDecision(current, input, nativePermissions = true) {
  if (input.kind !== "approval" || !["allowOnce", "deny"].includes(input.action))
    throw fail("invalidRequest", "Unknown native approval action");
  const plan = current?.plan;
  const confirm = plan?.confirm_info;
  if (
    !current ||
    current.sessionId !== input.sessionId ||
    current.messageId !== input.messageId ||
    plan?.id !== input.planItemId ||
    !record(plan?.tool_call_info) ||
    confirm?.confirm_status !== "unconfirmed" ||
    confirm.auto_confirm === true ||
    typeof input.interactionId !== "string" ||
    !input.interactionId ||
    confirm.interaction_instance_id !== input.interactionId
  )
    throw fail("invalidState", "Native approval was closed or superseded");
  const params = parse(plan.tool_call_info.params);
  const kind = approvalKind(plan.tool_call_info, params);
  if (typeof plan.task_id !== "string" || !plan.task_id)
    throw fail("protocolError", "Native approval has no task identity");
  const allowed = input.action === "allowOnce";
  const scoped =
    nativePermissions &&
    (kind === "command" ||
      kind === "file" ||
      (kind === "mcp" &&
        ["mcp_rule_ask", "mcp_tool_execution"].includes(confirm.permission_request_reason) &&
        Array.isArray(confirm.permission_request_mcp_tools) &&
        confirm.permission_request_mcp_tools.length > 0));
  return {
    chat_session_id: input.sessionId,
    task_id: plan.task_id,
    plan_item_id: plan.id,
    ...(allowed && ["file", "delete"].includes(kind)
      ? { toolcall_id: plan.tool_call_info.id }
      : { tool_name: plan.tool_call_info.name }),
    interaction_instance_id: input.interactionId,
    type: "tool_confirm",
    decision: allowed ? "confirm" : "skip",
    ...(scoped ? { permission_scope: allowed ? "execution" : "none" } : {}),
  };
}

module.exports = { questionDecision, approvalDecision, NativeInteractions };
