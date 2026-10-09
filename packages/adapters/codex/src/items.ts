/** Codex `ThreadItem` → codexhost Host Item mapping. */

export type HostItem =
  | { type: "agentMessage"; itemId: string; text: string; phase?: "commentary" | "final_answer" }
  | { type: "reasoning"; itemId: string; text: string }
  | { type: "contextCompaction"; itemId: string }
  | {
      type: "commandExecution";
      itemId: string;
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
      durationMs?: number;
    }
  | {
      type: "toolExecution";
      itemId: string;
      toolName: string;
      namespace?: string;
      arguments: unknown;
      output?: {
        content: Array<
          { type: "text"; text: string } | { type: "image"; mimeType: string; base64Data: string }
        >;
        truncated?: boolean;
      };
      durationMs?: number;
    }
  | {
      type: "fileChange";
      itemId: string;
      changes: Array<{ path: string; kind: "add" | "update" | "delete"; unifiedDiff: string }>;
    }
  | {
      type: "subagentDelegation";
      itemId: string;
      operation: "spawn" | "send";
      prompt?: string;
      subagents: Array<{
        subagentId: string;
        description: string;
        background: boolean;
        status: "pending" | "running" | "completed" | "failed" | "interrupted";
        resultSummary?: string;
        model?: string;
      }>;
    };

export type HostItemOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: { code: string; message: string; retryable: boolean } }
  | { status: "cancelled"; reason?: string };

export type CodexItem = Record<string, unknown> & { type: string; id: string };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Strip the login-shell wrapper Codex adds (`/bin/zsh -lc '<command>'`) for display. */
export function displayCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/u.exec(command.trim());
  if (match === null) return command;
  const inner = (match[1] as string).trim();
  if (
    (inner.startsWith("'") && inner.endsWith("'")) ||
    (inner.startsWith('"') && inner.endsWith('"'))
  ) {
    return inner.slice(1, -1).replace(/'\\''/gu, "'");
  }
  return inner;
}

/** Reasoning text Codex shows: summaries first, raw reasoning when no summary exists. */
export function reasoningText(item: CodexItem): string {
  const summary = Array.isArray(item.summary)
    ? (item.summary as unknown[]).map(text).filter((part) => part !== "")
    : [];
  if (summary.length > 0) return summary.join("\n\n");
  const content = Array.isArray(item.content)
    ? (item.content as unknown[]).map(text).filter((part) => part !== "")
    : [];
  return content.join("\n\n");
}

function mcpOutput(
  result: unknown,
  error: unknown,
): { content: Array<{ type: "text"; text: string }> } | undefined {
  if (error !== null && error !== undefined)
    return {
      content: [
        { type: "text", text: jsonText((error as { message?: unknown }).message ?? error) },
      ],
    };
  if (result === null || result === undefined) return undefined;
  const content = (result as { content?: unknown[] }).content ?? [];
  const parts = content.map((part) => {
    const record = part as { type?: string; text?: unknown };
    return record.type === "text" ? text(record.text) : jsonText(part);
  });
  return { content: [{ type: "text", text: parts.join("\n") }] };
}

function agentStatus(
  value: unknown,
): "pending" | "running" | "completed" | "failed" | "interrupted" {
  const status =
    typeof value === "string" ? value : (value as { status?: string } | undefined)?.status;
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
    case "failed":
    case "notFound":
      return "failed";
    case "interrupted":
    case "shutdown":
      return "interrupted";
    case "pendingInit":
    case "pending":
      return "pending";
    default:
      return "running";
  }
}

