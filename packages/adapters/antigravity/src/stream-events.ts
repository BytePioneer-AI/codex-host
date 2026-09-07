/**
 * Antigravity CLI `--output-format stream-json` protocol shapes.
 *
 * Kept separate from the Session orchestration so both the Adapter and the
 * quota reader can decode the same NDJSON envelope without duplicating it.
 */

export interface AntigravityUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  thinking_tokens?: unknown;
  cache_read_tokens?: unknown;
  total_tokens?: unknown;
  context_used_tokens?: unknown;
  context_window_tokens?: unknown;
  estimated_tokens_used?: unknown;
  max_context_tokens?: unknown;
}

export interface AntigravityInitEvent {
  event: "init";
  conversation_id: string;
  init?: { permission_mode?: string };
}

export interface AntigravityStepUpdateEvent {
  event: "step_update";
  step_update: {
    conversation_id: string;
    step_index: number;
    state: "ACTIVE" | "DONE" | "ERROR" | string;
    step_type: string;
    text_delta?: string;
    text?: string;
    content?: string;
    message?: string;
    duration_seconds?: number;
    usage?: AntigravityUsage;
    tool_name?: string;
    subagent_info?: unknown;
    tool_info?: {
      name?: string;
      parameters?: unknown;
      output?: unknown;
      error?: unknown;
    };
  };
}

export interface AntigravityResultEvent {
  event: "result";
  result: {
    conversation_id: string;
    status: string;
    response?: string;
    error?: string;
    num_turns: number;
    usage?: AntigravityUsage;
  };
}

/**
 * Emitted for slash commands answered by the CLI itself. The CLI rejects slash
 * commands on `--input-format stream-json`, so this only arrives from a
 * dedicated `--print=/<command>` invocation.
 */
export interface AntigravityCommandResultEvent {
  event: "command_result";
  command: unknown;
}

export type AntigravityStreamEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent
  | AntigravityCommandResultEvent;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.event !== "string") return null;
  if (
    parsed.event === "init" &&
    typeof parsed.conversation_id === "string" &&
    parsed.conversation_id.length > 0
  ) {
    return parsed as unknown as AntigravityInitEvent;
  }
  if (
    parsed.event === "step_update" &&
    isRecord(parsed.step_update) &&
    typeof parsed.step_update.conversation_id === "string" &&
    typeof parsed.step_update.step_index === "number" &&
    typeof parsed.step_update.state === "string" &&
    typeof parsed.step_update.step_type === "string"
  ) {
    return parsed as unknown as AntigravityStepUpdateEvent;
  }
  if (
    parsed.event === "result" &&
    isRecord(parsed.result) &&
    typeof parsed.result.conversation_id === "string" &&
    typeof parsed.result.status === "string" &&
    typeof parsed.result.num_turns === "number"
  ) {
    return parsed as unknown as AntigravityResultEvent;
  }
  if (parsed.event === "command_result") return parsed as unknown as AntigravityCommandResultEvent;
  return null;
}

/** Reads the diagnostic the CLI attaches to a failed tool step. */
export function antigravityToolErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  const message = value.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * Headless agy never asks the client to approve a tool: it evaluates its own
 * permission rules and reports a denial as a tool error. Recognising that shape
 * is what lets the Adapter explain an otherwise silent no-op Turn.
 */
export function isAntigravityPermissionDenial(message: string): boolean {
  return /permission check failed|denied permission|permission denied/iu.test(message);
}
