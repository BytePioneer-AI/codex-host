import type {
  HostApprovalInteraction,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemUpdate,
  HostQuestionInteraction,
  HostTurnSnapshot,
  HistoricalTurnOutcome,
  InteractionClosedEvent,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  TurnCompletedEvent,
  TurnStartedEvent,
} from "@codexhost/harness-adapter";
import type {
  HostInteractionId,
  HostItemId,
  HostTurnId,
  JsonObject,
  JsonValue,
} from "@codexhost/shared-contracts";
import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";
import {
  type CodexApprovalRequestProjection,
  projectCodexApprovalRequest,
} from "./codex-approval.js";
import {
  projectCodexQuestionRequest,
  type CodexQuestionRequestProjection,
} from "./codex-question.js";

function prettyCollabReasoningEffort(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "xhigh") return "xHigh";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function formatCollabSpawnModel(
  model: string | undefined,
  reasoningEffort: string | undefined,
): string | null {
  const modelLabel = model?.trim() || undefined;
  const effortLabel = prettyCollabReasoningEffort(reasoningEffort);
  if (modelLabel && effortLabel) return `${modelLabel} · ${effortLabel}`;
  return modelLabel || effortLabel || null;
}

export type ProjectableHostEvent =
  | TurnStartedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | InteractionClosedEvent
  | TurnCompletedEvent;

export interface CodexTurnProjection {
  messages: JsonObject[];
  completedTurn?: JsonObject;
}

export interface CodexApprovalProjection extends CodexTurnProjection {
  approvalRequest: CodexApprovalRequestProjection;
}

export interface CodexQuestionProjection extends CodexTurnProjection {
  itemId: HostItemId;
  questionRequest: CodexQuestionRequestProjection;
}

export interface HistoricalTurnProjectionInput {
  turnId: HostTurnId;
  cwd: string;
  snapshot: HostTurnSnapshot;
}

interface ProjectedItem {
  item: HostItem;
  outcome: HostItemOutcome | null;
  reasoningPartStarted: boolean;
  streamedCommandOutput: boolean;
  wireStarted: boolean;
  wireFileChanges: HostFileChange[] | null;
  startedAtMs?: number;
  durationMs?: number;
}

function resolvedItemDurationMs(
  item: HostItem,
  startedAtMs: number,
  completedAtMs: number,
): number {
  if (
    (item.type === "commandExecution" || item.type === "toolExecution") &&
    item.durationMs !== undefined
  ) {
    return item.durationMs;
  }
  return Math.max(0, completedAtMs - startedAtMs);
}

function withResolvedDuration(item: HostItem, durationMs: number): HostItem {
  if (item.type !== "commandExecution" && item.type !== "toolExecution") return item;
  return { ...item, durationMs };
}

type ProjectedInteraction =
  { type: "approval" } | { type: "question"; itemId: HostItemId; syntheticItem: boolean };

function itemStatus(outcome: HostItemOutcome | null): "inProgress" | "completed" | "failed" {
  if (!outcome) return "inProgress";
  return outcome.status === "succeeded" ? "completed" : "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedString(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim().length > 0) return field.trim();
    if (Array.isArray(field)) {
      const joined = field
        .filter((entry): entry is string => typeof entry === "string")
        .join(" ")
        .trim();
      if (joined.length > 0) return joined;
    }
  }
  for (const wrapper of ["input", "arguments", "params"] as const) {
    const nested = nestedString(value[wrapper], keys);
    if (nested) return nested;
  }
  return undefined;
}

function toolOutputText(item: Extract<HostItem, { type: "toolExecution" }>): string | null {
  if (!item.output) return null;
  const text = item.output.content
    .filter(
      (content): content is Extract<(typeof item.output.content)[number], { type: "text" }> =>
        content.type === "text",
    )
    .map(({ text }) => text)
    .join("");
  return text.length > 0 ? text : null;
}

