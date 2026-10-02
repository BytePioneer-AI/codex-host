import {
  encodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessPluginIdSchema,
} from "@codexhost/shared-contracts";
import type { RendererSettingsPageDefinition } from "../../settings/core.js";
import { consoleGet } from "../api.js";
import { h } from "../dom.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function externalHarnessModel(harnessId: string, modelId?: string): string {
  return encodeHarnessPluginRoute({
    harnessId: harnessPluginIdSchema.parse(harnessId),
    ...(modelId ? { model: harnessModelRefSchema.parse({ id: modelId }) } : {}),
  });
}


class RpcClient {
  #nextId = 1;
  #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();

  constructor(
    readonly socket: WebSocket,
    readonly onNotification: (method: string, params: unknown) => void,
    readonly onServerRequest: (
      id: string | number,
      method: string,
      params: unknown,
    ) => void,
  ) {
    socket.addEventListener("message", (event) => this.#message(String(event.data)));
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.#nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown = {}): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  respond(id: string | number, result: unknown): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: string | number, message: string): void {
    this.socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32001, message },
    }));
  }

  #message(text: string): void {
    const message = object(JSON.parse(text));
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if ("error" in message) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      this.onServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.method === "string") {
      this.onNotification(message.method, message.params);
    }
  }
}

function renderMessage(
  document: Document,
  list: HTMLElement,
  role: string,
  text: string,
): void {
  const card = h(document, "div", { className: `console-chat-message is-${role}` });
  card.append(
    h(document, "div", { className: "console-chat-message__role" }, role),
    h(document, "div", { className: "console-chat-message__text" }, text),
  );
  list.append(card);
  list.scrollTop = list.scrollHeight;
}

interface RpcHandlers {
  notification(method: string, params: unknown): void;
  serverRequest(id: string | number, method: string, params: unknown): void;
}

