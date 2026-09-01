import type { HostSubagentStatus } from "@codexhost/harness-adapter";

import { grokToolName } from "./grok-tool-output.js";

const SPAWN_TOOL_NAMES = new Set(["spawn_subagent", "spawn_agent", "task"]);
const SEND_TOOL_NAMES = new Set(["send_subagent_message"]);
const WAIT_TOOL_NAMES = new Set([
  "get_command_or_subagent_output",
  "get_task_output",
  "wait_tasks",
]);
const KILL_TOOL_NAMES = new Set(["kill_command_or_subagent", "kill_task"]);
const DESCRIPTION_LIMIT = 500;
const SUMMARY_LIMIT = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field === "string") {
    const trimmed = field.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof field === "number" && Number.isFinite(field)) return String(field);
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") return undefined;
  const trimmed = value[key].trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.slice(0, limit);
}

function toolId(name?: string | null, title?: string | null): string {
  return grokToolName(name, title).toLowerCase();
}

function collectIds(value: unknown): string[] {
  const ids: string[] = [];
  const push = (entry: unknown): void => {
    if (typeof entry === "string" && entry.trim().length > 0) ids.push(entry.trim());
    else if (typeof entry === "number" && Number.isFinite(entry)) ids.push(String(entry));
  };
  push(idField(value, "task_id"));
  push(idField(value, "subagent_id"));
  if (isRecord(value)) {
    const list = value.task_ids ?? value.subagent_ids;
    if (Array.isArray(list)) {
      for (const entry of list) push(entry);
    } else {
      push(list);
    }
  }
  return [...new Set(ids)];
}

export function grokSubagentOperation(
  name?: string | null,
  title?: string | null,
  rawInput?: unknown,
): "spawn" | "send" | null {
  const id = toolId(name, title);
  if (WAIT_TOOL_NAMES.has(id) || KILL_TOOL_NAMES.has(id)) return null;
  if (SEND_TOOL_NAMES.has(id)) return "send";
  if (SPAWN_TOOL_NAMES.has(id)) return "spawn";
  if (isRecord(rawInput) && rawInput.variant === "Task") return "spawn";
  return null;
}

export function grokSubagentWaitIds(
  name?: string | null,
  title?: string | null,
  rawInput?: unknown,
): string[] {
  if (!WAIT_TOOL_NAMES.has(toolId(name, title)) && !KILL_TOOL_NAMES.has(toolId(name, title))) {
    return [];
  }
  return collectIds(rawInput);
}

export function grokSubagentKill(name?: string | null, title?: string | null): boolean {
  return KILL_TOOL_NAMES.has(toolId(name, title));
}

export function grokSubagentDescription(
  rawInput: unknown,
  title?: string | null,
  fallback = "Grok Subagent",
): string {
  return (
    bounded(stringField(rawInput, "description"), DESCRIPTION_LIMIT) ??
    bounded(stringField(rawInput, "name"), DESCRIPTION_LIMIT) ??
    (title &&
    !SPAWN_TOOL_NAMES.has(title.toLowerCase()) &&
    !SEND_TOOL_NAMES.has(title.toLowerCase())
      ? bounded(title, DESCRIPTION_LIMIT)
      : undefined) ??
    fallback
  );
}

export function grokSubagentPrompt(rawInput: unknown): string | undefined {
  return bounded(
    stringField(rawInput, "prompt") ?? stringField(rawInput, "message"),
    SUMMARY_LIMIT,
  );
}

export function grokSubagentRole(rawInput: unknown): string | undefined {
  return bounded(
    stringField(rawInput, "subagent_type") ??
      stringField(rawInput, "agent_type") ??
      stringField(rawInput, "type"),
    DESCRIPTION_LIMIT,
  );
}

export function grokSubagentBackground(rawInput: unknown): boolean {
  if (!isRecord(rawInput)) return true;
  if (rawInput.background === false || rawInput.run_in_background === false) return false;
  return true;
}