function extractEditPath(args: JsonValue): string | undefined {
  const directPath = nestedString(args, ["path", "file_path", "filePath", "file", "target"]);
  if (directPath) return directPath;
  if (isRecord(args) && typeof args.input === "string") {
    const match = args.input.match(/^\s*\[([^#\]\s]+)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function formatHubCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "hub";
  const op = typeof args.op === "string" ? args.op.trim().toLowerCase() : undefined;
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  const to = typeof args.to === "string" ? args.to.trim() : undefined;
  const message =
    typeof args.message === "string"
      ? args.message.trim()
      : typeof args.text === "string"
        ? args.text.trim()
        : undefined;
  const application = typeof args.application === "string" ? args.application.trim() : undefined;
  const appArgs = Array.isArray(args.args)
    ? args.args.map(String).join(" ")
    : typeof args.args === "string"
      ? args.args.trim()
      : "";
  const ids = Array.isArray(args.ids)
    ? args.ids.map(String).join(" ")
    : typeof args.ids === "string"
      ? args.ids.trim()
      : undefined;
  const status = typeof args.status === "string" ? args.status.trim() : undefined;
  const from = typeof args.from === "string" ? args.from.trim() : undefined;
  const intent = typeof args.i === "string" ? args.i.trim() : undefined;
  const command = nestedString(args, ["command", "cmd", "script", "commandLine", "command_line"]);

  if (command && /\bhub\s+(?:start|spawn|restart)\b/i.test(command)) return command;
  if (op === "start" || op === "spawn") {
    const target = name ? ` ${name}` : "";
    const exec = application ? ` -- ${application}${appArgs ? ` ${appArgs}` : ""}` : "";
    return `hub start${target}${exec}`;
  }
  if (op === "stop") {
    return name ? `hub stop ${name}` : "hub stop";
  }
  if (op === "restart") {
    return name ? `hub restart ${name}` : "hub restart";
  }
  if (op === "send") {
    const target = to ?? name;
    if (target && message) return `hub send ${target}: ${message}`;
    if (target) return `hub send ${target}`;
    if (message) return `hub send ${message}`;
    return "hub send";
  }
  if (op === "logs") {
    return name ? `hub logs ${name}` : "hub logs";
  }
  if (op === "wait") {
    if (name) return `hub wait ${name}`;
    if (from) return `hub wait --from ${from}`;
    if (ids) return `hub wait ${ids}`;
    return "hub wait";
  }
  if (op === "cancel") {
    return ids ? `hub cancel ${ids}` : "hub cancel";
  }
  if (op === "describe") {
    return name ? `hub describe ${name}` : "hub describe";
  }
  if (op === "list") {
    return status ? `hub list --status ${status}` : "hub list";
  }
  if (op === "jobs" || op === "ps" || op === "inbox") {
    return `hub ${op}`;
  }
  if (op) {
    const rest = [name, to, ids, status].filter(Boolean).join(" ");
    return rest ? `hub ${op} ${rest}` : `hub ${op}`;
  }
  if (to && message) return `hub send ${to}: ${message}`;
  if (name && message) return `hub send ${name}: ${message}`;
  if (intent) return `hub: ${intent}`;
  return "hub";
}

function formatTaskCommandLine(toolName: string, args: JsonValue): string {
  if (!isRecord(args)) return toolName;
  if (typeof args.task === "string" && args.task.trim().length > 0) {
    return `${toolName}: ${args.task.trim()}`;
  }
  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    const first = args.tasks[0];
    if (isRecord(first)) {
      const desc =
        typeof first.name === "string" && first.name.trim().length > 0
          ? first.name.trim()
          : typeof first.task === "string" && first.task.trim().length > 0
            ? first.task.trim()
            : undefined;
      if (desc) {
        return args.tasks.length > 1
          ? `${toolName} (${args.tasks.length} tasks): ${desc}`
          : `${toolName}: ${desc}`;
      }
    }
  }
  if (typeof args.name === "string" && args.name.trim().length > 0) {
    return `${toolName} ${args.name.trim()}`;
  }
  if (typeof args.context === "string" && args.context.trim().length > 0) {
    const firstLine = args.context.trim().split("\n")[0]?.trim();
    if (firstLine) return `${toolName}: ${firstLine}`;
  }
  if (typeof args.i === "string" && args.i.trim().length > 0) {
    return `${toolName}: ${args.i.trim()}`;
  }
  return toolName;
}

function formatEvalCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "eval";
  const lang = typeof args.language === "string" ? args.language.trim() : undefined;
  const title = typeof args.title === "string" ? args.title.trim() : undefined;
  if (lang && title) return `eval ${lang}: ${title}`;
  if (lang) return `eval ${lang}`;
  if (title) return `eval: ${title}`;
  return "eval";
}

function formatTodoCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "todo";
  const op = typeof args.op === "string" ? args.op.trim() : undefined;
  const task = typeof args.task === "string" ? args.task.trim() : undefined;
  const phase = typeof args.phase === "string" ? args.phase.trim() : undefined;
  if (op && task) return `todo ${op} "${task}"`;
  if (op && phase) return `todo ${op} "${phase}"`;
  if (op) return `todo ${op}`;
  return "todo";
}

function formatSearchCommandLine(toolName: string, args: JsonValue): string {
  if (!isRecord(args)) return toolName;
  const query = typeof args.query === "string" ? args.query.trim() : undefined;
  if (query) return `${toolName} "${query}"`;
  return toolName;
}

function formatAstEditCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "ast_edit";
  const paths = Array.isArray(args.paths) ? args.paths.map(String).join(" ") : undefined;
  if (paths) return `ast_edit ${paths}`;
  return "ast_edit";
}

function formatLspCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "lsp";
  const action = typeof args.action === "string" ? args.action.trim() : undefined;
  const file = typeof args.file === "string" ? args.file.trim() : undefined;
  const symbol = typeof args.symbol === "string" ? args.symbol.trim() : undefined;
  const query = typeof args.query === "string" ? args.query.trim() : undefined;
  const target = symbol ?? query ?? file;
  if (action && target) return `lsp ${action} ${target}`;
  if (action) return `lsp ${action}`;
  return "lsp";
}

function formatBrowserCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "browser";
  const action = typeof args.action === "string" ? args.action.trim() : undefined;
  const url = typeof args.url === "string" ? args.url.trim() : undefined;
  if (action && url) return `browser ${action} ${url}`;
  if (action) return `browser ${action}`;
  return "browser";
}

function formatDebugCommandLine(args: JsonValue): string {
  if (!isRecord(args)) return "debug";
  const action = typeof args.action === "string" ? args.action.trim() : undefined;
  const program = typeof args.program === "string" ? args.program.trim() : undefined;
  if (action && program) return `debug ${action} ${program}`;
  if (action) return `debug ${action}`;
  return "debug";
}

/**
 * Codex Desktop only renders a detailed, expandable card for Command Execution.
 * Generic `dynamicToolCall` items show the tool name with no path, pattern, or
 * output. Lift Read/Glob/Grep/Hub/Task/Eval/Todo/Edit/Write/shell tools into
 * that lane when a command line can be reconstructed from the native arguments.
 */
export function toolCommandLine(toolName: string, args: JsonValue): string | undefined {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  const command = nestedString(args, ["command", "cmd", "script", "commandLine", "command_line"]);
  if (
    command &&
    ["bash", "exec", "terminal", "run", "shell", "powershell", "command", "sh"].includes(lower)
  ) {
    return command;
  }
  if (lower === "hub") {
    return formatHubCommandLine(args);
  }
  if (["task", "agent", "delegate", "subagent"].includes(lower)) {
    return formatTaskCommandLine(toolName, args);
  }
  if (lower === "eval") {
    return formatEvalCommandLine(args);
  }
  if (["todo", "todolist", "tasklist"].includes(lower)) {
    return formatTodoCommandLine(args);
  }
  if (["websearch", "websearchtool", "search"].includes(lower) || lower === "websearch") {
    return formatSearchCommandLine(toolName, args);
  }
  if (lower === "astedit") {
    return formatAstEditCommandLine(args);
  }
  if (lower === "lsp") {
    return formatLspCommandLine(args);
  }
  if (lower === "browser") {
    return formatBrowserCommandLine(args);
  }
  if (lower === "debug") {
    return formatDebugCommandLine(args);
  }
  const filePath = nestedString(args, [
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target",
    "uri",
  ]);
  const pattern = nestedString(args, ["pattern", "glob", "glob_pattern", "query", "regex"]);
  if (["read", "readfile", "fileread", "view"].includes(lower)) {
    return filePath ? `read ${filePath}` : "read";
  }
  if (["glob", "find", "findfiles"].includes(lower)) {
    const target = pattern ?? filePath;
    return target ? `glob ${target}` : "glob";
  }
  if (["grep", "grepsearch"].includes(lower)) {
    if (pattern) {
      return filePath ? `grep ${pattern} ${filePath}` : `grep ${pattern}`;
    }
    return filePath ? `grep ${filePath}` : "grep";
  }
  if (
    [
      "edit",
      "editfile",
      "fileedit",
      "strreplace",
      "searchreplace",
      "applypatch",
      "replace",
      "patch",
      "multiedit",
    ].includes(lower)
  ) {
    const editPath = extractEditPath(args);
    return editPath ? `edit ${editPath}` : "edit";
  }
  if (["write", "writefile", "filewrite", "create", "createfile"].includes(lower)) {
    return filePath ? `write ${filePath}` : "write";
  }
  if (isRecord(args) && typeof args.i === "string" && args.i.trim().length > 0) {
    return `${toolName}: ${args.i.trim()}`;
  }
  return undefined;
}

function compactToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[_-]/g, "");
}

function isFileMutatingTool(toolName: string): boolean {
  return [
    "edit",
    "editfile",
    "fileedit",
    "strreplace",
    "searchreplace",
    "applypatch",
    "replace",
    "multiedit",
    "write",
    "writefile",
    "filewrite",
    "create",
    "createfile",
  ].includes(compactToolName(toolName));
}

function isWriteTool(toolName: string): boolean {
  return ["write", "writefile", "filewrite", "create", "createfile"].includes(
    compactToolName(toolName),
  );
}

function simpleUnifiedDiff(
  displayedPath: string,
  oldText: string,
  newText: string,
  kind: "add" | "update",
): string {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();
  const oldHeader = kind === "add" ? "/dev/null" : `a/${displayedPath}`;
  const newHeader = `b/${displayedPath}`;
  const oldRange = kind === "add" ? "0,0" : `1,${oldLines.length}`;
  const newRange = newLines.length === 0 ? "0,0" : `1,${newLines.length}`;
  return [
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function fileChangeFromTool(toolName: string, args: JsonValue): HostFileChange[] | null {
  if (!isFileMutatingTool(toolName)) return null;
  const displayedPath = nestedString(args, ["path", "file_path", "filePath", "file"]);
  if (!displayedPath) return null;
  if (isWriteTool(toolName)) {
    const content = nestedString(args, [
      "content",
      "new_string",
      "newString",
      "newText",
      "file_text",
      "text",
      "new",
    ]);
    if (content === undefined) return null;
    return [
      {
        path: displayedPath,
        kind: "add",
        unifiedDiff: simpleUnifiedDiff(displayedPath, "", content, "add"),
      },
    ];
  }
  const oldText = nestedString(args, ["old_string", "oldString", "oldText", "old_text", "old"]);
  const newText = nestedString(args, [
    "new_string",
    "newString",
    "newText",
    "new_text",
    "content",
    "new",
  ]);
  if (oldText === undefined || newText === undefined) return null;
  return [
    {
      path: displayedPath,
      kind: "update",
      unifiedDiff: simpleUnifiedDiff(displayedPath, oldText, newText, "update"),
    },
  ];
}

function projectFileChangeKind(kind: HostFileChange["kind"]): JsonValue {
  if (kind === "update") return { type: "update", move_path: null };
  return { type: kind };
}

function projectFileChanges(changes: HostFileChange[]): JsonValue[] {
  return changes.map(({ path, kind, unifiedDiff }) => ({
    path,
    kind: projectFileChangeKind(kind),
    diff: unifiedDiff,
  }));
}

function wireFileChangeItem(
  projected: ProjectedItem,
): Extract<HostItem, { type: "fileChange" }> | null {
  if (projected.item.type === "fileChange") return projected.item;
  if (!projected.wireFileChanges) return null;
  return {
    type: "fileChange",
    itemId: projected.item.itemId,
    changes: projected.wireFileChanges,
  };
}

type CodexPlanStepStatus = "pending" | "inProgress" | "completed";

function isTodoTool(toolName: string): boolean {
  const compact = compactToolName(toolName);
  return compact.includes("todo") || ["updateplan", "updatetodolist"].includes(compact);
}

export function todoPlanFromTool(
  toolName: string,
  args: JsonValue,
): { explanation: string | null; plan: { step: string; status: CodexPlanStepStatus }[] } | null {
  return isTodoTool(toolName) ? planFromTodoValue(args) : null;
}

function planFromTodoValue(
  value: unknown,
): { explanation: string | null; plan: { step: string; status: CodexPlanStepStatus }[] } | null {
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as { content: unknown }).content)
  ) {
    const output = value as Extract<HostItem, { type: "toolExecution" }>["output"];
    if (output) {
      const text = output.content
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n");
      const fromText = planFromChecklistText(text);
      if (fromText) return fromText;
    }
  }
  const record = unwrapToolRecord(value);
  if (!record) return planFromChecklistText(typeof value === "string" ? value : null);
  if (isRecord(record.TodosUpdated)) {
    const nested = planFromTodoValue(record.TodosUpdated);
    if (nested) return nested;
  }
  const explanation = nestedString(record, ["explanation", "message", "summary"]) ?? null;
  const list = coerceTodoList(
    record.todos ?? record.items ?? record.plan ?? record.tasks ?? record.entries,
  );
  if (!list || list.length === 0) return planFromChecklistText(explanation);
  const plan: { step: string; status: CodexPlanStepStatus }[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      plan.push({ step: entry.trim(), status: "pending" });
      continue;
    }
    if (!isRecord(entry)) continue;
    const step = nestedString(entry, ["content", "step", "text", "title", "description", "task"]);
    if (!step) continue;
    plan.push({ step, status: planStatus(entry.status) });
  }
  return plan.length > 0 ? { explanation, plan } : planFromChecklistText(explanation);
}

function coerceTodoList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    const record = unwrapToolRecord(parsed);
    return record
      ? coerceTodoList(
          record.todos ?? record.items ?? record.plan ?? record.tasks ?? record.entries,
        )
      : null;
  } catch {
    return (
      planFromChecklistText(trimmed)?.plan.map(({ step, status }) => ({ content: step, status })) ??
      null
    );
  }
}

