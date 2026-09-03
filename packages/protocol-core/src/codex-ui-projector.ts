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
  projectCodexApprovalRequest,
  type CodexApprovalRequestProjection,
} from "./codex-approval.js";
import {
  projectCodexQuestionRequest,
  type CodexQuestionRequestProjection,
} from "./codex-question.js";

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
  wireItemType?: string;
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

function parseJsonIfString(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function nestedString(value: unknown, keys: readonly string[]): string | undefined {
  const unwrapped = parseJsonIfString(value);
  if (!isRecord(unwrapped)) return undefined;
  for (const key of keys) {
    const field = unwrapped[key];
    if (typeof field === "string" && field.trim().length > 0) return field.trim();
  }
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    const nested = nestedString(unwrapped[wrapper], keys);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function nestedRawString(value: unknown, keys: readonly string[]): string | undefined {
  const unwrapped = parseJsonIfString(value);
  if (!isRecord(unwrapped)) return undefined;
  for (const key of keys) {
    const field = unwrapped[key];
    if (typeof field === "string") return field;
  }
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    const nested = nestedRawString(unwrapped[wrapper], keys);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function extractBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
  const unwrapped = parseJsonIfString(value);
  if (!isRecord(unwrapped)) return undefined;
  for (const key of keys) {
    const val = unwrapped[key];
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
  }
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    const nested = extractBoolean(unwrapped[wrapper], keys);
    if (nested !== undefined) return nested;
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

/**
 * Codex Desktop only renders a detailed, expandable card for Command Execution.
 * Generic `dynamicToolCall` items show the tool name with no path, pattern, or
 * output. Lift Read/Glob/Grep/shell tools into that lane when a command line
 * can be reconstructed from the native arguments.
 */
export function toolCommandLine(toolName: string, args: JsonValue): string | undefined {
  const lower = compactToolName(toolName);
  const command = nestedString(args, [
    "command",
    "cmd",
    "script",
    "commandLine",
    "command_line",
    "CommandLine",
  ]);
  if (
    ["bash", "exec", "terminal", "run", "shell", "powershell", "command", "runcommand"].includes(
      lower,
    )
  ) {
    return command || "run";
  }
  const filePath = nestedString(args, [
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target",
    "uri",
    "TargetFile",
    "targetFile",
    "target_file",
    "AbsolutePath",
    "absolutePath",
    "absolute_path",
    "DirectoryPath",
    "directoryPath",
    "directory_path",
    "SearchPath",
    "searchPath",
    "search_path",
    "SearchDirectory",
    "searchDirectory",
    "search_directory",
  ]);
  const pattern = nestedString(args, [
    "pattern",
    "glob",
    "glob_pattern",
    "query",
    "regex",
    "Pattern",
    "Query",
  ]);
  const url = nestedString(args, ["url", "uri", "Url", "href"]);
  if (["read", "readfile", "fileread", "view", "viewfile"].includes(lower)) {
    return filePath ? `read ${filePath}` : "read";
  }
  if (["readurlcontent", "fetch", "fetchurl", "curl", "download"].includes(lower)) {
    return url ? `fetch ${url}` : filePath ? `read ${filePath}` : "fetch";
  }
  if (["listdir", "ls", "dir", "listdirectory"].includes(lower)) {
    return filePath ? `ls ${filePath}` : "ls";
  }
  if (["glob", "find", "findfiles", "findbyname"].includes(lower)) {
    const target = pattern ?? filePath;
    return target ? `glob ${target}` : "glob";
  }
  if (["grep", "grepsearch"].includes(lower)) {
    return pattern
      ? filePath
        ? `grep ${pattern} ${filePath}`
        : `grep ${pattern}`
      : filePath
        ? `grep ${filePath}`
        : "grep";
  }
  if (["websearch", "searchweb", "search"].includes(lower)) {
    return pattern ? `search ${pattern}` : "search";
  }
  return undefined;
}

function compactToolName(toolName: string): string {
  const baseName = toolName.includes(":")
    ? toolName.slice(toolName.lastIndexOf(":") + 1)
    : toolName.includes(".")
      ? toolName.slice(toolName.lastIndexOf(".") + 1)
      : toolName;
  return baseName.toLowerCase().replaceAll(/[_-]/g, "");
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
    "writetofile",
    "replacefilecontent",
  ].includes(compactToolName(toolName));
}

function isWriteTool(toolName: string): boolean {
  return ["write", "writefile", "filewrite", "create", "createfile", "writetofile"].includes(
    compactToolName(toolName),
  );
}

function formatHunkRange(start: number, count: number): string {
  if (count === 1) return `${start}`;
  return `${start},${count}`;
}

export function ensureGitDiffHeader(filePath: string, unifiedDiff: string): string {
  const trimmed = unifiedDiff.trim();
  if (!trimmed) return unifiedDiff;
  if (trimmed.startsWith("diff --git")) return unifiedDiff;
  const normalized = filePath.replaceAll("\\", "/");
  const isAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  const aPath = isAbsolute ? normalized : `a/${normalized}`;
  const bPath = isAbsolute ? normalized : `b/${normalized}`;
  return `diff --git ${aPath} ${bPath}\n${unifiedDiff}`;
}

function simpleUnifiedDiff(
  displayedPath: string,
  oldText: string,
  newText: string,
  kind: "add" | "update",
): string {
  const normalized = displayedPath.replaceAll("\\", "/");
  const isAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
  const aPath = isAbsolute ? normalized : `a/${normalized}`;
  const bPath = isAbsolute ? normalized : `b/${normalized}`;
  const gitHeader = `diff --git ${aPath} ${bPath}`;
  const oldLines = oldText === "" ? [] : oldText.replaceAll("\r\n", "\n").split("\n");
  const newLines = newText === "" ? [] : newText.replaceAll("\r\n", "\n").split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();
  const oldHeader = kind === "add" ? "/dev/null" : aPath;
  const newHeader = bPath;
  const oldRange =
    kind === "add" ? "0,0" : oldLines.length === 0 ? "0,0" : formatHunkRange(1, oldLines.length);
  const newRange = newLines.length === 0 ? "0,0" : formatHunkRange(1, newLines.length);
  return [
    gitHeader,
    `--- ${oldHeader}`,
    `+++ ${newHeader}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

export function normalizeDisplayPath(filePath: string, cwd?: string): string | null {
  if (
    typeof filePath !== "string" ||
    filePath.trim().length === 0 ||
    filePath.includes("\0") ||
    filePath.includes("\n") ||
    filePath.includes("\r")
  ) {
    return null;
  }
  const normalizedFile = filePath.trim().replaceAll("\\", "/");
  if (!cwd) return normalizedFile.replace(/^\.\//, "");
  const normalizedCwd = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedCwd.length === 0) return normalizedFile.replace(/^\.\//, "");

  if (
    normalizedFile.toLowerCase() === normalizedCwd.toLowerCase() ||
    normalizedFile === "."
  ) {
    return null;
  }

  const cwdPrefix = normalizedCwd.toLowerCase() + "/";
  if (normalizedFile.toLowerCase().startsWith(cwdPrefix)) {
    const rel = normalizedFile.slice(cwdPrefix.length);
    return rel.length > 0 ? rel : null;
  }

  const isAbsolute =
    normalizedFile.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedFile);
  if (!isAbsolute) {
    return normalizedFile.replace(/^\.\//, "");
  }

  return normalizedFile;
}

export function fileChangeFromTool(
  toolName: string,
  args: JsonValue,
  cwd?: string,
): HostFileChange[] | null {
  if (!isFileMutatingTool(toolName)) return null;
  const rawPath = nestedString(args, [
    "path",
    "file_path",
    "filePath",
    "file",
    "TargetFile",
    "targetFile",
    "target_file",
    "AbsolutePath",
    "absolutePath",
    "absolute_path",
  ]);
  if (!rawPath) return null;
  const displayedPath = normalizeDisplayPath(rawPath, cwd);
  if (!displayedPath) return null;
  if (isWriteTool(toolName)) {
    const rawContent = nestedRawString(args, [
      "content",
      "new_string",
      "newString",
      "newText",
      "file_text",
      "text",
      "new",
      "CodeContent",
      "codeContent",
      "code_content",
    ]);
    // Do not turn a partial tool envelope into an empty diff. An explicit
    // empty string remains a valid empty-file creation.
    if (rawContent === undefined) return null;
    const content = rawContent;
    const overwrite = extractBoolean(args, ["Overwrite", "overwrite", "overWrite"]) ?? false;
    const kind = overwrite ? "update" : "add";
    return [
      {
        path: displayedPath,
        kind,
        unifiedDiff: simpleUnifiedDiff(displayedPath, "", content, kind),
      },
    ];
  }
  // ponytail: Antigravity CodeEdit omits old text; report additions only until native patch metadata exists.
  const oldText =
    nestedRawString(args, [
      "old_string",
      "oldString",
      "oldText",
      "old_text",
      "old",
      "TargetContent",
      "targetContent",
      "target_content",
    ]) ?? "";
  const rawNewText = nestedRawString(args, [
    "new_string",
    "newString",
    "newText",
    "new_text",
    "content",
    "new",
    "ReplacementContent",
    "replacementContent",
    "replacement_content",
    "CodeEdit",
  ]);
  if (rawNewText === undefined) return null;
  const newText = rawNewText;
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
    diff: ensureGitDiffHeader(path, unifiedDiff),
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

function projectItem(
  item: HostItem,
  outcome: HostItemOutcome | null,
  defaultCwd: string,
  includeCommandOutput = true,
  senderThreadId?: string,
  forcedWireType?: string,
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
    case "commandExecution":
      return {
        id: item.itemId,
        type: "commandExecution",
        command: item.command,
        cwd: item.cwd ?? defaultCwd,
        processId: null,
        source: "agent",
        status: itemStatus(outcome),
        commandActions: [],
        aggregatedOutput: includeCommandOutput ? (item.output ?? null) : null,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
      };
    case "toolExecution": {
      if (forcedWireType === "dynamicToolCall") {
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
      const command = toolCommandLine(item.toolName, item.arguments);
      if (command || forcedWireType === "commandExecution") {
        return {
          id: item.itemId,
          type: "commandExecution",
          command: command ?? item.toolName,
          cwd: defaultCwd,
          processId: null,
          source: "agent",
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
    case "subagentDelegation":
      return {
        id: item.itemId,
        type: "collabAgentToolCall",
        tool: item.operation === "spawn" ? "spawnAgent" : "sendInput",
        status: itemStatus(outcome),
        senderThreadId: senderThreadId ?? "",
        receiverThreadIds: item.subagents.map(({ subagentId }) => subagentId),
        prompt: item.prompt ?? null,
        model: null,
        reasoningEffort: null,
        agentsStates: Object.fromEntries(
          item.subagents.map(({ subagentId, status, resultSummary }) => [
            subagentId,
            { status: collabAgentStatus(status), message: resultSummary ?? null },
          ]),
        ),
      };
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
  return {
    id: turnId,
    status: historicalStatus(snapshot.outcome),
    items: [
      {
        id: `${turnId}-user`,
        type: "userMessage",
        clientId: null,
        content: snapshot.input.map(({ text }) => ({ type: "text", text, text_elements: [] })),
      },
      ...snapshot.items.flatMap(({ item, outcome }) => {
        if (item.type === "toolExecution") {
          if (isTodoTool(item.toolName) || todoPlanFromTool(item.toolName, item.arguments))
            return [];
          const changes = fileChangeFromTool(item.toolName, item.arguments, cwd);
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
        return item.type === "reasoning"
          ? [
              projectItem(item, outcome, cwd, true, ""),
              projectReasoningTranscriptItem(item, outcome, cwd),
            ]
          : [projectItem(item, outcome, cwd, true, "")];
      }),
    ],
    error,
    startedAt: null,
    completedAt: null,
    durationMs: null,
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
  if (item.type === "commandExecution" && update.type === "output.replace") {
    const text =
      typeof update.output === "string"
        ? update.output
        : (toolOutputText({
            type: "toolExecution",
            itemId: item.itemId,
            toolName: "",
            arguments: null,
            output: update.output,
          }) ?? "");
    return { ...item, output: text };
  }
  if (item.type === "toolExecution" && update.type === "output.replace") {
    return { ...item, output: update.output };
  }
  if (item.type === "toolExecution" && update.type === "output.append") {
    const current = toolOutputText(item) ?? "";
    return {
      ...item,
      output: { content: [{ type: "text", text: current + update.text }] },
    };
  }
  if (item.type === "fileChange" && update.type === "fileChanges.replace") {
    return { ...item, changes: update.changes };
  }
  if (
    item.type === "fileChange" &&
    (update.type === "output.append" || update.type === "output.replace")
  ) {
    return item;
  }
  if (item.type === "subagentDelegation" && update.type === "subagents.replace") {
    return { ...item, subagents: update.subagents };
  }
  throw new Error(`Host Item '${item.type}' cannot apply update '${update.type}'`);
}

function diffText(changes: HostFileChange[]): string {
  return changes
    .map(({ path, unifiedDiff }) => ensureGitDiffHeader(path, unifiedDiff).trimEnd())
    .filter((diff) => diff.length > 0)
    .map((diff) => `${diff}\n`)
    .join("");
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
      const changes = fileChangeFromTool(event.item.toolName, event.item.arguments, this.#cwd);
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
      messages.push(
        this.#startReasoningTranscript(event.item, startedAtMs),
        this.#reasoningOutputDelta(event.item.itemId, event.item.text, startedAtMs),
        ...this.#reasoningDelta(projected, event.item.text, startedAtMs),
      );
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
          messages.push(
            this.#startWireItem(projected, { ...next, text: "" }, emittedAtMs),
            this.#startReasoningTranscript({ ...next, text: "" }, emittedAtMs),
          );
        }
        messages.push(
          this.#reasoningOutputDelta(event.itemId, event.update.text, emittedAtMs),
          ...this.#reasoningDelta(projected, event.update.text, emittedAtMs),
        );
      }
    } else if (event.update.type === "output.append") {
      const command =
        next.type === "commandExecution"
          ? next.command
          : next.type === "toolExecution"
            ? toolCommandLine(next.toolName, next.arguments)
            : undefined;
      if (command || projected.wireItemType === "commandExecution") {
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
      }
    } else if (event.update.type === "output.replace") {
      const command =
        next.type === "commandExecution"
          ? next.command
          : next.type === "toolExecution"
            ? toolCommandLine(next.toolName, next.arguments)
            : undefined;
      if (command || projected.wireItemType === "commandExecution") {
        const text =
          next.type === "commandExecution"
            ? (next.output ?? "")
            : next.type === "toolExecution"
              ? (toolOutputText(next) ?? "")
              : "";
        if (text) {
          const previousText =
            previous.type === "commandExecution"
              ? (previous.output ?? "")
              : previous.type === "toolExecution"
                ? (toolOutputText(previous) ?? "")
                : "";
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
        const changes = fileChangeFromTool(
          projected.item.toolName,
          projected.item.arguments,
          this.#cwd,
        );
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
          projected.wireItemType,
        ),
      ),
    ];
    if (projected.item.type === "reasoning") {
      const reasoning = projected.item;
      messages.push(
        completedItem(
          projectReasoningTranscriptItem(reasoning, projected.outcome, this.#cwd, durationMs),
        ),
      );
    }
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
    const active = [...this.#items.values()].filter(({ outcome }) => outcome === null);
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
          if (!projected?.outcome) throw new Error("Host Turn contains an incomplete Item");
          if (!projected.wireStarted) return [];
          if (projected.item.type === "reasoning") {
            const reasoning = projected.item;
            return [
              projectItem(reasoning, projected.outcome, this.#cwd),
              projectReasoningTranscriptItem(
                reasoning,
                projected.outcome,
                this.#cwd,
                projected.durationMs ?? null,
              ),
            ];
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
            content: this.#input.map(({ text }) => ({ type: "text", text, text_elements: [] })),
          },
        ];
  }

  #startWireItem(projected: ProjectedItem, item: HostItem, startedAtMs: number): JsonObject {
    if (projected.wireStarted) throw new Error("Codex Item started more than once");
    projected.wireStarted = true;
    projected.startedAtMs = startedAtMs;
    this.#wireItemOrder.push(item.itemId);
    const wireItem = projectItem(item, null, this.#cwd, true, this.#threadId);
    projected.wireItemType = wireItem.type as string;
    return {
      method: "item/started",
      emittedAtMs: startedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        startedAtMs,
        item: wireItem,
      },
    };
  }

  #startReasoningTranscript(
    item: Extract<HostItem, { type: "reasoning" }>,
    startedAtMs: number,
  ): JsonObject {
    return {
      method: "item/started",
      emittedAtMs: startedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        startedAtMs,
        item: projectReasoningTranscriptItem({ ...item, text: "" }, null, this.#cwd),
      },
    };
  }

  #reasoningOutputDelta(itemId: HostItemId, delta: string, emittedAtMs: number): JsonObject {
    return {
      method: "item/commandExecution/outputDelta",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        itemId,
        delta,
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