export function grokNativeSubagentId(...candidates: unknown[]): string | undefined {
  const fromKey = (key: string): string | undefined => {
    for (const candidate of candidates) {
      const value = idField(candidate, key);
      if (value) return value;
    }
    return undefined;
  };
  const fromText = (pattern: RegExp): string | undefined => {
    for (const candidate of candidates) {
      const text = extractText(candidate);
      const match = text?.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return undefined;
  };
  return (
    fromKey("subagent_id") ??
    fromText(/subagent_id:\s*([^\s]+)/i) ??
    fromKey("task_id") ??
    fromKey("id") ??
    fromText(/task_id:\s*([^\s]+)/i) ??
    fromText(/task_ids=\["([^"]+)"\]/)
  );
}

export function grokSubagentResultSummary(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) return bounded(text, SUMMARY_LIMIT);
  }
  return undefined;
}

export function grokSubagentWaitSettlements(input: {
  name?: string | null;
  title?: string | null;
  rawInput?: unknown;
  content?: unknown;
  rawOutput?: unknown;
}): Array<{ id: string; status: HostSubagentStatus }> {
  const ids = grokSubagentWaitIds(input.name, input.title, input.rawInput);
  if (grokSubagentKill(input.name, input.title)) {
    return ids.map((id) => ({ id, status: "interrupted" as const }));
  }
  if (ids.length === 0) return [];

  const resultEntries = taskOutputResults(input.rawOutput);
  if (resultEntries.length > 0) {
    const settled: Array<{ id: string; status: HostSubagentStatus }> = [];
    for (const result of resultEntries) {
      const id = idField(result, "task_id") ?? idField(result, "subagent_id");
      const status = mapTaskStatus(typeof result.status === "string" ? result.status : undefined);
      if (!id || !status || status === "running" || status === "pending") continue;
      settled.push({ id, status });
    }
    return settled;
  }

  const overall = mapTaskStatus(taskOutputStatus(input.rawOutput, input.content));
  if (!overall || overall === "running" || overall === "pending") return [];
  return ids.map((id) => ({ id, status: overall }));
}

function taskOutputResults(rawOutput: unknown): Array<Record<string, unknown>> {
  if (!isRecord(rawOutput)) return [];
  if (Array.isArray(rawOutput.results)) {
    return rawOutput.results.filter(isRecord);
  }
  if (typeof rawOutput.status === "string") return [rawOutput];
  return [];
}

function taskOutputStatus(rawOutput: unknown, content: unknown): string | undefined {
  if (isRecord(rawOutput) && typeof rawOutput.status === "string") return rawOutput.status;
  const text = extractText(content) ?? extractText(rawOutput);
  if (!text) return undefined;
  if (/<subagent_meta>|<subagent_result>/i.test(text)) return "completed";
  if (/\bstatus["']?\s*[:=]\s*["']?completed/i.test(text)) return "completed";
  if (/\bstatus["']?\s*[:=]\s*["']?failed/i.test(text)) return "failed";
  if (/\bstatus["']?\s*[:=]\s*["']?(cancelled|canceled|interrupted)/i.test(text)) {
    return "interrupted";
  }
  if (/\bstill running\b|\bstatus["']?\s*[:=]\s*["']?(running|pending|in_progress)/i.test(text)) {
    return "running";
  }
  return undefined;
}

function mapTaskStatus(status: string | undefined): HostSubagentStatus | undefined {
  if (!status) return undefined;
  switch (status.toLowerCase()) {
    case "completed":
    case "succeeded":
    case "success":
      return "completed";
    case "failed":
    case "error":
    case "errored":
      return "failed";
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "interrupted";
    case "running":
    case "pending":
    case "in_progress":
    case "inprogress":
      return "running";
    default:
      return undefined;
  }
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const text = extractText(entry, depth + 1);
      return text ? [text] : [];
    });
    const joined = parts.join("\n").trim();
    return joined.length > 0 ? joined : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string" && value.text.trim().length > 0) return value.text.trim();
  if (typeof value.output === "string" && value.output.trim().length > 0) {
    return value.output.trim();
  }
  if (value.content !== undefined) return extractText(value.content, depth + 1);
  return undefined;
}
