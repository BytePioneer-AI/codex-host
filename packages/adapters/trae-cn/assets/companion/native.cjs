const { randomUUID } = require("node:crypto");

const READ_CALLBACKS = new Set([
  "icube.common.getDynamicConfig",
  "icube.common.getReportCommonParams",
  "icube.common.commands.tooling.getRulesDetails",
  "icube.common.commands.tooling.getAllAgentExtensions",
]);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode the desktop packet and the additional lite-service response envelope. */
function unwrap(packet) {
  let value = record(packet) && "packet_type" in packet ? packet.params : packet;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw failure("protocolError", "TRAE CN returned a non-JSON response");
    }
  }
  for (let i = 0; i < 3 && record(value) && typeof value.code === "number"; i++) {
    if (value.code !== 0) {
      throw failure(
        "nativeFailure",
        typeof value.message === "string" ? value.message : "TRAE CN request failed",
      );
    }
    value = value.data;
  }
  return value;
}

/** The channel and desktop credentials remain inside the TRAE CN extension host. */
class NativeConnection {
  #channel;
  #vscode;
  #identity;
  #pending = new Map();
  #streams = new Map();
  #closed = false;
  #timeoutMs;
  #onMessage;
  #onDisconnect;
  #onError;

  constructor(channel, vscode, identity, timeoutMs = 30000) {
    this.#channel = channel;
    this.#vscode = vscode;
    this.#identity = identity;
    this.#timeoutMs = timeoutMs;
    this.#onMessage = (raw) => {
      try {
        const messages = JSON.parse(raw);
        for (const message of Array.isArray(messages) ? messages : [messages])
          this.#receive(message);
      } catch {
        this.close(failure("protocolError", "Invalid TRAE CN RPC message"));
      }
    };
    channel.on("message", this.#onMessage);
    this.#onDisconnect = () => this.close(failure("processExited", "TRAE CN disconnected"));
    this.#onError = () => this.close(failure("unavailable", "TRAE CN IPC failed"));
    channel.on("disconnect", this.#onDisconnect);
    channel.on("error", this.#onError);
  }

  async #packet(service, method, data, context) {
    if (this.#closed) throw failure("invalidState", "TRAE CN connection is closed");
    const user = await this.#vscode.commands.executeCommand("icube.common.getUserInfo");
    if (!user?.token) throw failure("authenticationRequired", "Sign in to TRAE CN Desktop");
    const folders =
      this.#vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    return {
      packet_type: "request",
      session_id: this.#identity,
      channel_id: randomUUID(),
      params: {
        service,
        method,
        data,
        common_params: {},
        streamlined_common_params: {},
        user_info: {
          name: user.account?.username ?? "",
          token: user.token,
          is_internal: user.account?.scope === "bytedance",
          user_id: user.userId ?? "",
          scope: user.account?.scope ?? "",
          loginScope: user.account?.loginScope,
          tenant_id: user.account?.tenant_id,
        },
        client_info: {
          connect_session_id: this.#identity,
          workspace_folder: folders[0],
          workspace_folders: folders,
          device_id: this.#vscode.env.machineId,
          icube_language: this.#vscode.env.language,
          client_type: "ide",
          window_type: "ide",
          permission_profile_id: "manual_approval",
          user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...context,
        },
      },
    };
  }

  async call(service, method, data = {}, context = {}) {
    const packet = await this.#packet(service, method, data, context);
    return unwrap(await this.#request("request", packet));
  }

  async subscribe(service, method, data, context, listener) {
    const packet = await this.#packet(service, method, data, context);
    let streamId;
    await this.#request("request_stream", packet, (response) => {
      if (typeof response?.streamId !== "string" || !response.streamId) {
        throw failure("protocolError", "Missing TRAE CN stream identity");
      }
      streamId = response.streamId;
      this.#streams.set(streamId, listener);
    });
    return () => this.#cancelStream(streamId);
  }

  #request(method, packet, prepare) {
    if (this.#closed)
      return Promise.reject(failure("invalidState", "TRAE CN connection is closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failure("unavailable", "TRAE CN RPC timed out; check native state before retrying"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, prepare });
      try {
        this.#channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: [packet] }));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(failure("processExited", "TRAE CN IPC send failed"));
      }
    });
  }

  #receive(message) {
    if (this.#closed || !record(message)) return;
    if (typeof message.method === "string") {
      if (message.method === "execute_command" && message.id !== undefined) {
        void this.#callback(message).catch(() =>
          this.close(failure("processExited", "TRAE CN callback transport failed")),
        );
        return;
      }
      if (!message.method.startsWith("rpc.stream.")) return;
      const streamId = message.method.slice("rpc.stream.".length);
      const listener = this.#streams.get(streamId);
      if (!listener) return;
      if (message.meta?.streamId !== streamId) throw new Error("Mismatched stream");
      if (message.params?.error) {
        this.#streams.delete(streamId);
        listener.error(failure("nativeFailure", "TRAE CN stream failed"));
      } else if (message.meta.done) {
        this.#streams.delete(streamId);
        listener.end();
      } else if (message.params?.data !== undefined) {
        try {
          listener.data(unwrap(message.params.data));
        } catch (error) {
          this.#cancelStream(streamId);
          listener.error(error);
        }
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    try {
      if (message.error) throw failure("nativeFailure", "TRAE CN rejected the RPC request");
      // Register before resolving: native events can immediately follow the stream response.
      pending.prepare?.(message.result);
      pending.resolve(message.result);
    } catch (error) {
      pending.reject(error);
    }
  }

  async #callback(message) {
    const packet = message.params?.[0];
    const command = packet?.params;
    let payload;
    let error;
    try {
      if (!READ_CALLBACKS.has(command?.command_id))
        throw new Error("Desktop callback is not supported by this bridge");
      const args = (command.args ?? []).map((arg) => JSON.parse(arg));
      payload = JSON.stringify(
        await this.#vscode.commands.executeCommand(command.command_id, ...args),
      );
    } catch {
      error = "Desktop callback is not supported by this bridge";
    }
    if (this.#closed) return;
    this.#channel.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          results: {
            stream_id: packet?.channel_id,
            msg_type: "execute_command_result",
            payload,
            error,
          },
          base_resp: { status_message: "ok", status_code: 0, extra: null },
        },
      }),
    );
  }

  #cancelStream(streamId) {
    if (!this.#streams.delete(streamId) || this.#closed) return;
    this.#channel.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: `rpc.stream.cancel.${streamId}`,
        params: [{ streamId, reason: "CodexHost observer closed" }],
      }),
    );
  }

  close(error = failure("invalidState", "TRAE CN connection closed")) {
    if (this.#closed) return;
    const listeners = [...this.#streams.values()];
    for (const streamId of this.#streams.keys()) {
      try {
        this.#cancelStream(streamId);
      } catch {
        /* The channel may already be disconnected. */
      }
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#channel.off("message", this.#onMessage);
    this.#channel.off("disconnect", this.#onDisconnect);
    this.#channel.off("error", this.#onError);
    for (const listener of listeners) {
      try {
        listener.error(error);
      } catch {
        /* One observer must not prevent other cleanup. */
      }
    }
    this.#channel.disconnect();
  }
}

module.exports = { NativeConnection, unwrap };