function planFromChecklistText(
  value: string | null | undefined,
): { explanation: string | null; plan: { step: string; status: CodexPlanStepStatus }[] } | null {
  if (!value) return null;
  const plan: { step: string; status: CodexPlanStepStatus }[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const match = line.match(/^\s*[-*]\s*\[([^\]]+)\]\s*(?:\d+:\s*)?(.+?)\s*$/u);
    if (!match?.[1] || !match[2]) continue;
    const step = match[2].trim();
    if (step.length === 0) continue;
    plan.push({ step, status: planStatus(match[1]) });
  }
  return plan.length > 0 ? { explanation: null, plan } : null;
}

function unwrapToolRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
    try {
      return unwrapToolRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return { todos: value };
  if (!isRecord(value)) return null;
  for (const wrapper of ["input", "arguments", "params"] as const) {
    if (value[wrapper] === undefined) continue;
    const nested = unwrapToolRecord(value[wrapper]);
    if (nested) return nested;
  }
  return value;
}

function planStatus(value: unknown): CodexPlanStepStatus {
  if (typeof value !== "string") return "pending";
  const lower = value.toLowerCase().replaceAll(/[_-]/g, "");
  if (["inprogress", "doing", "current", "active", "started", "working"].includes(lower)) {
    return "inProgress";
  }
  if (["completed", "complete", "done", "finished", "x", "yes", "checked"].includes(lower)) {
    return "completed";
  }
  return "pending";
}

function toolContentItems(item: Extract<HostItem, { type: "toolExecution" }>): JsonValue[] | null {
  if (!item.output) return null;
  return item.output.content.map((content) =>
    content.type === "text"
      ? { type: "inputText", text: content.text }
      : {
          type: "inputImage",
          imageUrl: `data:${content.mimeType};base64,${content.base64Data}`,
        },
  );
}

function collabAgentStatus(
  status: Extract<HostItem, { type: "subagentDelegation" }>["subagents"][number]["status"],
): string {
  switch (status) {
    case "pending":
      return "pendingInit";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "interrupted":
      return "interrupted";
  }
}

function collabAgentModel(
  subagent: Extract<HostItem, { type: "subagentDelegation" }>["subagents"][number] | undefined,
): string | null {
  return formatCollabSpawnModel(subagent?.model, subagent?.reasoningEffort);
}

function processIdFromCommand(command: string | undefined): string | null {
  if (!command) return null;
  return command.match(/\bhub\s+(?:start|spawn|restart)\s+([^\s]+)/i)?.[1] ?? null;
}

function wireProcessId(item: Extract<HostItem, { type: "commandExecution" }>): string | null {
  return item.processId ?? processIdFromCommand(item.command);
}

/**
 * Official Codex keeps a PTY card live while it still has a processId and no
 * exit code. Hub start/spawn/restart command lines are the same shape even
 * when the Adapter has not yet attached an explicit processId.
 */
function liveProcessId(item: HostItem): string | null {
  if (item.type === "commandExecution") {
    if (item.exitCode !== undefined && item.exitCode !== null) return null;
    return wireProcessId(item);
  }
  return null;
}

function projectItem(
  item: HostItem,
  outcome: HostItemOutcome | null,
  defaultCwd: string,
  includeCommandOutput = true,
  senderThreadId?: string,
): JsonObject {
  switch (item.type) {
    case "agentMessage":
      return {
        id: item.itemId,
        type: "agentMessage",
        text: item.text,
        phase: null,
        memoryCitation: null,
      };
    case "reasoning":
      return {
        id: reasoningPreviewItemId(item.itemId),
        type: "reasoning",
        summary: item.text.length > 0 ? [item.text] : [],
        content: [],
      };
    case "contextCompaction":
      return { id: item.itemId, type: "contextCompaction" };
    case "commandExecution": {
      const processId = wireProcessId(item);
      return {
        id: item.itemId,
        type: "commandExecution",
        pluginId: null,
        scriptPath: null,
        command: item.command,
        cwd: item.cwd ?? defaultCwd,
        processId,
        source: processId ? "unifiedExecStartup" : "agent",
        status: itemStatus(outcome),
        commandActions: [],
        aggregatedOutput: includeCommandOutput ? (item.output ?? null) : null,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
      };
    }
    case "toolExecution": {
      const command = toolCommandLine(item.toolName, item.arguments);
      if (command) {
        const processId = processIdFromCommand(command);
        return {
          id: item.itemId,
          type: "commandExecution",
          pluginId: null,
          scriptPath: null,
          command,
          cwd: defaultCwd,
          processId,
          source: processId ? "unifiedExecStartup" : "agent",
          status: itemStatus(outcome),
          commandActions: [],
          aggregatedOutput: includeCommandOutput ? toolOutputText(item) : null,
          exitCode: outcome ? (outcome.status === "succeeded" ? 0 : 1) : null,
          durationMs: item.durationMs ?? null,
        };
      }
      const status = itemStatus(outcome);
      return {
        id: item.itemId,
        type: "dynamicToolCall",
        namespace: item.namespace ?? null,
        tool: item.toolName,
        arguments: item.arguments,
        status,
        contentItems: toolContentItems(item),
        success: outcome ? outcome.status === "succeeded" : null,
        durationMs: item.durationMs ?? null,
      };
    }
    case "fileChange":
      return {
        id: item.itemId,
        type: "fileChange",
        changes: projectFileChanges(item.changes),
        status: itemStatus(outcome),
      };
    case "subagentDelegation": {
      const primary = item.subagents[0];
      return {
        id: item.itemId,
        type: "collabAgentToolCall",
        tool: item.operation === "spawn" ? "spawnAgent" : "sendInput",
        status: itemStatus(outcome),
        senderThreadId: senderThreadId ?? "",
        receiverThreadIds: item.subagents.map(({ subagentId }) => subagentId),
        prompt: item.prompt ?? null,
        model: collabAgentModel(primary),
        reasoningEffort: primary?.reasoningEffort ?? null,
        agentsStates: Object.fromEntries(
          item.subagents.map(({ subagentId, status, resultSummary }) => [
            subagentId,
            { status: collabAgentStatus(status), message: resultSummary ?? null },
          ]),
        ),
      };
    }
  }
}