/** Map one Codex item; returns undefined for items the Web UI does not render (user input, plans). */
export function toHostItem(item: CodexItem): HostItem | undefined {
  switch (item.type) {
    case "agentMessage": {
      const phase =
        item.phase === "final_answer" || item.phase === "finalAnswer"
          ? "final_answer"
          : item.phase === "commentary"
            ? "commentary"
            : undefined;
      return {
        type: "agentMessage",
        itemId: item.id,
        text: text(item.text),
        ...(phase === undefined ? {} : { phase }),
      };
    }
    case "reasoning":
      return { type: "reasoning", itemId: item.id, text: reasoningText(item) };
    case "contextCompaction":
      return { type: "contextCompaction", itemId: item.id };
    case "commandExecution":
      return {
        type: "commandExecution",
        itemId: item.id,
        command: displayCommand(text(item.command)),
        ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
        ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}),
        ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes)
        ? (item.changes as Array<{ path?: unknown; kind?: { type?: string }; diff?: unknown }>)
        : [];
      return {
        type: "fileChange",
        itemId: item.id,
        changes: changes.map((change) => ({
          path: text(change.path),
          kind:
            change.kind?.type === "add"
              ? "add"
              : change.kind?.type === "delete"
                ? "delete"
                : "update",
          unifiedDiff: text(change.diff),
        })),
      };
    }
    case "mcpToolCall": {
      const output = mcpOutput(item.result, item.error);
      return {
        type: "toolExecution",
        itemId: item.id,
        toolName: text(item.tool),
        namespace: text(item.server),
        arguments: item.arguments ?? {},
        ...(output === undefined ? {} : { output }),
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      };
    }
    case "dynamicToolCall": {
      const contentItems = Array.isArray(item.contentItems)
        ? (item.contentItems as Array<Record<string, unknown>>)
        : undefined;
      return {
        type: "toolExecution",
        itemId: item.id,
        toolName: text(item.tool),
        ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
        arguments: item.arguments ?? {},
        ...(contentItems === undefined
          ? {}
          : {
              output: {
                content: contentItems.map((part) => ({
                  type: "text" as const,
                  text: typeof part.text === "string" ? part.text : jsonText(part),
                })),
              },
            }),
      };
    }
    case "webSearch": {
      const query =
        text(item.query) || text((item.action as { query?: unknown } | undefined)?.query);
      return {
        type: "toolExecution",
        itemId: item.id,
        toolName: "web_search",
        arguments: { queries: query === "" ? [] : [query], query },
      };
    }
    case "imageView":
      return {
        type: "toolExecution",
        itemId: item.id,
        toolName: "read",
        arguments: { file_path: text(item.path) },
      };
    case "collabAgentToolCall": {
      const states = (item.agentsStates ?? {}) as Record<
        string,
        { status?: unknown; message?: unknown } | undefined
      >;
      const receivers = Array.isArray(item.receiverThreadIds)
        ? (item.receiverThreadIds as string[])
        : [];
      return {
        type: "subagentDelegation",
        itemId: item.id,
        operation: item.tool === "sendInput" || item.tool === "send_input" ? "send" : "spawn",
        ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
        subagents: receivers.map((threadId) => ({
          subagentId: threadId,
          description: text(item.prompt).slice(0, 120) || threadId,
          background: false,
          status: agentStatus(states[threadId]?.status ?? item.status),
          ...(typeof states[threadId]?.message === "string"
            ? { resultSummary: states[threadId]?.message as string }
            : {}),
          ...(typeof item.model === "string" ? { model: item.model } : {}),
        })),
      };
    }
    default:
      return undefined;
  }
}

/** Outcome of a completed Codex item. */
export function itemOutcome(item: CodexItem): HostItemOutcome {
  const status = typeof item.status === "string" ? item.status : undefined;
  if (status === "failed" || status === "declined") {
    const message =
      item.type === "commandExecution"
        ? `Command ${status === "declined" ? "declined" : "failed"}`
        : status === "declined"
          ? "Declined"
          : "Failed";
    return {
      status: "failed",
      error: {
        code: status === "declined" ? "declined" : "nativeFailure",
        message,
        retryable: false,
      },
    };
  }
  if (item.type === "mcpToolCall" && item.error !== null && item.error !== undefined) {
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: jsonText((item.error as { message?: unknown }).message ?? item.error),
        retryable: false,
      },
    };
  }
  if (item.type === "dynamicToolCall" && item.success === false) {
    return {
      status: "failed",
      error: { code: "nativeFailure", message: "Tool call failed", retryable: false },
    };
  }
  return { status: "succeeded" };
}

/** Text the user typed, from a `userMessage` item. */
export function userText(item: CodexItem): string {
  const content = Array.isArray(item.content)
    ? (item.content as Array<{ type?: string; text?: unknown; path?: unknown; name?: unknown }>)
    : [];
  return content
    .map((part) => {
      if (part.type === "text") return text(part.text);
      if (part.type === "mention" || part.type === "skill") return `@${text(part.name)}`;
      if (part.type === "localImage") return `[image: ${text(part.path)}]`;
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}
