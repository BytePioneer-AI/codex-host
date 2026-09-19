import { HERMES_GATEWAY_COMMANDS } from "./hermes-commands.js";
import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type {
  HostQuestion,
  HostQuestionResponse,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  harnessThinkingOptionIdSchema,
  type HarnessThinkingOption,
} from "@codexhost/shared-contracts";
import {
  HermesTransportError,
  type HermesOpenResult,
  type HermesPermissionRequest,
  type HermesPromptResponse,
  type HermesQuestionRequest,
  type HermesSessionTransport,
  type HermesTransportEvent,
} from "./acp-transport.js";
import {
  type HermesGatewayTransport,
  gatewayRecord,
  gatewayString,
  type GatewayRecord,
} from "./gateway-transport.js";
import { HermesGatewayHistory } from "./gateway-history.js";

export const hermesGatewayThinkingOptions: HarnessThinkingOption[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
].map((id) => ({ id: harnessThinkingOptionIdSchema.parse(id), label: id }));

type Active = {
  emit(event: HermesTransportEvent): void;
  permission(request: HermesPermissionRequest): Promise<RequestPermissionResponse>;
  question?: (request: HermesQuestionRequest) => Promise<HostQuestionResponse>;
  resolve(value: HermesPromptResponse): void;
  reject(error: Error): void;
  streamed: string;
  reasoning: string;
  toolIds: Set<string>;
};

function question(entry: GatewayRecord, fallbackId: string): HostQuestion {
  const id = gatewayString(entry.qid) || fallbackId;
  const prompt = gatewayString(entry.question);
  if (!prompt) throw new Error("Hermes clarify request has no question");
  const choices = Array.isArray(entry.choices)
    ? entry.choices.filter((choice): choice is string => typeof choice === "string")
    : [];
  return choices.length
    ? {
        id,
        type: "choice",
        prompt,
        options: choices.map((value) => ({ value, label: value })),
        multiple: entry.multi_select === true,
        allowOther: true,
        optional: false,
      }
    : { id, type: "text", prompt, multiline: true, secret: false, optional: false };
}