/**
 * Codex only renders a Command Execution card for the Item id it was given by
 * the Host, so the transcript twin keeps the original id and the ephemeral
 * native Reasoning preview takes the derived one.
 */
export function reasoningPreviewItemId(itemId: HostItemId): string {
  return `${itemId}-summary`;
}

/**
 * Codex renders Reasoning summary deltas as an ephemeral one-line preview but
 * keeps no text after the Turn. The Command Execution lane is the one that
 * retains text, so each Reasoning Item also projects a parallel transcript twin.
 */
function projectReasoningTranscriptItem(
  item: Extract<HostItem, { type: "reasoning" }>,
  outcome: HostItemOutcome | null,
  defaultCwd: string,
  durationMs: number | null = null,
): JsonObject {
  return {
    id: item.itemId,
    type: "commandExecution",
    command: REASONING_TRANSCRIPT_COMMAND,
    cwd: defaultCwd,
    processId: null,
    source: "agent",
    status: itemStatus(outcome),
    commandActions: [],
    aggregatedOutput: item.text.length > 0 ? item.text : null,
    exitCode: outcome ? 0 : null,
    durationMs,
  };
}

function turnStatus(
  outcome: TurnCompletedEvent["outcome"],
): "completed" | "interrupted" | "failed" {
  if (outcome.status === "succeeded") return "completed";
  if (outcome.status === "cancelled") return "interrupted";
  return "failed";
}

function turnError(outcome: TurnCompletedEvent["outcome"]): JsonObject | null {
  return outcome.status === "failed"
    ? {
        message: outcome.error.message,
        codexErrorInfo: "other",
        additionalDetails: null,
      }
    : null;
}

function historicalStatus(outcome: HistoricalTurnOutcome): "completed" | "interrupted" | "failed" {
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "cancelled") return "interrupted";
  return "completed";
}

export function projectHistoricalTurn(input: HistoricalTurnProjectionInput): JsonObject {
  const { turnId, cwd, snapshot } = input;
  const error =
    snapshot.outcome.status === "failed"
      ? {
          message: snapshot.outcome.error.message,
          codexErrorInfo: "other",
          additionalDetails: null,
        }
      : null;
  const startedAt =
    snapshot.startedAt !== undefined
      ? snapshot.startedAt > 10_000_000_000
        ? Math.floor(snapshot.startedAt / 1000)
        : snapshot.startedAt
      : null;
  const completedAt =
    snapshot.completedAt !== undefined
      ? snapshot.completedAt > 10_000_000_000
        ? Math.floor(snapshot.completedAt / 1000)
        : snapshot.completedAt
      : null;
  const durationMs =
    snapshot.durationMs !== undefined
      ? snapshot.durationMs
      : snapshot.startedAt !== undefined && snapshot.completedAt !== undefined
        ? Math.max(
            0,
            (snapshot.completedAt > 10_000_000_000
              ? snapshot.completedAt
              : snapshot.completedAt * 1000) -
              (snapshot.startedAt > 10_000_000_000
                ? snapshot.startedAt
                : snapshot.startedAt * 1000),
          )
        : null;
  return {
    id: turnId,
    status: historicalStatus(snapshot.outcome),
    items: [
      {
        id: `${turnId}-user`,
        type: "userMessage",
        clientId: null,
        content: snapshot.input.map(({ text }) => ({ type: "text", text })),
      },
      ...snapshot.items.flatMap(({ item, outcome }) => {
        if (item.type === "toolExecution") {
          if (isTodoTool(item.toolName) || todoPlanFromTool(item.toolName, item.arguments))
            return [];
          const changes = fileChangeFromTool(item.toolName, item.arguments);
          if (changes) {
            return [
              projectItem(
                { type: "fileChange", itemId: item.itemId, changes },
                outcome,
                cwd,
                true,
                "",
              ),
            ];
          }
          if (isFileMutatingTool(item.toolName)) return [];
        }
        if (
          item.type === "commandExecution" &&
          item.processId &&
          item.exitCode === undefined &&
          outcome.status === "succeeded"
        ) {
          return [projectItem(item, null, cwd, true, "")];
        }
        return item.type === "reasoning"
          ? [
              projectItem(item, outcome, cwd, true, ""),
              projectReasoningTranscriptItem(item, outcome, cwd),
            ]
          : [projectItem(item, outcome, cwd, true, "")];
      }),
    ],
    error,
    startedAt,
    completedAt,
    durationMs,
    itemsView: "full",
  };
}

function applyUpdate(item: HostItem, update: HostItemUpdate): HostItem {
  if (
    (item.type === "agentMessage" || item.type === "reasoning") &&
    update.type === "text.append"
  ) {
    return { ...item, text: item.text + update.text };
  }
  if (item.type === "commandExecution" && update.type === "output.append") {
    return { ...item, output: (item.output ?? "") + update.text };
  }
  if (item.type === "toolExecution" && update.type === "output.replace") {
    return { ...item, output: update.output };
  }
  if (item.type === "fileChange" && update.type === "fileChanges.replace") {
    return { ...item, changes: update.changes };
  }
  if (item.type === "subagentDelegation" && update.type === "subagents.replace") {
    return { ...item, subagents: update.subagents };
  }
  throw new Error(`Host Item '${item.type}' cannot apply update '${update.type}'`);
}

function diffText(changes: HostFileChange[]): string {
  return changes.map(({ unifiedDiff }) => unifiedDiff).join("\n");
}

export class CodexTurnProjector {
  readonly #cwd: string;
  readonly #input: HostTurnSnapshot["input"];
  readonly #interactions = new Map<HostInteractionId, ProjectedInteraction>();
  readonly #items = new Map<HostItemId, ProjectedItem>();
  readonly #itemOrder: HostItemId[] = [];
  readonly #wireItemOrder: HostItemId[] = [];
  readonly #startedAt: number;
  readonly #startedAtMs: number;
  readonly #threadId: string;
  readonly #turnId: HostTurnId;
  #completed = false;
  #started = false;

  constructor(input: {
    threadId: string;
    turnId: HostTurnId;
    cwd: string;
    startedAtMs: number;
    initialInput?: HostTurnSnapshot["input"];
  }) {
    this.#threadId = input.threadId;
    this.#turnId = input.turnId;
    this.#cwd = input.cwd;
    this.#input = input.initialInput ?? [];
    this.#startedAtMs = input.startedAtMs;
    this.#startedAt = Math.floor(input.startedAtMs / 1000);
  }