async function connectRpc(): Promise<{
  rpc: RpcClient;
  handlers: RpcHandlers;
  defaultCwd: string;
}> {
  const info = await consoleGet<{ wsPath: string; defaultCwd: string }>(
    "/api/external-ui/info",
  );
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${window.location.host}${info.wsPath}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")), {
      once: true,
    });
  });

  const handlers: RpcHandlers = {
    notification: () => undefined,
    serverRequest: () => undefined,
  };
  const rpc = new RpcClient(
    socket,
    (method, params) => handlers.notification(method, params),
    (id, method, params) => handlers.serverRequest(id, method, params),
  );
  await rpc.request("initialize", {
    clientInfo: {
      name: "codexhost_console",
      title: "CodexHost Console Chat",
      version: "1",
    },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized", {});

  return { rpc, handlers, defaultCwd: info.defaultCwd };
}

export function createChatPage(): RendererSettingsPageDefinition {
  return {
    id: "chat",
    label: "Chat",
    icon: "terminal",
    mount({ content, signal }) {
      const document = content.ownerDocument;
      const status = h(document, "span", { className: "console-badge" }, "Connecting");
      const agent = h(document, "select", { className: "console-input" });
      const model = h(document, "select", { className: "console-input" });
      model.disabled = true;
      const cwd = h(document, "input", {
        className: "console-input",
        type: "text",
        placeholder: "/path/to/workspace",
      });
      const messages = h(document, "div", { className: "console-chat-messages" });
      const input = h(document, "textarea", {
        className: "console-chat-input",
        placeholder: "Ask CodexHost...",
        rows: "5",
      });

      const send = h(document, "button", {
        type: "button",
        className: "settings-command-button",
      }, "Send");
      send.disabled = true;
      const stop = h(document, "button", {
        type: "button",
        className: "settings-command-button settings-command-button--secondary",
        disabled: true,
      }, "Stop");

      content.append(
        h(
          document,
          "div",
          { className: "console-chat-page" },
          h(
            document,
            "div",
            { className: "console-panel console-chat-toolbar" },
            h(document, "div", { className: "console-panel__header" },
              h(document, "h2", { className: "console-panel__title" }, "Multi-Agent Chat"),
              status,
            ),
            h(document, "label", { className: "console-chat-field" },
              h(document, "span", {}, "Agent"),
              agent,
            ),
            h(document, "label", { className: "console-chat-field" },
              h(document, "span", {}, "Model"),
              model,
            ),
            h(document, "label", { className: "console-chat-field" },
              h(document, "span", {}, "Working directory"),
              cwd,
            ),
          ),
          messages,
          h(document, "div", { className: "console-panel console-chat-composer" },
            input,
            h(document, "div", { className: "console-actions" }, send, stop),
          ),
        ),
      );

      let rpc: RpcClient | null = null;
      let handlers: RpcHandlers | null = null;
      let threadId: string | null = null;
      let turnId: string | null = null;
      let streaming = "";
      let reasoning = "";
      const toolOutputs = new Map<string, string>();
      const itemTypes = new Map<string, string>();
      let codexModels: JsonObject[] = [];
      let modelLoadGeneration = 0;

      const setRunning = (running: boolean): void => {
        send.disabled = running;
        stop.disabled = !running;
        agent.disabled = running;
        model.disabled = running || model.options.length <= 1;
        cwd.disabled = running;
      };

      const resetThread = (): void => {
        threadId = null;
        turnId = null;
        streaming = "";
        reasoning = "";
        toolOutputs.clear();
        itemTypes.clear();
        messages.replaceChildren();
      };

      const loadModelsForAgent = async (): Promise<void> => {
        const generation = ++modelLoadGeneration;
        resetThread();
        model.replaceChildren();
        model.disabled = true;
        send.disabled = true;
        if (!rpc || !agent.value) return;

        const appendOption = (value: string, label: string, selected = false): void => {
          const option = h(document, "option", { value }, label);
          option.selected = selected;
          model.append(option);
        };

        try {
          if (agent.value === "codex") {
            const visibleModels = codexModels.filter((entry) => entry.hidden !== true);
            for (const entry of visibleModels) {
              if (typeof entry.model !== "string") continue;
              appendOption(
                entry.model,
                typeof entry.displayName === "string" ? entry.displayName : entry.model,
                entry.isDefault === true,
              );
            }
          } else {
            const inspection = object(
              await rpc.request("codexhost/harness/inspect", {
                harnessId: agent.value,
                ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
              }),
            );
            if (generation !== modelLoadGeneration) return;
            if (inspection.status === "ready") {
              const catalog = object(inspection.catalog);
              const defaultRef = object(catalog.defaultModel);
              const defaultId = typeof defaultRef.id === "string" ? defaultRef.id : null;
              const entries = Array.isArray(catalog.models) ? catalog.models.map(object) : [];
              for (const entry of entries) {
                const ref = object(entry.ref);
                if (typeof ref.id !== "string") continue;
                const label =
                  typeof entry.resolvedModelLabel === "string"
                    ? entry.resolvedModelLabel
                    : typeof entry.label === "string"
                      ? entry.label
                      : ref.id;
                appendOption(ref.id, label, ref.id === defaultId);
                const fast = object(entry.fastModel);
                if (typeof fast.id === "string") {
                  appendOption(fast.id, `${label} · Fast`, fast.id === defaultId);
                }
              }
            }
          }

          if (generation !== modelLoadGeneration) return;
          if (model.options.length === 0) appendOption("", "Default");
          model.disabled = model.options.length <= 1;
          send.disabled = false;
        } catch (error) {
          if (generation !== modelLoadGeneration) return;
          appendOption("", "Default");
          model.disabled = true;
          send.disabled = false;
          console.warn("CodexHost model catalog unavailable", error);
        }
      };

      agent.addEventListener("change", () => void loadModelsForAgent());
      model.addEventListener("change", resetThread);
      cwd.addEventListener("change", () => void loadModelsForAgent());

      const handleNotification = (method: string, rawParams: unknown): void => {
        const params = object(rawParams);
        if (threadId && params.threadId && params.threadId !== threadId) return;

        if (method === "turn/started") {
          const turn = object(params.turn);
          if (typeof turn.id === "string") turnId = turn.id;
          setRunning(true);
          return;
        }
        if (method === "item/started") {
          const item = object(params.item);
          if (typeof item.id === "string" && typeof item.type === "string") {
            itemTypes.set(item.id, item.type);
            if (item.type === "commandExecution" && item.command === "thinking") {
              itemTypes.set(item.id, "reasoningTranscript");
            }
          }
          return;
        }

        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          streaming += params.delta;
          const live = messages.querySelector(".console-chat-live");
          if (live) live.textContent = streaming;
          else {
            const card = h(document, "div", {
              className: "console-chat-message is-assistant",
            });
            card.append(
              h(document, "div", { className: "console-chat-message__role" }, "assistant"),
              h(document, "div", {
                className: "console-chat-message__text console-chat-live",
              }, streaming),
            );
            messages.append(card);
          }
          messages.scrollTop = messages.scrollHeight;
          return;
        }
        if (method === "item/reasoning/summaryTextDelta" && typeof params.delta === "string") {
          reasoning += params.delta;
          return;
        }

        if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId : "tool";
          if (itemTypes.get(itemId) !== "reasoningTranscript") {
            toolOutputs.set(itemId, (toolOutputs.get(itemId) ?? "") + params.delta);
          }
          return;
        }
        if (method === "turn/completed") {
          messages.querySelector(".console-chat-live")?.classList.remove("console-chat-live");
          if (reasoning.trim()) renderMessage(document, messages, "reasoning", reasoning);
          for (const output of toolOutputs.values()) {
            if (output.trim()) renderMessage(document, messages, "tool", output);
          }
          streaming = "";
          reasoning = "";
          toolOutputs.clear();
          itemTypes.clear();
          turnId = null;
          setRunning(false);
          return;
        }
        if (method === "error") {
          const error = object(params.error);
          renderMessage(
            document,
            messages,
            "system",
            typeof error.message === "string" ? error.message : "Agent error",
          );
        }
      };

      const handleServerRequest = (
        id: string | number,
        method: string,
        rawParams: unknown,
      ): void => {
        if (!rpc) return;
        const params = object(rawParams);
        if (method === "mcpServer/elicitation/request") {
          const message = typeof params.message === "string" ? params.message : "Allow this action?";
          const accepted = window.confirm(message);
          rpc.respond(id, accepted
            ? { action: "accept", content: {} }
            : { action: "decline", content: null });
          return;
        }
        if (method === "item/tool/requestUserInput") {
          const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
          const answers: Record<string, { answers: string[] }> = {};
          for (const question of questions) {
            if (typeof question.id !== "string") continue;
            const prompt = typeof question.question === "string" ? question.question : question.id;
            const options = Array.isArray(question.options) ? question.options.map(object) : [];
            const labels = options
              .map((option) => option.label)
              .filter((value): value is string => typeof value === "string");
            const value = window.prompt(
              labels.length > 0 ? `${prompt}\nOptions: ${labels.join(", ")}` : prompt,
              labels[0] ?? "",
            );
            answers[question.id] = { answers: value ? [value] : [] };
          }
          rpc.respond(id, { answers });
          return;
        }
        rpc.respondError(id, `Unsupported UI interaction: ${method}`);
      };

      const sendTurn = async (): Promise<void> => {
        if (!rpc || turnId) return;
        const text = input.value.trim();
        if (!text) return;
        const agentId = agent.value;
        const selectedModel = model.value;
        const workingDirectory = cwd.value.trim();
        if (!agentId || !workingDirectory) return;
        const threadModel =
          agentId === "codex"
            ? selectedModel
            : externalHarnessModel(agentId, selectedModel || undefined);
        if (!threadModel) return;

        input.value = "";
        renderMessage(document, messages, "user", text);
        setRunning(true);
        try {
          if (!threadId) {
            const started = object(await rpc.request("thread/start", {
              model: threadModel,
              cwd: workingDirectory,
              approvalPolicy: "on-request",
              sandbox: "workspace-write",
            }));
            const thread = object(started.thread);
            if (typeof thread.id !== "string") {
              throw new Error("thread/start returned no Thread ID");
            }
            threadId = thread.id;
          }
          const result = object(await rpc.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
            approvalPolicy: "on-request",
            sandboxPolicy: { type: "workspaceWrite" },
          }));
          const turn = object(result.turn);
          if (typeof turn.id === "string") turnId = turn.id;
        } catch (error) {
          renderMessage(
            document,
            messages,
            "system",
            error instanceof Error ? error.message : String(error),
          );
          setRunning(false);
        }
      };

      send.addEventListener("click", () => void sendTurn());
      stop.addEventListener("click", () => {
        if (!rpc || !threadId || !turnId) return;
        void rpc.request("turn/interrupt", { threadId, turnId });
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void sendTurn();
        }
      });

      void connectRpc().then(
        async (connected) => {
          if (signal.aborted) {
            connected.rpc.socket.close();
            return;
          }
          rpc = connected.rpc;
          handlers = connected.handlers;
          handlers.notification = handleNotification;
          handlers.serverRequest = handleServerRequest;
          cwd.value = connected.defaultCwd;

          const [pluginResult, modelResult] = await Promise.all([
            rpc.request("codexhost/harness/plugins/list", {}),
            rpc.request("model/list", {}),
          ]);

          codexModels = Array.isArray(object(modelResult).data)
            ? (object(modelResult).data as unknown[]).map(object)
            : [];
          if (codexModels.some((entry) => typeof entry.model === "string" && entry.hidden !== true)) {
            agent.append(h(document, "option", { value: "codex" }, "Codex"));
          }

          const plugins = Array.isArray(object(pluginResult).plugins)
            ? (object(pluginResult).plugins as unknown[]).map(object)
            : [];
          for (const plugin of plugins) {
            if (typeof plugin.id !== "string") continue;
            agent.append(
              h(
                document,
                "option",
                { value: plugin.id },
                typeof plugin.name === "string" ? plugin.name : plugin.id,
              ),
            );
          }
          await loadModelsForAgent();
          status.textContent = `Connected · ${agent.options.length} agents`;
          status.classList.add("is-ok");
          send.disabled = agent.options.length === 0;
        },

        (error) => {
          status.textContent = error instanceof Error ? error.message : "Unavailable";
          status.classList.add("is-bad");
          send.disabled = true;
        },
      );

      signal.addEventListener("abort", () => rpc?.socket.close(), { once: true });
      return () => rpc?.socket.close();
    },
  };
}