function gatewayDiff(text: string): ToolCallContent[] {
  if (!text || text.length > 1024 * 1024) return [];
  const result: ToolCallContent[] = [];
  let path = "";
  let inHunk = false;
  let oldLines: string[] = [],
    newLines: string[] = [];
  const flush = () => {
    if (path)
      result.push({
        type: "diff",
        path,
        oldText: oldLines.join("\n"),
        newText: newLines.join("\n"),
      });
    oldLines = [];
    newLines = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\u001b\[[0-9;]*m/gu, "");
    const header = /^(a\/.+|\/dev\/null) → (b\/.+|\/dev\/null)$/u.exec(line);
    if (header) {
      flush();
      inHunk = false;
      path = (header[2] === "/dev/null" ? (header[1] ?? "") : (header[2] ?? "")).replace(
        /^[ab]\//u,
        "",
      );
      continue;
    }
    if (line.startsWith("--- ") && !inHunk) {
      flush();
      path = line.slice(4).replace(/^a\//u, "");
    } else if (line.startsWith("+++ ") && !inHunk) {
      const next = line.slice(4);
      if (next !== "/dev/null") path = next.replace(/^b\//u, "");
    } else if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    } else if (path && line.startsWith("-")) oldLines.push(line.slice(1));
    else if (path && line.startsWith("+")) newLines.push(line.slice(1));
    else if (path && line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  flush();
  return result;
}

export class HermesGatewaySessionTransport implements HermesSessionTransport {
  onFault: (error: HermesTransportError) => void = () => undefined;
  readonly availableCommands = HERMES_GATEWAY_COMMANDS;
  readonly history: HermesGatewayHistory;
  #active: Active | null = null;
  #requests = new Map<string, AbortController>();
  #closed = false;
  #info: GatewayRecord;
  constructor(
    readonly transport: HermesGatewayTransport,
    readonly sessionId: string,
    readonly nativeSessionId: string,
    info: GatewayRecord,
  ) {
    this.#info = info;
    this.history = new HermesGatewayHistory({
      python: transport.python,
      cwd: transport.cwd,
      environment: transport.environment,
      nativeSessionId,
    });
    transport.onEvent = (event) => this.#event(event);
    transport.onRequest = (id, method, params) => {
      void this.#request(id, method, params).catch((error) => this.#fault(error));
    };
    transport.onFault = (error) => this.#fault(error);
  }
  async openResult(): Promise<HermesOpenResult> {
    const reasoning = await this.transport.request("config.get", {
      key: "reasoning",
      session_id: this.sessionId,
    });
    const currentThinkingOptionId = gatewayString(reasoning.value);
    const model = gatewayString(this.#info.model);
    const provider = gatewayString(this.#info.provider);
    const currentModelId = provider ? `${provider}:${model}` : model;
    return {
      initialize: { protocolVersion: 1 },
      sessionId: this.nativeSessionId,
      replay: [],
      session: {
        sessionId: this.nativeSessionId,
        models: currentModelId
          ? {
              currentModelId,
              availableModels: [
                { modelId: currentModelId, name: provider ? `${provider} / ${model}` : model },
              ],
            }
          : null,
        modes: {
          currentModeId: this.#info.yolo === true ? "dont_ask" : "default",
          availableModes: [
            { id: "default", name: "Native approval policy" },
            { id: "dont_ask", name: "Session YOLO" },
          ],
        },
        thinkingOptions: hermesGatewayThinkingOptions,
        ...(hermesGatewayThinkingOptions.some(({ id }) => id === currentThinkingOptionId)
          ? { currentThinkingOptionId }
          : {}),
      },
    };
  }
  async readNativeSnapshot(): Promise<HostThreadSnapshot> {
    return this.history.readSnapshot();
  }
  async setThinking(optionId: string): Promise<string> {
    if (!hermesGatewayThinkingOptions.some(({ id }) => id === optionId))
      throw new Error("Unsupported Hermes reasoning effort");
    const result = await this.transport.request("config.set", {
      key: "reasoning",
      value: optionId,
      scope: "session",
      session_id: this.sessionId,
    });
    if (
      result.value !== optionId ||
      (await this.transport.request("config.get", { key: "reasoning", session_id: this.sessionId }))
        .value !== optionId
    )
      throw new Error("Hermes did not confirm reasoning selection");
    return optionId;
  }
  async setModel(modelId: string): Promise<void> {
    if (/\s/u.test(modelId) || modelId.startsWith("-"))
      throw new Error("Invalid Hermes Model identifier");
    const result = await this.transport.request("config.set", {
      key: "model",
      value: modelId,
      scope: "session",
      session_id: this.sessionId,
    });
    if (result.confirm_required === true)
      throw new Error(
        gatewayString(result.confirm_message) || "Hermes requires confirmation for this Model",
      );
    const actualModel = gatewayString(this.#info.model);
    const actualProvider = gatewayString(this.#info.provider);
    if (modelId !== actualModel && modelId !== `${actualProvider}:${actualModel}`)
      throw new Error("Hermes did not confirm the requested Model");
  }
  async setPermissionMode(modeId: string): Promise<void> {
    if (modeId !== "default" && modeId !== "dont_ask")
      throw new Error("Hermes gateway has no accept_edits mode");
    const result = await this.transport.request("config.set", {
      key: "yolo",
      value: modeId === "dont_ask" ? "on" : "off",
      scope: "session",
      session_id: this.sessionId,
    });
    if (
      result.value !== (modeId === "dont_ask" ? "1" : "0") ||
      this.#info.yolo !== (modeId === "dont_ask")
    )
      throw new Error(
        "Hermes effective approval policy differs from the requested mode; check native global approvals policy",
      );
  }
  nativeCommandName(text: string): string | null {
    const commandText = text.trim();
    if (/^\/compress(?:\s|$)/iu.test(commandText)) return "compress";
    return /^\/(help|tools|context|version)$/iu.exec(commandText)?.[1]?.toLowerCase() ?? null;
  }
  async runTurn(
    text: string,
    emit: Active["emit"],
    permission: Active["permission"],
    question?: Active["question"],
  ): Promise<HermesPromptResponse> {
    if (this.#active || this.#closed) throw new Error("Hermes gateway Session is unavailable");
    let resolveResult: (value: HermesPromptResponse) => void = () => undefined;
    let rejectResult: (error: Error) => void = () => undefined;
    const result = new Promise<HermesPromptResponse>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => undefined);
    const active: Active = {
      emit,
      permission,
      ...(question ? { question } : {}),
      resolve: resolveResult,
      reject: rejectResult,
      streamed: "",
      reasoning: "",
      toolIds: new Set(),
    };
    this.#active = active;
    const commandText = text.trim();
    const nativeCommand = this.nativeCommandName(text);
    try {
      if (nativeCommand === "compress") {
        const compact = await this.transport.request(
          "session.compress",
          { session_id: this.sessionId, focus_topic: commandText.slice(9).trim() },
          300_000,
        );
        const summary = gatewayRecord(compact.summary);
        const explanation = [summary.headline, summary.token_line, summary.note, compact.message]
          .filter((value): value is string => typeof value === "string" && !!value)
          .join("\n");
        if (explanation) emit({ type: "agent.text", text: explanation });
        if (compact.status === "pending") {
          this.#fault(
            new Error(
              "Hermes compression remains pending; Session closed to prevent overlapping native work",
            ),
          );
          return await result;
        }
        if (
          !["compressed", "aborted"].includes(String(compact.status)) &&
          compact.lock_held !== true
        )
          throw new Error("Hermes returned an unrecognized compression outcome");
        this.#usage(gatewayRecord(compact.usage));
        const succeeded = compact.status === "compressed" && summary.noop !== true;
        active.resolve({
          stopReason: "end_turn",
          compactionOutcome:
            compact.status === "aborted" || summary.aborted === true
              ? {
                  status: "failed",
                  error: {
                    code: "nativeFailure",
                    message: explanation || "Hermes summary generation failed",
                    retryable: true,
                  },
                }
              : succeeded
                ? { status: "succeeded" }
                : { status: "cancelled", reason: explanation || "Hermes did not compact context" },
        });
      } else if (nativeCommand) {
        const response = await this.transport.request("slash.exec", {
          session_id: this.sessionId,
          command: `/${nativeCommand}`,
        });
        emit({ type: "agent.text", text: gatewayString(response.output) });
        active.resolve({ stopReason: "end_turn" });
      } else {
        const submitted = await this.transport.request("prompt.submit", {
          session_id: this.sessionId,
          text,
        });
        if (submitted.status !== "streaming")
          this.#fault(
            new Error(`Hermes did not start an exclusive turn (${String(submitted.status)})`),
          );
      }
    } catch (error) {
      active.reject(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      return await result;
    } finally {
      if (this.#active === active) this.#active = null;
      for (const controller of this.#requests.values()) controller.abort("cancelled");
      this.#requests.clear();
    }
  }
  async cancel(): Promise<void> {
    await this.transport.request("session.interrupt", { session_id: this.sessionId });
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#requests.values()) controller.abort("cancelled");
    this.#requests.clear();
    this.#active?.reject(new Error("Hermes gateway Session closed"));
    try {
      await this.transport.request("session.close", { session_id: this.sessionId });
    } catch {
      /* Process close still releases ownership. */
    }
    await this.transport.close();
  }
  #fault(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#requests.values()) controller.abort("cancelled");
    this.#requests.clear();
    const fault = new HermesTransportError(
      "protocolError",
      error instanceof Error ? error.message : String(error),
    );
    this.#active?.reject(fault);
    this.onFault(fault);
    void this.transport.close();
  }
  #event(event: GatewayRecord): void {
    if (event.session_id !== this.sessionId || this.#closed) return;
    const payload = gatewayRecord(event.payload);
    if (event.type === "session.info") {
      this.#info = payload;
      return;
    }
    if (event.type === "request.cancel") {
      const controller = this.#requests.get(gatewayString(payload.id));
      controller?.abort(payload.reason === "timeout" ? "expired" : "cancelled");
      return;
    }
    const active = this.#active;
    if (!active) {
      if (event.type === "error") this.#fault(new Error(gatewayString(payload.message)));
      return;
    }
    const text = gatewayString(payload.text);
    if (event.type === "message.delta") {
      active.streamed += text;
      active.emit({ type: "agent.text", text });
    } else if (event.type === "reasoning.delta" || event.type === "reasoning.available") {
      if (event.type === "reasoning.delta" || !active.reasoning) {
        active.reasoning += text;
        active.emit({ type: "agent.thought", text });
      }
    } else if (event.type === "message.interim") {
      if (payload.already_streamed !== true) active.emit({ type: "agent.text", text });
      active.streamed = "";
      active.reasoning = "";
    } else if (event.type === "session.usage") this.#usage(gatewayRecord(payload.usage));
    else if (event.type === "tool.start" || event.type === "tool.complete") {
      const toolCallId = gatewayString(payload.tool_id);
      if (!toolCallId) return;
      const result = gatewayRecord(payload.result);
      const output =
        payload.result !== undefined
          ? typeof payload.result === "string"
            ? payload.result
            : JSON.stringify(payload.result)
          : gatewayString(payload.result_text) || gatewayString(payload.summary);
      const content: ToolCallContent[] = [
        ...(output
          ? [{ type: "content" as const, content: { type: "text" as const, text: output } }]
          : []),
        ...gatewayDiff(gatewayString(payload.inline_diff)),
      ];
      if (event.type === "tool.complete" && !active.toolIds.has(toolCallId))
        active.emit({
          type: "tool.call",
          toolCallId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: gatewayString(payload.name),
            rawInput: payload.args,
            status: "in_progress",
          },
        });
      active.toolIds.add(toolCallId);
      active.emit(
        event.type === "tool.start"
          ? {
              type: "tool.call",
              toolCallId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: gatewayString(payload.name),
                rawInput: payload.args,
                status: "in_progress",
              },
            }
          : {
              type: "tool.update",
              toolCallId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status:
                  result.error || result.is_error === true || result.success === false
                    ? "failed"
                    : "completed",
                content,
              },
            },
      );
    } else if (event.type === "message.complete") {
      if (!active.streamed) active.emit({ type: "agent.text", text });
      else if (text.startsWith(active.streamed) && text.length > active.streamed.length)
        active.emit({ type: "agent.text", text: text.slice(active.streamed.length) });
      const reasoning = gatewayString(payload.reasoning);
      if (reasoning && !active.reasoning) active.emit({ type: "agent.thought", text: reasoning });
      else if (reasoning.startsWith(active.reasoning) && reasoning.length > active.reasoning.length)
        active.emit({ type: "agent.thought", text: reasoning.slice(active.reasoning.length) });
      const usage = gatewayRecord(payload.usage);
      this.#usage(usage);
      if (payload.status === "error")
        active.reject(
          new Error(
            gatewayString(payload.error) ||
              gatewayString(payload.failure_reason) ||
              "Hermes turn failed",
          ),
        );
      else
        active.resolve({
          stopReason: payload.status === "interrupted" ? "cancelled" : "end_turn",
          usage: {
            inputTokens: Number(usage.input) || 0,
            outputTokens: Number(usage.output) || 0,
            totalTokens: Number(usage.total) || 0,
            ...(typeof usage.reasoning === "number" ? { thoughtTokens: usage.reasoning } : {}),
          },
        });
    } else if (event.type === "error")
      active.reject(new Error(gatewayString(payload.message) || "Hermes gateway failed"));
  }
  #usage(usage: GatewayRecord): void {
    this.#active?.emit({
      type: "usage",
      ...(typeof usage.context_used === "number" ? { used: usage.context_used } : {}),
      ...(typeof usage.context_max === "number" ? { size: usage.context_max } : {}),
    });
  }
  async #request(id: string, method: string, params: GatewayRecord): Promise<void> {
    const active = this.#active;
    if (
      !active ||
      params.session_id !== this.sessionId ||
      !["clarify", "approval"].includes(method)
    ) {
      this.transport.rejectRequest(id);
      return;
    }
    const controller = new AbortController();
    this.#requests.set(id, controller);
    try {
      if (method === "clarify" && active.question) {
        const batch = Array.isArray(params.questions);
        const questions = batch
          ? (params.questions as unknown[]).map((value, index) =>
              question(gatewayRecord(value), String(index)),
            )
          : [question(params, "answer")];
        const response = await active.question({
          title: "Hermes",
          questions,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const answers = Object.fromEntries(
            Object.entries(response.answers).map(([key, values]) => {
              const q = questions.find((entry) => entry.id === key);
              return [
                key,
                q?.type === "choice" && q.multiple ? JSON.stringify(values) : (values[0] ?? ""),
              ];
            }),
          );
          this.transport.respond(
            id,
            response.cancelled ? {} : batch ? { answers } : { answer: answers.answer ?? "" },
          );
        }
      } else if (method === "approval") {
        const choices = Array.isArray(params.choices) ? params.choices : ["once", "deny"];
        const options = choices.flatMap<PermissionOption>((choice) =>
          choice === "once"
            ? [{ optionId: "once", kind: "allow_once" as const, name: "Allow once" }]
            : choice === "session" || choice === "always"
              ? [
                  {
                    optionId: choice,
                    kind: "allow_always" as const,
                    name: choice === "session" ? "Allow for this session" : "Always allow",
                  },
                ]
              : choice === "deny"
                ? [{ optionId: "deny", kind: "reject_once" as const, name: "Deny" }]
                : [],
        );
        const response = await active.permission({
          signal: controller.signal,
          effects: { session: "allowForSession", always: "allowAlways" },
          description: gatewayString(params.command) || gatewayString(params.description),
          request: {
            sessionId: this.nativeSessionId,
            toolCall: {
              toolCallId: gatewayString(params.request_id),
              title: gatewayString(params.description) || gatewayString(params.command),
            },
            options,
          },
          options,
        });
        if (!controller.signal.aborted)
          this.transport.respond(id, {
            choice: response.outcome.outcome === "selected" ? response.outcome.optionId : "deny",
          });
      } else this.transport.rejectRequest(id);
    } finally {
      this.#requests.delete(id);
    }
  }
}
