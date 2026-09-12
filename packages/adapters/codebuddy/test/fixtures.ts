import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { CodeBuddyClient, CodeBuddyClientFactory } from "../src/acp-client.js";
import { CodeBuddyError } from "../src/common.js";

export function configOptions(model = "native/model", mode = "default", thought = "low") {
  return [
    {
      id: "model",
      currentValue: model,
      options: [
        { value: "native/model", name: "Native Model" },
        { value: "other", name: "Other Model" },
      ],
    },
    {
      id: "mode",
      currentValue: mode,
      options: ["default", "plan", "fullAccess"].map((value) => ({ value, name: value })),
    },
    {
      id: "thought_level",
      currentValue: thought,
      options: ["low", "high"].map((value) => ({ value, name: value })),
    },
  ];
}

export function fixture() {
  const clients: FakeClient[] = [];
  const history: Record<string, unknown>[] = [];
  let sequence = 0;
  class FakeClient implements CodeBuddyClient {
    options = configOptions();
    closed = false;
    failedConfig = false;
    missingHistory = false;
    cancelPoisoned = false;
    lastQuestion: unknown;
    nativeOutcome = "SUCCESS";
    nativeStopReason = "end_turn";
    recoverableToolFailure = false;
    pending:
      { resolve(value: Record<string, unknown>): void; id: string; input: string } | undefined;
    constructor(readonly context: Parameters<CodeBuddyClientFactory>[0]) {}
    async initialize() {
      return { protocolVersion: 1 };
    }
    async open(_cwd: string, sessionId?: string) {
      return { sessionId: sessionId ?? "native-session", configOptions: this.options };
    }
    async configure(_sessionId: string, id: string, value: string) {
      if (this.failedConfig) return { configOptions: this.options };
      this.options = this.options.map((option) => ({
        ...option,
        currentValue: option.id === id ? value : option.currentValue,
      }));
      return { configOptions: this.options };
    }
    update(update: unknown) {
      this.context.handlers.update({ sessionId: "native-session", update } as SessionNotification);
    }
    async prompt(_id: string, input: string) {
      if (this.cancelPoisoned) return { stopReason: "cancelled" };
      const id = `user-${++sequence}`;
      if (!this.missingHistory)
        history.push({
          type: "message",
          role: "user",
          id,
          parentId: history.at(-1)?.id,
          content: [{ type: "input_text", text: input }],
        });
      if (input === "hold")
        return new Promise<Record<string, unknown>>((resolve) => {
          this.pending = { resolve, id, input };
        });
      if (input === "approval" || input === "question")
        await this.context.handlers.permission({
          sessionId: "native-session",
          toolCall: {
            toolCallId: "call-1",
            rawInput:
              input === "question"
                ? {
                    questions: [
                      { question: "Choose?", options: [{ label: "Alpha" }, { label: "Beta" }] },
                    ],
                  }
                : { file_path: "fixture.txt" },
            _meta: { "codebuddy.ai/toolName": input === "question" ? "AskUserQuestion" : "Write" },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
      if (this.recoverableToolFailure) {
        const callId = `probe-${id}`;
        const arguments_ = { command: "ls missing-test-directory" };
        history.push({
          type: "function_call",
          id: callId,
          parentId: id,
          callId,
          name: "Bash",
          arguments: JSON.stringify(arguments_),
        });
        history.push({
          type: "function_call_result",
          id: `result-${callId}`,
          parentId: callId,
          callId,
          name: "Bash",
          status: "failed",
          output: { type: "text", text: "No such file or directory; exit code 2" },
        });
        this.update({
          sessionUpdate: "tool_call",
          toolCallId: callId,
          rawInput: arguments_,
          _meta: { "codebuddy.ai/toolName": "Bash", "codebuddy.ai/toolArgumentsComplete": true },
        });
        this.update({
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: "failed",
          rawOutput: { type: "text", text: "No such file or directory; exit code 2" },
        });
      }
      return this.complete(id, input);
    }
    complete(id: string, input: string) {
      if (!this.missingHistory)
        history.push({
          id: `assistant-${id}`,
          parentId: history.at(-1)?.id ?? id,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `Result ${input}` }],
        });
      this.update({
        sessionUpdate: "agent_message_chunk",
        messageId: `assistant-${id}`,
        content: { type: "text", text: `Result ${input}` },
      });
      return {
        stopReason: this.nativeStopReason,
        userMessageId: id,
        _meta: { "codebuddy.ai/outcome": this.nativeOutcome },
      };
    }
    async cancel() {
      this.cancelPoisoned = true;
      this.pending?.resolve({ stopReason: "cancelled", userMessageId: this.pending.id });
      this.pending = undefined;
    }
    async answer(sessionId: string, toolCallId: string, answers: Record<string, string[]> | null) {
      this.lastQuestion = { sessionId, toolCallId, answers };
    }
    async close() {
      this.closed = true;
      this.pending?.resolve({ stopReason: "cancelled", userMessageId: this.pending.id });
      this.pending = undefined;
    }
  }
  return {
    clients,
    history,
    clientFactory: ((options) => {
      const client = new FakeClient(options);
      clients.push(client);
      return client;
    }) satisfies CodeBuddyClientFactory,
    readHistory: async () => {
      if (!history.length) throw new CodeBuddyError("sessionNotFound", "Missing fixture history");
      return history.map((row) => JSON.stringify(row)).join("\n");
    },
  };
}
