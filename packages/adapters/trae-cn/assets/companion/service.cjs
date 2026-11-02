const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { publicModels, nativeModel, readModels, prepareModel } = require("./models.cjs");
const { questionDecision, approvalDecision, NativeInteractions } = require("./interactions.cjs");
const { withFileDiffs } = require("./diffs.cjs");
const { forkNativeSession } = require("./history.cjs");

function invalid(message) {
  return Object.assign(new Error(message), { code: "invalidRequest" });
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`Missing ${name}`);
  return value;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameFolder(left, right) {
  const normalize = (folder) =>
    process.platform === "win32" ? path.resolve(folder).toLowerCase() : path.resolve(folder);
  return normalize(left) === normalize(right);
}

function parse(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function publicModelState(value) {
  const model = parse(value);
  if (!record(model)) return undefined;
  return Object.fromEntries(
    [
      "provider",
      "config_name",
      "display_model_name",
      "model_name",
      "config_source",
      "is_preset",
      "reasoning_effort",
      "reasoning_effort_level",
      "context_window_size",
    ]
      .filter((key) => model[key] !== undefined)
      .map((key) => [key, model[key]]),
  );
}

/** Only native numeric counters cross the bridge; display strings are not token facts. */
function publicTokenUsage(value) {
  const usage = parse(value);
  if (!record(usage)) return undefined;
  const result = Object.fromEntries(
    [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "reasoning_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "prompt_tokens_total",
      "completion_tokens_total",
      "last_turn_total_tokens",
      "max_tokens",
    ]
      .filter((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
      .map((key) => [key, usage[key]]),
  );
  return Object.keys(result).length ? result : undefined;
}

/** Native errors can embed account/config objects. Keep only the short diagnostic prefix. */
function publicError(value) {
  const error = parse(value) ?? value;
  const code = record(error) ? error.code : undefined;
  let message = record(error)
    ? error.message
    : typeof error === "string"
      ? error
      : "TRAE CN request failed";
  if (typeof message !== "string") message = "TRAE CN request failed";
  message = message
    .split(/[\r\n{]/, 1)[0]
    .slice(0, 240)
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/((?:api[_ -]?key|token|authorization)\s*[:=]\s*)\S+/gi, "$1[redacted]");
  return { ...(typeof code === "number" || typeof code === "string" ? { code } : {}), message };
}

function publicHistoryItem(item) {
  const value = Object.fromEntries(
    [
      "chat_session_id",
      "message_id",
      "turn_id",
      "status",
      "message_type",
      "role",
      "message_index",
      "content",
      "reply_to_message_id",
      "revertible",
      "agent_type",
      "agent_id",
      "agent_name",
      "created_at",
      "chat_start_time",
      "chat_end_time",
      "chat_process_version",
      "agent_process_support",
      "is_worktree",
    ]
      .filter((key) => item[key] !== undefined)
      .map((key) => [key, item[key]]),
  );
  const context = parse(item.user_message_context);
  const model = publicModelState(context?.model_info);
  if (model) value.model = model;
  const usage = publicTokenUsage(item.token_usage);
  if (usage) value.tokenUsage = usage;
  if (item.error) value.error = publicError(item.error);
  return value;
}

function publicEvent(event) {
  if (!record(event) || typeof event.event !== "string") throw invalid("Invalid native event");
  const payload = event.payload;
  if (["metadata", "message_context_update"].includes(event.event)) {
    const context = parse(payload?.user_message_context);
    return {
      event: event.event,
      id: event.__event_id__,
      payload: {
        ...Object.fromEntries(
          [
            "message_id",
            "turn_id",
            "session_id",
            "status",
            "message_type",
            "message_index",
            "reply_to_message_id",
            "agent_type",
            "agent_id",
            "agent_name",
            "created_at",
            "revertible",
            "metadata_status",
            "is_worktree",
            "__packet_seq__",
          ]
            .filter((key) => payload?.[key] !== undefined)
            .map((key) => [key, payload[key]]),
        ),
        model: publicModelState(context?.model_info ?? payload?.model_info),
      },
    };
  }
  if (event.event === "model_config")
    return { event: event.event, id: event.__event_id__, payload: publicModelState(payload) };
  if (event.event === "error")
    return { event: event.event, id: event.__event_id__, payload: publicError(payload) };
  // Public tool/answer content must retain its native structure and arbitrary user output.
  // Account and model request envelopes are not part of these event payloads.
  if (
    [
      "plan_item",
      "done",
      "token_usage",
      "context_usage",
      "context_token_usage",
      "timing_events",
      "session_title_message",
      "session_icon_message",
      "user_decision_request",
    ].includes(event.event)
  )
    return { event: event.event, id: event.__event_id__, payload };
  throw Object.assign(new Error(`Unsupported TRAE CN event: ${event.event}`), {
    code: "unsupported",
  });
}

const { requestedPermission } = require("./permissions.cjs");

class DesktopService {
  constructor(
    native,
    application,
    workspaceFolders,
    agentType = "builder_v3",
    requestSettings = async () => ({}),
    historySettings = async () => ({ forkFromMessage: false, forkFromSession: false }),
    modelSettings = async () => ({ internal: false }),
    permissionSettings = async () => undefined,
  ) {
    this.native = native;
    this.historySettings = historySettings;
    this.modelSettings = modelSettings;
    this.permissionSettings = permissionSettings;
    this.application = application;
    this.workspaceFolders = [...workspaceFolders];
    this.agentType = agentType;
    this.starting = new Set();
    this.requestSettings = requestSettings;
    this.responseAttempts = new Set();
    this.interactions = new NativeInteractions();
  }

  async readSession(sessionId) {
    const session = await this.native.call("lite", "get_chat_session", {
      chat_session_id: sessionId,
    });
    if (session.chat_session_id !== sessionId)
      throw invalid("TRAE CN returned a different session");
    if (!Number.isInteger(session.status) || session.status < 1 || session.status > 10)
      throw Object.assign(new Error("Invalid native Session status"), { code: "protocolError" });
    const projectId = text(session.local_project_id, "native project ID");
    const project = await this.native.call("lite", "get_or_create_project_v2", {
      project_id: projectId,
    });
    if (project.project_id !== projectId) throw invalid("TRAE CN returned a different project");
    const folders = Array.isArray(project.workspace_folders)
      ? project.workspace_folders
      : typeof project.single_root_workspace_folder === "string"
        ? [project.single_root_workspace_folder]
        : [];
    if (
      !folders.length ||
      !folders.every(
        (folder) =>
          typeof folder === "string" &&
          this.workspaceFolders.some((allowed) => sameFolder(folder, allowed)),
      )
    )
      throw Object.assign(
        new Error("The native Session belongs to a different TRAE CN workspace"),
        { code: "configurationRequired" },
      );
    return { session, projectId, folders };
  }

  async inspect(refresh = false) {
    const pool = await readModels(this.native, this.agentType, refresh);
    const permissions = await this.permissionSettings();
    return {
      application: this.application,
      workspaceFolders: this.workspaceFolders,
      agentType: this.agentType,
      models: publicModels(pool, await this.modelSettings()),
      configuration: { modelSelection: "per-request", thinkingSelection: "per-request" },
      interactions: { fileAndMcpApprovals: true },
      history: await this.historySettings(),
      ...(permissions ? { permissions } : {}),
    };
  }

  async call(method, input = {}) {
    if (!record(input)) throw invalid("Invalid bridge request");
    switch (method) {
      case "preparePermission": {
        if (input.sessionId !== undefined)
          await this.readSession(text(input.sessionId, "session ID"));
        return {
          permissionModeId: requestedPermission(
            await this.permissionSettings(),
            input.permissionModeId,
          ),
        };
      }
      case "prepareModel": {
        if (input.sessionId !== undefined)
          await this.readSession(text(input.sessionId, "session ID"));
        return prepareModel(
          this.native,
          this.agentType,
          text(input.modelId, "model ID"),
          input.thinking,
          await this.modelSettings(),
        );
      }
      case "settings":
        return this.requestSettings();
      case "historySettings":
        return this.historySettings();
      case "fork":
        return forkNativeSession(this, input);
      case "create": {
        const cwd =
          typeof input.cwd === "string"
            ? input.cwd
            : this.workspaceFolders.length === 1
              ? this.workspaceFolders[0]
              : undefined;
        if (!cwd || !this.workspaceFolders.some((folder) => sameFolder(folder, cwd)))
          throw invalid("Choose a folder open in this TRAE CN workspace");
        // create_chat_session does not bind workspace_folders itself: without a native
        // Project it silently falls back to a temporary directory owned by Desktop.
        const project = await this.native.call("lite", "get_or_create_project_v2", {
          project_kind: "workspace",
          workspace_type: "single_root",
          single_root_workspace_folder: cwd,
          workspace_folders: [cwd],
        });
        const projectId = text(project.project_id, "native project ID");
        const value = await this.native.call(
          "lite",
          "create_chat_session",
          {
            title: typeof input.title === "string" ? input.title : "CodexHost",
            local_project_id: projectId,
            session_type: "side_chat",
          },
          { project_id: projectId },
        );
        return {
          sessionId: text(value.chat_session_id, "native session ID"),
          projectId,
        };
      }
      case "snapshot": {
        const sessionId = text(input.sessionId, "session ID");
        const { session, projectId, folders } = await this.readSession(sessionId);
        const items = [];
        const pages = new Set();
        let pageToken;
        do {
          const history = await this.native.call("lite", "get_messages", {
            chat_session_id: sessionId,
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          });
          if (!Array.isArray(history.items)) throw invalid("Invalid native history");
          for (const item of history.items) {
            if (item.chat_session_id !== sessionId)
              throw invalid("History contains a different session");
            items.push(
              await withFileDiffs(this.native, publicHistoryItem(item), sessionId, projectId),
            );
          }
          pageToken = history.next_page_token;
          if (pageToken) {
            if (typeof pageToken !== "string" || pages.has(pageToken))
              throw invalid("Invalid native history cursor");
            pages.add(pageToken);
          }
        } while (pageToken);
        return { sessionId, projectId, workspaceFolders: folders, status: session.status, items };
      }
      case "start": {
        const sessionId = text(input.sessionId, "session ID");
        const modelId = text(input.modelId, "model ID");
        const content = text(input.text, "message text");
        if (this.starting.has(sessionId))
          throw Object.assign(new Error("TRAE CN Session is already admitting a Turn"), {
            code: "sessionBusy",
          });
        this.starting.add(sessionId);
        try {
          const { session, projectId } = await this.readSession(sessionId);
          // A newly created empty Session is Pending too. Only an empty native
          // history proves it has no queued user message; do not confuse this
          // state with native work already admitted by another writer.
          const pending =
            session.status === 1
              ? await this.native.call("lite", "get_messages", {
                  chat_session_id: sessionId,
                  page_size: 1,
                })
              : undefined;
          if (pending && !Array.isArray(pending.items))
            throw invalid("Invalid native pending history");
          if (
            [2, 3, 8, 9, 10].includes(session.status) ||
            pending?.items.length ||
            pending?.next_page_token ||
            (typeof pending?.total === "number" && pending.total > 0)
          )
            throw Object.assign(new Error("TRAE CN Session has an active Turn"), {
              code: "sessionBusy",
            });
          const pool = await readModels(this.native, this.agentType);
          const model = nativeModel(pool, modelId, input.thinking, await this.modelSettings());
          const settings = await this.requestSettings();
          const permissions = await this.permissionSettings();
          const permissionModeId =
            permissions || input.permissionModeId !== undefined
              ? requestedPermission(permissions, input.permissionModeId)
              : "manual_approval";
          const messageId =
            typeof input.messageId === "string" && input.messageId ? input.messageId : randomUUID();
          const result = await this.native.call(
            "lite",
            "send_message",
            {
              chat_session_id: sessionId,
              message_id: messageId,
              content: [{ type: "text", text_content: content }],
              query: JSON.stringify([{ type: "text", data: { content } }]),
              model_name: model.config_name,
              provider: model.provider,
              config_source: model.config_source,
              custom_model: model,
              custom_model_type: model.custom_model_type,
              agent_type: this.agentType,
              agent_id: this.agentType,
              is_in_code_mode: true,
              // Desktop's buildSendMessageRequest places the profile on the
              // message itself; client_info alone does not select its policy.
              permission_profile_id: permissionModeId,
              ...(settings.ask_question_config
                ? { ask_question_config: settings.ask_question_config }
                : {}),
            },
            {
              chat_session_id: sessionId,
              project_id: projectId,
              permission_profile_id: permissionModeId,
            },
          );
          return {
            messageId: typeof result.message_id === "string" ? result.message_id : messageId,
            accepted: result.accepted === true,
            status: result.status,
            fromAppend: result.from_append_msg === true,
            ...(permissions ? { permissionModeId } : {}),
          };
        } finally {
          this.starting.delete(sessionId);
        }
      }
      case "cancel": {
        await this.readSession(text(input.sessionId, "session ID"));
        return this.native.call("lite", "stop_chat_session", {
          chat_session_id: text(input.sessionId, "session ID"),
        });
      }
      case "respond": {
        const sessionId = text(input.sessionId, "session ID");
        const interactionId = text(input.interactionId, "interaction ID");
        const key = `${sessionId}:${interactionId}`;
        if (this.responseAttempts.has(key))
          throw Object.assign(
            new Error(
              "Native interaction already has a response attempt; verify its state before retrying",
            ),
            { code: "invalidState" },
          );
        const { session, projectId } = await this.readSession(sessionId);
        if (![3, 8].includes(session.status)) {
          this.interactions.expire(sessionId);
          throw Object.assign(new Error("Native interaction is no longer active"), {
            code: "invalidState",
          });
        }
        const decide = input.kind === "approval" ? approvalDecision : questionDecision;
        const nativePermissions = input.kind === "approval" && !!(await this.permissionSettings());
        const data = decide(
          this.interactions.current(sessionId, input.messageId, input.planItemId),
          input,
          nativePermissions,
        );
        // Recheck after asynchronous history revalidation, before the only write.
        if (this.responseAttempts.has(key))
          throw Object.assign(new Error("Native interaction response is already in progress"), {
            code: "invalidState",
          });
        this.responseAttempts.add(key);
        try {
          await this.native.call("lite", "send_user_decision", data, {
            chat_session_id: sessionId,
            project_id: projectId,
          });
          return { accepted: true };
        } catch (error) {
          // An explicit native rejection proves non-admission. A lost receipt
          // does not, so it must not reopen the same instance for another write.
          if (typeof error.nativeCode === "number") this.responseAttempts.delete(key);
          throw error;
        }
      }
      default:
        throw Object.assign(new Error(`Unsupported bridge method: ${method}`), {
          code: "unsupported",
        });
    }
  }

  async subscribe(input, listener) {
    const sessionId = text(input?.sessionId, "session ID");
    await this.readSession(sessionId);
    const observe = (event) => this.interactions.observe(sessionId, event);
    const expire = () => this.interactions.expire(sessionId);
    return this.native.subscribe(
      "lite",
      "subscribe_events",
      {
        chat_session_id: sessionId,
        ...(typeof input.lastEventId === "string" ? { last_event_id: input.lastEventId } : {}),
      },
      {},
      {
        data: (event) => {
          observe(event);
          listener.data(publicEvent(event));
        },
        error: (error) => {
          expire();
          listener.error(error);
        },
        end: () => {
          expire();
          listener.end();
        },
        // Keep confirmation state current after the HTTP observer detaches.
        drain: { data: observe, error: expire, end: expire },
      },
    );
  }
}

module.exports = { DesktopService, publicEvent, publicHistoryItem, publicError, publicTokenUsage };