  pendingTurn(startedAt: number | null = null): JsonObject {
    return {
      id: this.#turnId,
      status: "inProgress",
      items: [
        ...this.#projectInput(),
        ...this.#wireItemOrder.flatMap((itemId) => {
          const projected = this.#items.get(itemId);
          if (!projected?.wireStarted) return [];
          if (projected.item.type === "agentMessage") {
            return [projectItem(projected.item, projected.outcome, this.#cwd)];
          }
          if (liveProcessId(projected.item)) {
            return [projectItem(projected.item, projected.outcome, this.#cwd)];
          }
          const fileItem = wireFileChangeItem(projected);
          return fileItem ? [projectItem(fileItem, projected.outcome, this.#cwd)] : [];
        }),
      ],
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
      itemsView: "full",
    };
  }

  project(event: ProjectableHostEvent, emittedAtMs = Date.now()): CodexTurnProjection {
    if (event.turnId !== this.#turnId) {
      throw new Error("Host output references another Turn");
    }
    if (this.#completed) throw new Error("Host output follows the Turn terminal event");
    switch (event.type) {
      case "turn.started":
        return this.#startTurn();
      case "item.started":
        return this.#startItem(event, emittedAtMs);
      case "item.updated":
        return this.#updateItem(event, emittedAtMs);
      case "item.completed":
        return this.#completeItem(event, emittedAtMs);
      case "interaction.closed":
        return this.#closeInteraction(event, emittedAtMs);
      case "turn.completed":
        return this.#completeTurn(event, emittedAtMs);
    }
  }

  projectApproval(
    interaction: HostApprovalInteraction,
    serverName: string,
  ): CodexApprovalProjection {
    if (interaction.turnId !== this.#turnId) {
      throw new Error("Host Interaction references another Turn");
    }
    this.#requireStarted();
    if (this.#completed) throw new Error("Host Interaction follows the Turn terminal event");
    if (this.#interactions.has(interaction.interactionId)) {
      throw new Error("Host Interaction opened more than once");
    }
    const approvalRequest = projectCodexApprovalRequest({
      threadId: this.#threadId,
      interaction,
      serverName,
    });
    this.#interactions.set(interaction.interactionId, { type: "approval" });
    return { messages: [], approvalRequest };
  }

  projectQuestion(
    interaction: HostQuestionInteraction,
    syntheticItemId: HostItemId,
    emittedAtMs = Date.now(),
  ): CodexQuestionProjection {
    if (interaction.turnId !== this.#turnId) {
      throw new Error("Host Interaction references another Turn");
    }
    this.#requireStarted();
    if (this.#completed) throw new Error("Host Interaction follows the Turn terminal event");
    if (this.#interactions.has(interaction.interactionId)) {
      throw new Error("Host Interaction opened more than once");
    }

    const messages: JsonObject[] = [];
    const itemId = interaction.itemId ?? syntheticItemId;
    const syntheticItem = interaction.itemId === undefined;
    if (!syntheticItem) {
      const item = this.#activeItem(itemId).item;
      if (item.type !== "toolExecution") {
        throw new Error("Host Question Item must be an active Generic Tool");
      }
    }
    const questionRequest = projectCodexQuestionRequest({
      threadId: this.#threadId,
      interaction,
      itemId,
      emittedAtMs,
    });
    if (syntheticItem) {
      const item: HostItem = {
        type: "toolExecution",
        itemId,
        namespace: "codexhost",
        toolName: "question",
        arguments: {},
      };
      messages.push(
        ...this.#startItem({ type: "item.started", turnId: this.#turnId, item }, emittedAtMs)
          .messages,
      );
    }
    this.#interactions.set(interaction.interactionId, {
      type: "question",
      itemId,
      syntheticItem,
    });
    return { messages, itemId, questionRequest };
  }

  #startTurn(): CodexTurnProjection {
    if (this.#started) throw new Error("Host Turn started more than once");
    this.#started = true;
    return {
      messages: [
        {
          method: "turn/started",
          emittedAtMs: this.#startedAtMs,
          params: {
            threadId: this.#threadId,
            turn: this.pendingTurn(this.#startedAt),
          },
        },
      ],
    };
  }

  #startItem(event: ItemStartedEvent, startedAtMs: number): CodexTurnProjection {
    this.#requireStarted();
    if (this.#items.has(event.item.itemId)) throw new Error("Host Item started more than once");
    const projected: ProjectedItem = {
      item: event.item,
      outcome: null,
      reasoningPartStarted: false,
      streamedCommandOutput: false,
      wireStarted: false,
      wireFileChanges: null,
      startedAtMs,
    };
    this.#items.set(event.item.itemId, projected);
    this.#itemOrder.push(event.item.itemId);
    if (
      (event.item.type === "agentMessage" || event.item.type === "reasoning") &&
      event.item.text.length === 0
    ) {
      // An empty Reasoning Item would surface as a transcript card with no
      // content, so defer the wire Item until real summary text arrives.
      return { messages: [] };
    }
    if (event.item.type === "toolExecution") {
      if (isTodoTool(event.item.toolName)) {
        const plan = planFromTodoValue(event.item.arguments);
        return { messages: plan ? [this.#planUpdated(plan)] : [] };
      }
      const changes = fileChangeFromTool(event.item.toolName, event.item.arguments);
      if (changes) {
        projected.wireFileChanges = changes;
        const fileItem = {
          type: "fileChange" as const,
          itemId: event.item.itemId,
          changes,
        };
        return {
          messages: [
            this.#startWireItem(projected, fileItem, startedAtMs),
            ...this.#fileChangeUpdates(event.item.itemId, changes),
          ],
        };
      }
      if (isFileMutatingTool(event.item.toolName)) return { messages: [] };
    }
    const startedItem = event.item.type === "reasoning" ? { ...event.item, text: "" } : event.item;
    const messages = [this.#startWireItem(projected, startedItem, startedAtMs)];
    if (event.item.type === "reasoning") {
      messages.push(...this.#reasoningDelta(projected, event.item.text, startedAtMs));
    }
    if (event.item.type === "fileChange") {
      messages.push(...this.#fileChangeUpdates(event.item.itemId, event.item.changes));
    }
    return { messages };
  }

  #updateItem(event: ItemUpdatedEvent, emittedAtMs: number): CodexTurnProjection {
    const projected = this.#activeItem(event.itemId);
    const previous = projected.item;
    const next = applyUpdate(previous, event.update);
    projected.item = next;
    const messages: JsonObject[] = [];
    if (event.update.type === "text.append") {
      if (event.update.text.length === 0) return { messages };
      if (next.type === "agentMessage") {
        if (!projected.wireStarted) {
          messages.push(this.#startWireItem(projected, previous, emittedAtMs));
        }
        messages.push({
          method: "item/agentMessage/delta",
          emittedAtMs,
          params: {
            threadId: this.#threadId,
            turnId: this.#turnId,
            itemId: event.itemId,
            delta: event.update.text,
          },
        });
      } else if (next.type === "reasoning") {
        if (!projected.wireStarted) {
          messages.push(this.#startWireItem(projected, { ...next, text: "" }, emittedAtMs));
        }
        messages.push(...this.#reasoningDelta(projected, event.update.text, emittedAtMs));
      }
    } else if (event.update.type === "output.append") {
      projected.streamedCommandOutput = true;
      messages.push({
        method: "item/commandExecution/outputDelta",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId: event.itemId,
          delta: event.update.text,
        },
      });
      const processId = liveProcessId(next);
      if (processId) {
        messages.push({
          method: "process/outputDelta",
          emittedAtMs,
          params: {
            processId,
            stream: "stdout",
            deltaBase64: Buffer.from(event.update.text, "utf8").toString("base64"),
            capReached: false,
          },
        });
      }
    } else if (event.update.type === "output.replace") {
      if (next.type === "commandExecution") {
        const text = next.output ?? "";
        const previousText = previous.type === "commandExecution" ? (previous.output ?? "") : "";
        const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
        if (delta.length > 0) {
          projected.streamedCommandOutput = true;
          messages.push({
            method: "item/commandExecution/outputDelta",
            emittedAtMs,
            params: {
              threadId: this.#threadId,
              turnId: this.#turnId,
              itemId: event.itemId,
              delta,
            },
          });
          const processId = wireProcessId(next);
          if (processId) {
            messages.push({
              method: "process/outputDelta",
              emittedAtMs,
              params: {
                processId,
                stream: "stdout",
                deltaBase64: Buffer.from(delta, "utf8").toString("base64"),
                capReached: false,
              },
            });
          }
        }
      } else if (next.type === "toolExecution" && toolCommandLine(next.toolName, next.arguments)) {
        const text = toolOutputText(next);
        if (text) {
          const previousText =
            previous.type === "toolExecution" ? (toolOutputText(previous) ?? "") : "";
          const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
          if (delta.length > 0) {
            projected.streamedCommandOutput = true;
            messages.push({
              method: "item/commandExecution/outputDelta",
              emittedAtMs,
              params: {
                threadId: this.#threadId,
                turnId: this.#turnId,
                itemId: event.itemId,
                delta,
              },
            });
            const processId = processIdFromCommand(toolCommandLine(next.toolName, next.arguments));
            if (processId) {
              messages.push({
                method: "process/outputDelta",
                emittedAtMs,
                params: {
                  processId,
                  stream: "stdout",
                  deltaBase64: Buffer.from(delta, "utf8").toString("base64"),
                  capReached: false,
                },
              });
            }
          }
        }
      }
    } else if (event.update.type === "fileChanges.replace") {
      messages.push(...this.#fileChangeUpdates(event.itemId, event.update.changes));
    } else if (event.update.type === "subagents.replace") {
      messages.push({
        method: "item/started",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          startedAtMs: projected.startedAtMs ?? emittedAtMs,
          item: projectItem(next, null, this.#cwd, true, this.#threadId),
        },
      });
    }
    return { messages };
  }

  #completeItem(event: ItemCompletedEvent, emittedAtMs: number): CodexTurnProjection {
    if (
      [...this.#interactions.values()].some(
        (interaction) =>
          interaction.type === "question" && interaction.itemId === event.snapshot.item.itemId,
      )
    ) {
      throw new Error("Host Item completed with a pending Interaction");
    }
    const projected = this.#activeItem(event.snapshot.item.itemId);
    if (event.snapshot.item.type !== projected.item.type) {
      throw new Error("Host Item changed type before completion");
    }
    if (projected.item.type === "agentMessage" || projected.item.type === "reasoning") {
      const completedItem = event.snapshot.item;
      if (
        (completedItem.type !== "agentMessage" && completedItem.type !== "reasoning") ||
        completedItem.text !== projected.item.text
      ) {
        throw new Error("Host textual Item completion does not match its append updates");
      }
    }
    projected.item = event.snapshot.item;
    const keepRunning =
      Boolean(liveProcessId(projected.item)) && event.snapshot.outcome.status === "succeeded";
    if (keepRunning) {
      projected.outcome = null;
      return { messages: [] };
    }
    projected.outcome = event.snapshot.outcome;
    const startedAtMs = projected.startedAtMs;
    if (startedAtMs === undefined) throw new Error("Codex Item completed without a start time");
    const durationMs = resolvedItemDurationMs(projected.item, startedAtMs, emittedAtMs);
    projected.item = withResolvedDuration(projected.item, durationMs);
    projected.durationMs = durationMs;

    const completedItem = (item: JsonObject): JsonObject => ({
      method: "item/completed",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        startedAtMs,
        completedAtMs: emittedAtMs,
        item,
      },
    });
    if (!projected.wireStarted) {
      if (projected.item.type === "toolExecution") {
        if (isTodoTool(projected.item.toolName)) {
          const plan =
            planFromTodoValue(projected.item.arguments) ?? planFromTodoValue(projected.item.output);
          return { messages: plan ? [this.#planUpdated(plan, emittedAtMs)] : [] };
        }
        const changes = fileChangeFromTool(projected.item.toolName, projected.item.arguments);
        if (changes) {
          projected.wireFileChanges = changes;
          const fileItem = {
            type: "fileChange" as const,
            itemId: projected.item.itemId,
            changes,
          };
          return {
            messages: [
              this.#startWireItem(projected, fileItem, startedAtMs),
              ...this.#fileChangeUpdates(projected.item.itemId, changes),
              completedItem(
                projectItem(fileItem, projected.outcome, this.#cwd, true, this.#threadId),
              ),
            ],
          };
        }
      }
      return { messages: [] };
    }
    const fileItem = wireFileChangeItem(projected);
    const messages = [
      completedItem(
        projectItem(
          fileItem ?? projected.item,
          projected.outcome,
          this.#cwd,
          !projected.streamedCommandOutput,
          this.#threadId,
        ),
      ),
    ];

    return { messages };
  }

  #closeInteraction(event: InteractionClosedEvent, emittedAtMs: number): CodexTurnProjection {
    const interaction = this.#interactions.get(event.interactionId);
    if (!interaction) throw new Error("Host output closes an unknown Interaction");
    this.#interactions.delete(event.interactionId);
    if (interaction.type === "approval" || !interaction.syntheticItem) return { messages: [] };
    const projected = this.#activeItem(interaction.itemId);
    return this.#completeItem(
      {
        type: "item.completed",
        turnId: this.#turnId,
        snapshot: {
          item: projected.item,
          outcome:
            event.reason === "responded"
              ? { status: "succeeded" }
              : { status: "cancelled", reason: `Question ${event.reason}` },
        },
      },
      emittedAtMs,
    );
  }

  #completeTurn(event: TurnCompletedEvent, completedAtMs: number): CodexTurnProjection {
    this.#requireStarted();
    if (this.#interactions.size > 0) {
      throw new Error("Host Turn completed with pending Interactions");
    }
    const active = [...this.#items.values()].filter(
      ({ item, outcome }) => outcome === null && !liveProcessId(item),
    );
    if (active.length > 0) throw new Error("Host Turn completed with active Items");
    this.#completed = true;
    const completedAt = Math.floor(completedAtMs / 1000);
    const error = turnError(event.outcome);
    const turn: JsonObject = {
      id: this.#turnId,
      status: turnStatus(event.outcome),
      // Current Codex sends Tool/File Change state through Item notifications only.
      items: [
        ...this.#projectInput(),
        ...this.#wireItemOrder.flatMap((itemId) => {
          const projected = this.#items.get(itemId);
          if (!projected?.wireStarted) return [];
          if (!projected.outcome && liveProcessId(projected.item)) {
            return [projectItem(projected.item, null, this.#cwd)];
          }
          if (!projected.outcome) throw new Error("Host Turn contains an incomplete Item");
          if (projected.item.type === "reasoning") {
            return [projectItem(projected.item, projected.outcome, this.#cwd)];
          }
          if (projected.item.type === "agentMessage") {
            return [projectItem(projected.item, projected.outcome, this.#cwd)];
          }
          const fileItem = wireFileChangeItem(projected);
          return fileItem ? [projectItem(fileItem, projected.outcome, this.#cwd)] : [];
        }),
      ],
      error,
      startedAt: this.#startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - this.#startedAtMs),
      itemsView: "full",
    };
    return {
      completedTurn: turn,
      messages: [
        ...(error
          ? [
              {
                method: "error",
                params: {
                  error,
                  willRetry: false,
                  threadId: this.#threadId,
                  turnId: this.#turnId,
                },
              },
            ]
          : []),
        {
          method: "turn/completed",
          emittedAtMs: completedAtMs,
          params: { threadId: this.#threadId, turn },
        },
      ],
    };
  }

  #projectInput(): JsonObject[] {
    return this.#input.length === 0
      ? []
      : [
          {
            id: `${this.#turnId}-user`,
            type: "userMessage",
            clientId: null,
            content: this.#input.map(({ text }) => ({ type: "text", text })),
          },
        ];
  }

  #startWireItem(projected: ProjectedItem, item: HostItem, startedAtMs: number): JsonObject {
    if (projected.wireStarted) throw new Error("Codex Item started more than once");
    projected.wireStarted = true;
    projected.startedAtMs = startedAtMs;
    this.#wireItemOrder.push(item.itemId);
    return {
      method: "item/started",
      emittedAtMs: startedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        startedAtMs,
        item: projectItem(item, null, this.#cwd, true, this.#threadId),
      },
    };
  }

  #reasoningDelta(projected: ProjectedItem, delta: string, emittedAtMs: number): JsonObject[] {
    if (projected.item.type !== "reasoning" || !projected.wireStarted) {
      throw new Error("Host Reasoning update precedes its Item start");
    }
    const messages: JsonObject[] = [];
    if (!projected.reasoningPartStarted) {
      projected.reasoningPartStarted = true;
      messages.push({
        method: "item/reasoning/summaryPartAdded",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId: reasoningPreviewItemId(projected.item.itemId),
          summaryIndex: 0,
        },
      });
    }
    messages.push({
      method: "item/reasoning/summaryTextDelta",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        itemId: reasoningPreviewItemId(projected.item.itemId),
        delta,
        summaryIndex: 0,
      },
    });
    return messages;
  }

  #planUpdated(
    plan: {
      explanation: string | null;
      plan: { step: string; status: "pending" | "inProgress" | "completed" }[];
    },
    emittedAtMs = this.#startedAtMs,
  ): JsonObject {
    return {
      method: "turn/plan/updated",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        explanation: plan.explanation,
        plan: plan.plan,
      },
    };
  }

  #fileChangeUpdates(itemId: HostItemId, changes: HostFileChange[]): JsonObject[] {
    const projectedChanges = projectFileChanges(changes);
    return [
      {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId,
          changes: projectedChanges,
        },
      },
      {
        method: "turn/diff/updated",
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          diff: diffText(this.#allFileChanges()),
        },
      },
    ];
  }

  #allFileChanges(): HostFileChange[] {
    return this.#itemOrder.flatMap((itemId) => {
      const projected = this.#items.get(itemId);
      if (!projected) return [];
      if (projected.item.type === "fileChange") return projected.item.changes;
      return projected.wireFileChanges ?? [];
    });
  }

  #activeItem(itemId: HostItemId): ProjectedItem {
    const projected = this.#items.get(itemId);
    if (!projected) throw new Error("Host output references an unknown Item");
    if (projected.outcome) throw new Error("Host output follows the Item terminal event");
    return projected;
  }

  #requireStarted(): void {
    if (!this.#started) throw new Error("Host Item or terminal output precedes turn.started");
  }
}
