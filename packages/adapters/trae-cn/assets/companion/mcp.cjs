const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function foldersMatch(left, right) {
  const normalize = (folder) =>
    process.platform === "win32" ? path.resolve(folder).toLowerCase() : path.resolve(folder);
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((folder) => typeof folder === "string") &&
    isDeepStrictEqual(left.map(normalize).sort(), right.map(normalize).sort())
  );
}

/** Writable folders may only narrow the observed workspace, never widen it. */
function foldersWithin(folders, allowed) {
  return (
    folders === undefined ||
    (Array.isArray(folders) &&
      folders.every(
        (folder) =>
          typeof folder === "string" && allowed.some((root) => foldersMatch([folder], [root])),
      ))
  );
}

function reject() {
  throw new Error("Native MCP callback does not match an observed execution");
}

/** An application callback may execute only its current, observed native MCP tool. */
class NativeMcpExecutions {
  #observers = new Map();
  #sessions = new Map();

  watch(sessionId, folders) {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      !Array.isArray(folders) ||
      !folders.length ||
      !folders.every((folder) => typeof folder === "string" && path.isAbsolute(folder))
    )
      return undefined;
    let session = this.#sessions.get(sessionId);
    if (session && !foldersMatch(folders, session.folders)) reject();
    if (!session) {
      session = {
        folders: [...folders],
        observers: new Set(),
        plans: new Map(),
        catalog: new Map(),
        finished: new Set(),
      };
      this.#sessions.set(sessionId, session);
    }
    const observer = Symbol();
    session.observers.add(observer);
    this.#observers.set(observer, sessionId);
    return observer;
  }

  unwatch(observer) {
    const sessionId = this.#observers.get(observer);
    this.#observers.delete(observer);
    const session = this.#sessions.get(sessionId);
    session?.observers.delete(observer);
    if (session && !session.observers.size) this.#sessions.delete(sessionId);
  }

  observe(observer, event) {
    const session = this.#sessions.get(this.#observers.get(observer));
    if (!session || !record(event)) return;
    if (event.event === "done") {
      for (const plan of session.plans.values()) session.finished.add(plan.messageId);
      session.plans.clear();
      session.catalog.clear();
      return;
    }
    const plan = event.payload;
    const tool = plan?.tool_call_info;
    if (
      event.event !== "plan_item" ||
      typeof plan?.id !== "string" ||
      typeof plan.reply_to_message_id !== "string" ||
      session.finished.has(plan.reply_to_message_id) ||
      tool?.name !== "run_mcp"
    )
      return;
    let params;
    try {
      params = typeof tool.params === "string" ? JSON.parse(tool.params) : tool.params;
    } catch {
      return;
    }
    if (!record(params)) return;
    const previous = session.plans.get(plan.id);
    const terminal =
      previous?.terminal === true ||
      ["success", "failed", "cancelled", "canceled"].includes(tool.result?.status);
    session.plans.set(plan.id, {
      messageId: plan.reply_to_message_id,
      ids: [plan.id, tool.id, tool.meta?.llm_toolcall_id].filter(
        (id) => typeof id === "string" && id,
      ),
      params: structuredClone(params),
      available:
        !terminal &&
        (!plan.confirm_info ||
          plan.confirm_info.confirm_status === "confirmed" ||
          plan.confirm_info.auto_confirm === true),
      claimed: previous?.claimed === true,
      terminal,
    });
  }

  catalog(input, result) {
    const session = this.#sessions.get(input?.chatSessionId);
    if (!session || !foldersMatch(input?.workspaceFolders, session.folders)) return;
    session.catalog.clear();
    if (result?.code !== 0 || !Array.isArray(result.data)) return;
    for (const extension of result.data)
      if (
        typeof extension?.id === "string" &&
        typeof extension.label === "string" &&
        Array.isArray(extension.tools)
      )
        session.catalog.set(extension.id, {
          label: extension.label,
          tools: extension.tools
            .map((tool) => tool.name)
            .filter((name) => typeof name === "string"),
        });
  }

  claim(input) {
    const session = this.#sessions.get(input?.chatSessionId);
    if (
      !session ||
      !record(input) ||
      !foldersMatch(input.workspaceFolders, session.folders) ||
      !foldersWithin(input.rwFolders, session.folders) ||
      Object.keys(input).some(
        (key) =>
          ![
            "extensionId",
            "toolName",
            "args",
            "chatSessionId",
            "messageId",
            "toolcallId",
            "planItemId",
            "workspaceFolders",
            "rwFolders",
          ].includes(key),
      )
    )
      reject();
    const matches = [...session.plans.entries()].filter(
      ([id, plan]) =>
        plan.messageId === input.messageId &&
        plan.ids.includes(input.toolcallId) &&
        (input.planItemId === undefined || input.planItemId === id),
    );
    if (matches.length !== 1) reject();
    const plan = matches[0][1];
    const extension = session.catalog.get(input.extensionId);
    if (
      !plan.available ||
      plan.claimed ||
      !extension ||
      plan.params.server_name !== `mcp_${extension.label}` ||
      plan.params.tool_name !== input.toolName ||
      !extension.tools.includes(input.toolName) ||
      !isDeepStrictEqual(plan.params.args, input.args)
    )
      reject();
    // Reserve before the asynchronous application call, including lost/error receipts.
    plan.claimed = true;
    return input;
  }
}

module.exports = { NativeMcpExecutions };
