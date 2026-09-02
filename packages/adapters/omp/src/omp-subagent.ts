import type { HostSubagentStatus } from "@codexhost/harness-adapter";

const SPAWN_TOOL_NAMES = new Set([
  "task",
  "tasks",
  "task_agent",
  "agent",
  "agents",
  "subagent",
  "subagents",
  "spawn_subagent",
  "spawn_agent",
  "spawn",
  "delegate",
  "delegation",
]);
const PROCESS_TOOL_NAMES = new Set([
  "spawn_process",
  "start_process",
  "process",
  "terminal",
  "spawn_terminal",
  "start_terminal",
  "terminal_session",
  "background_terminal",
  "background_task",
]);
const SEND_TOOL_NAMES = new Set(["send_subagent_message", "send_message", "send_agent_message"]);
const WAIT_TOOL_NAMES = new Set(["wait_tasks", "get_task_output", "get_subagent_output"]);
const KILL_TOOL_NAMES = new Set(["kill_task", "kill_subagent", "kill_process", "stop_process"]);

const DESCRIPTION_LIMIT = 500;
const SUMMARY_LIMIT = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  if (typeof field === "string") {
    const trimmed = field.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(field)) {
    const joined = field
      .filter((entry): entry is string => typeof entry === "string")
      .join(" ")
      .trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
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

function bounded(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.slice(0, limit);
}

function toolId(name?: string | null): string {
  return (name ?? "").trim().toLowerCase();
}

export function normalizeOmpEffort(effort?: string): string | undefined {
  if (!effort) return undefined;
  const lower = effort.toLowerCase().trim();
  if (lower === "lo" || lower === "low") return "low";
  if (lower === "med" || lower === "medium") return "medium";
  if (lower === "hi" || lower === "high") return "high";
  if (lower === "xhigh" || lower === "max") return "xhigh";
  return lower;
}

export function isOmpWaitTool(name?: string | null, rawInput?: unknown): boolean {
  const id = toolId(name);
  if (WAIT_TOOL_NAMES.has(id)) return true;
  if (id === "hub" && isRecord(rawInput)) {
    const op = stringField(rawInput, "op");
    if (
      op &&
      ["wait", "jobs", "status", "list", "ps", "logs", "describe", "inbox"].includes(
        op.toLowerCase(),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isOmpKillTool(name?: string | null, rawInput?: unknown): boolean {
  const id = toolId(name);
  if (KILL_TOOL_NAMES.has(id)) return true;
  if (id === "hub" && isRecord(rawInput)) {
    const op = stringField(rawInput, "op");
    if (op && ["cancel", "kill", "abort", "stop"].includes(op.toLowerCase())) return true;
  }
  return false;
}

export function isOmpProcessTool(name?: string | null, rawInput?: unknown): boolean {
  const id = toolId(name);
  if (PROCESS_TOOL_NAMES.has(id)) return true;
  if (id === "hub") {
    if (hubStartProcessName(rawInput)) return true;
    if (isRecord(rawInput)) {
      const op = stringField(rawInput, "op");
      if (op && ["start", "spawn", "restart"].includes(op.toLowerCase())) return true;
    }
  }
  if (
    id === "bash" ||
    id === "sh" ||
    id === "shell" ||
    id === "exec" ||
    id === "terminal" ||
    id === "run" ||
    id === "powershell" ||
    id === "cmd" ||
    id === "command" ||
    id === "eval"
  ) {
    if (hubStartProcessName(rawInput)) return true;
    if (isRecord(rawInput)) {
      return (
        rawInput.async === true ||
        rawInput.background === true ||
        rawInput.detached === true ||
        rawInput.run_in_background === true
      );
    }
  }
  return false;
}

export function ompProcessCommand(name?: string | null, rawInput?: unknown): string {
  const id = toolId(name);
  if (!isRecord(rawInput)) return id || "process";
  const command =
    stringField(rawInput, "command") ??
    stringField(rawInput, "cmd") ??
    stringField(rawInput, "script") ??
    stringField(rawInput, "commandLine") ??
    stringField(rawInput, "command_line");
  if (command) return command;
  const op = stringField(rawInput, "op");
  const processName = stringField(rawInput, "name") ?? hubStartProcessName(rawInput);
  const application = stringField(rawInput, "application");
  const args = Array.isArray(rawInput.args)
    ? rawInput.args.filter((value): value is string => typeof value === "string").join(" ")
    : "";
  if (id === "hub" && op) {
    if (op.toLowerCase() === "start" || op.toLowerCase() === "spawn") {
      const target = processName ? ` ${processName}` : "";
      const exec = application ? ` -- ${application}${args ? ` ${args}` : ""}` : "";
      return `hub start${target}${exec}`;
    }
    if (op.toLowerCase() === "restart") {
      return processName ? `hub restart ${processName}` : "hub restart";
    }
  }
  if (processName) {
    const exec = application ? ` -- ${application}${args ? ` ${args}` : ""}` : "";
    return `hub start ${processName}${exec}`;
  }
  if (application) return args ? `${application} ${args}` : application;
  return id || "process";
}

function hubStartProcessName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return typeof value === "string" ? hubStartProcessNameFromText(value) : undefined;
  }
  const command =
    stringField(value, "command") ??
    stringField(value, "cmd") ??
    stringField(value, "script") ??
    stringField(value, "commandLine") ??
    stringField(value, "command_line") ??
    stringField(value, "code");
  if (command) {
    const fromCommand = hubStartProcessNameFromText(command);
    if (fromCommand) return fromCommand;
  }
  const op = stringField(value, "op");
  if (op && ["start", "spawn", "restart"].includes(op.toLowerCase())) {
    return stringField(value, "name") ?? stringField(value, "process") ?? stringField(value, "id");
  }
  const fromRecordText = hubStartProcessNameFromText(extractText(value) ?? "");
  if (fromRecordText) return fromRecordText;
  return stringField(value, "name");
}

function hubStartProcessNameFromText(value: string): string | undefined {
  const match =
    value.match(/\bhub\s+(?:start|spawn|restart)\s+([^\s]+)/i) ??
    value.match(
      /\btool\.hub\(\s*\{[^}]*\bop\s*:\s*["'](?:start|spawn|restart)["'][^}]*\bname\s*:\s*["']([^"']+)["']/i,
    ) ??
    value.match(
      /\btool\.hub\(\s*\{[^}]*\bname\s*:\s*["']([^"']+)["'][^}]*\bop\s*:\s*["'](?:start|spawn|restart)["']/i,
    ) ??
    value.match(/\bDaemon\s+([^\s:]+)/i);
  const name = match?.[1]?.trim();
  return name && name !== "--" ? name : undefined;
}

export function isOmpProcessId(id?: string | null): boolean {
  if (!id) return false;
  const lower = id.trim().toLowerCase();
  return (
    lower.startsWith("bash_") ||
    lower.startsWith("sh_") ||
    lower.startsWith("exec_") ||
    lower.startsWith("cmd_") ||
    lower.startsWith("proc_") ||
    lower.startsWith("process_") ||
    lower.startsWith("term_") ||
    lower.startsWith("term-") ||
    lower.startsWith("terminal_") ||
    lower.startsWith("terminal-")
  );
}

export function isOmpProcessRole(role?: string | null): boolean {
  if (!role) return false;
  const lower = role.trim().toLowerCase();
  return (
    lower === "process" ||
    lower === "terminal" ||
    lower === "bash" ||
    lower === "sh" ||
    lower === "shell" ||
    lower === "cmd" ||
    lower === "exec"
  );
}

export function isOmpProcessPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const id =
    idField(payload, "id") ??
    idField(payload, "processId") ??
    idField(payload, "process_id") ??
    idField(payload, "jobId") ??
    idField(payload, "job_id") ??
    idField(payload, "name");
  if (isOmpProcessId(id)) return true;
  const role =
    stringField(payload, "role") ??
    stringField(payload, "agent") ??
    stringField(payload, "subagent_type") ??
    stringField(payload, "agent_type");
  if (isOmpProcessRole(role)) return true;
  if (payload.isProcess === true || payload.process === true) return true;
  return false;
}

export function ompProcessOsPid(value: unknown): number | null | undefined {
  if (typeof value === "string") {
    const match = value.match(/\bpid[=:\s]+(\d+)\b/i);
    if (match?.[1]) return Number(match[1]);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const pid = ompProcessOsPid(entry);
      if (pid !== undefined) return pid;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const pid = value.pid ?? value.osPid ?? value.os_pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) return pid;
  if (typeof pid === "string" && /^\d+$/u.test(pid)) return Number(pid);
  if (isRecord(value.result)) return ompProcessOsPid(value.result);
  if (isRecord(value.details)) return ompProcessOsPid(value.details);
  if (Array.isArray(value.content)) return ompProcessOsPid(value.content);
  if (typeof value.output === "string") return ompProcessOsPid(value.output);
  if (typeof value.text === "string") return ompProcessOsPid(value.text);
  return undefined;
}

export function ompSubagentOperation(
  name?: string | null,
  rawInput?: unknown,
): "spawn" | "send" | null {
  const id = toolId(name);
  if (isOmpWaitTool(name, rawInput) || isOmpKillTool(name, rawInput)) return null;
  if (isOmpProcessTool(name, rawInput)) return null;
  if (isOmpProcessPayload(rawInput)) return null;
  if (SEND_TOOL_NAMES.has(id)) return "send";
  if (id === "hub" && isRecord(rawInput)) {
    const op = stringField(rawInput, "op");
    if (op && ["send", "message", "input"].includes(op.toLowerCase())) return "send";
    if (op && ["start", "spawn", "restart"].includes(op.toLowerCase())) return null;
  }
  if (SPAWN_TOOL_NAMES.has(id)) return "spawn";
  if (isRecord(rawInput)) {
    if (
      rawInput.variant === "Task" ||
      typeof rawInput.task === "string" ||
      Array.isArray(rawInput.tasks)
    ) {
      if (id === "task" || id === "delegate" || id === "agent") return "spawn";
    }
  }
  return null;
}

export function ompSubagentDescription(
  rawInput: unknown,
  name?: string | null,
  fallback = "OMP Subagent",
): string {
  if (!isRecord(rawInput)) {
    return name && !SPAWN_TOOL_NAMES.has(toolId(name))
      ? (bounded(name, DESCRIPTION_LIMIT) ?? fallback)
      : fallback;
  }
  const taskDesc =
    stringField(rawInput, "description") ??
    stringField(rawInput, "task") ??
    stringField(rawInput, "prompt") ??
    stringField(rawInput, "name") ??
    stringField(rawInput, "title") ??
    stringField(rawInput, "label") ??
    stringField(rawInput, "command") ??
    stringField(rawInput, "application");
  if (taskDesc) return bounded(taskDesc, DESCRIPTION_LIMIT) ?? fallback;
  if (Array.isArray(rawInput.tasks) && rawInput.tasks.length > 0) {
    const first = rawInput.tasks[0];
    if (isRecord(first)) {
      const desc =
        stringField(first, "name") ??
        stringField(first, "description") ??
        stringField(first, "task") ??
        stringField(first, "prompt");
      if (desc) return bounded(desc, DESCRIPTION_LIMIT) ?? fallback;
    } else if (typeof first === "string" && first.trim().length > 0) {
      return bounded(first.trim(), DESCRIPTION_LIMIT) ?? fallback;
    }
  }

  return (
    (name && !SPAWN_TOOL_NAMES.has(toolId(name)) && !SEND_TOOL_NAMES.has(toolId(name))
      ? bounded(name, DESCRIPTION_LIMIT)
      : undefined) ?? fallback
  );
}

export function ompSubagentPrompt(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const prompt =
    stringField(rawInput, "prompt") ??
    stringField(rawInput, "task") ??
    stringField(rawInput, "instruction") ??
    stringField(rawInput, "message") ??
    stringField(rawInput, "command");
  if (prompt) return bounded(prompt, SUMMARY_LIMIT);

  const app = stringField(rawInput, "application");
  if (app) {
    const args = Array.isArray(rawInput.args)
      ? rawInput.args.filter((a): a is string => typeof a === "string")
      : [];
    const full = args.length > 0 ? `${app} ${args.join(" ")}` : app;
    return bounded(full, SUMMARY_LIMIT);
  }

  if (Array.isArray(rawInput.tasks)) {
    const list = rawInput.tasks
      .map((t) => {
        if (!t) return "";
        if (isRecord(t))
          return stringField(t, "task") ?? stringField(t, "prompt") ?? stringField(t, "name") ?? "";
        if (typeof t === "string") return t;
        return "";
      })
      .filter((t) => t.length > 0);
    if (list.length > 0) return bounded(list.join("\n"), SUMMARY_LIMIT);
  }
  return undefined;
}

export function ompSubagentRole(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const role =
    stringField(rawInput, "agent") ??
    stringField(rawInput, "subagent_type") ??
    stringField(rawInput, "agent_type") ??
    stringField(rawInput, "role") ??
    stringField(rawInput, "type");
  if (role) return bounded(role, DESCRIPTION_LIMIT);

  if (Array.isArray(rawInput.tasks) && rawInput.tasks.length > 0) {
    const first = rawInput.tasks[0];
    if (isRecord(first)) {
      const firstRole =
        stringField(first, "agent") ??
        stringField(first, "subagent_type") ??
        stringField(first, "agent_type") ??
        stringField(first, "role") ??
        stringField(first, "type");
      if (firstRole) return bounded(firstRole, DESCRIPTION_LIMIT);
    }
  }

  const op = stringField(rawInput, "op");
  if (op && (op.toLowerCase() === "start" || op.toLowerCase() === "spawn")) return "process";
  if (rawInput.async === true || rawInput.background === true || rawInput.detached === true) {
    return "process";
  }

  return undefined;
}

export function ompSubagentModel(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const model = stringField(rawInput, "model");
  if (model) return bounded(model, DESCRIPTION_LIMIT);
  if (Array.isArray(rawInput.tasks) && rawInput.tasks.length > 0) {
    const first = rawInput.tasks[0];
    if (isRecord(first)) {
      const firstModel = stringField(first, "model");
      if (firstModel) return bounded(firstModel, DESCRIPTION_LIMIT);
    }
  }
  return undefined;
}

export function ompSubagentReasoningEffort(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const effort = stringField(rawInput, "effort") ?? stringField(rawInput, "reasoningEffort");
  if (effort) return normalizeOmpEffort(effort);
  if (Array.isArray(rawInput.tasks) && rawInput.tasks.length > 0) {
    const first = rawInput.tasks[0];
    if (isRecord(first)) {
      const firstEffort = stringField(first, "effort") ?? stringField(first, "reasoningEffort");
      if (firstEffort) return normalizeOmpEffort(firstEffort);
    }
  }
  return undefined;
}

export function ompSubagentBackground(rawInput: unknown): boolean {
  if (!isRecord(rawInput)) return false;
  if (
    rawInput.background === true ||
    rawInput.detached === true ||
    rawInput.async === true ||
    rawInput.run_in_background === true
  ) {
    return true;
  }
  if (Array.isArray(rawInput.tasks) && rawInput.tasks.length > 0) return true;
  const op = stringField(rawInput, "op");
  if (op && (op.toLowerCase() === "start" || op.toLowerCase() === "spawn")) {
    return true;
  }
  return false;
}

export interface OmpSubagentSpawnSpec {
  description: string;
  prompt?: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
  background: boolean;
  nativeSubagentId?: string;
}

function spawnSpecFromRecord(
  task: Record<string, unknown>,
  fallback: { background: boolean; role?: string; model?: string; reasoningEffort?: string },
  index: number,
): OmpSubagentSpawnSpec {
  const nativeSubagentId =
    idField(task, "name") ??
    idField(task, "id") ??
    idField(task, "subagent_id") ??
    idField(task, "subagentId") ??
    idField(task, "task_id") ??
    idField(task, "taskId") ??
    idField(task, "process_id") ??
    idField(task, "processId") ??
    idField(task, "job_id") ??
    idField(task, "jobId");
  const prompt =
    stringField(task, "task") ??
    stringField(task, "prompt") ??
    stringField(task, "instruction") ??
    stringField(task, "description") ??
    stringField(task, "message");
  const description =
    (nativeSubagentId ? bounded(nativeSubagentId, DESCRIPTION_LIMIT) : undefined) ??
    bounded(prompt, DESCRIPTION_LIMIT) ??
    `OMP Subagent ${index + 1}`;
  const role =
    stringField(task, "agent") ??
    stringField(task, "subagent_type") ??
    stringField(task, "agent_type") ??
    stringField(task, "role") ??
    fallback.role;
  const model = stringField(task, "model") ?? fallback.model;
  const reasoningEffort =
    normalizeOmpEffort(stringField(task, "effort") ?? stringField(task, "reasoningEffort")) ??
    fallback.reasoningEffort;
  const background =
    task.background === true ||
    task.detached === true ||
    task.async === true ||
    task.run_in_background === true ||
    fallback.background;
  const boundedPrompt = bounded(prompt, SUMMARY_LIMIT);
  const boundedRole = bounded(role, DESCRIPTION_LIMIT);
  const boundedModel = bounded(model, DESCRIPTION_LIMIT);
  return {
    description,
    ...(boundedPrompt ? { prompt: boundedPrompt } : {}),
    ...(boundedRole ? { role: boundedRole } : {}),
    ...(boundedModel ? { model: boundedModel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    background,
    ...(nativeSubagentId ? { nativeSubagentId } : {}),
  };
}

export function ompSubagentSpawnSpecs(
  rawInput: unknown,
  name?: string | null,
): OmpSubagentSpawnSpec[] {
  if (isOmpProcessTool(name, rawInput) || isOmpProcessPayload(rawInput)) return [];
  const background = ompSubagentBackground(rawInput);
  if (isRecord(rawInput)) {
    const rawTasks = Array.isArray(rawInput.tasks)
      ? rawInput.tasks
      : Array.isArray(rawInput.agents)
        ? rawInput.agents
        : Array.isArray(rawInput.subagents)
          ? rawInput.subagents
          : null;
    if (rawTasks && rawTasks.length > 0) {
      const fallbackRole = stringField(rawInput, "agent") ?? stringField(rawInput, "role");
      const fallbackModel = stringField(rawInput, "model");
      const fallbackEffort = normalizeOmpEffort(
        stringField(rawInput, "effort") ?? stringField(rawInput, "reasoningEffort"),
      );
      return rawTasks
        .flatMap((task, index) => {
          if (isRecord(task)) {
            return [
              spawnSpecFromRecord(
                task,
                {
                  background,
                  ...(fallbackRole ? { role: fallbackRole } : {}),
                  ...(fallbackModel ? { model: fallbackModel } : {}),
                  ...(fallbackEffort ? { reasoningEffort: fallbackEffort } : {}),
                },
                index,
              ),
            ];
          }
          if (typeof task === "string" && task.trim().length > 0) {
            const prompt = bounded(task.trim(), SUMMARY_LIMIT);
            return [
              {
                description: bounded(task.trim(), DESCRIPTION_LIMIT) ?? `OMP Subagent ${index + 1}`,
                ...(prompt ? { prompt } : {}),
                background,
              },
            ];
          }
          return [];
        })
        .filter((spec) => !isOmpProcessId(spec.nativeSubagentId) && !isOmpProcessRole(spec.role));
    }
  }
  const prompt = ompSubagentPrompt(rawInput);
  const role = ompSubagentRole(rawInput);
  const model = ompSubagentModel(rawInput);
  const reasoningEffort = ompSubagentReasoningEffort(rawInput);
  const nativeSubagentId = ompNativeSubagentId(rawInput);
  if (isOmpProcessId(nativeSubagentId) || isOmpProcessRole(role)) {
    return [];
  }
  return [
    {
      description: ompSubagentDescription(rawInput, name),
      ...(prompt ? { prompt } : {}),
      ...(role ? { role } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      background,
      ...(nativeSubagentId ? { nativeSubagentId } : {}),
    },
  ];
}

export function ompNativeSubagentIds(...candidates: unknown[]): string[] {
  const ids: string[] = [];
  const seen: Record<string, true> = {};
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (Array.isArray(candidate.tasks)) {
      for (const task of candidate.tasks) {
        if (!isRecord(task)) continue;
        const id =
          idField(task, "name") ??
          idField(task, "id") ??
          idField(task, "subagent_id") ??
          idField(task, "task_id");
        if (id && !seen[id]) {
          seen[id] = true;
          ids.push(id);
        }
      }
    }
    if (Array.isArray(candidate.progress)) {
      for (const item of candidate.progress) {
        if (!isRecord(item)) continue;
        const id = idField(item, "id") ?? idField(item, "jobId") ?? idField(item, "name");
        if (id && !seen[id]) {
          seen[id] = true;
          ids.push(id);
        }
      }
    }
    if (isRecord(candidate.details)) {
      for (const id of ompNativeSubagentIds(candidate.details)) {
        if (!seen[id]) {
          seen[id] = true;
          ids.push(id);
        }
      }
    }
  }
  if (ids.length > 0) return ids;
  const single = ompNativeSubagentId(...candidates);
  return single ? [single] : [];
}

function searchCandidateId(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  const direct =
    idField(candidate, "subagent_id") ??
    idField(candidate, "subagentId") ??
    idField(candidate, "task_id") ??
    idField(candidate, "taskId") ??
    idField(candidate, "job_id") ??
    idField(candidate, "jobId") ??
    idField(candidate, "process_id") ??
    idField(candidate, "processId") ??
    idField(candidate, "process_name") ??
    idField(candidate, "processName") ??
    idField(candidate, "name") ??
    idField(candidate, "pid") ??
    idField(candidate, "id");
  if (
    direct &&
    !["hub", "bash", "sh", "task", "read", "edit", "write"].includes(direct.toLowerCase())
  ) {
    return direct;
  }

  if (Array.isArray(candidate.tasks) && candidate.tasks.length > 0) {
    const first = candidate.tasks[0];
    if (isRecord(first)) {
      const fromTask =
        idField(first, "name") ??
        idField(first, "id") ??
        idField(first, "subagent_id") ??
        idField(first, "task_id");
      if (fromTask) return fromTask;
    }
  }

  if (isRecord(candidate.details)) {
    const fromDetails = searchCandidateId(candidate.details);
    if (fromDetails) return fromDetails;
  }

  if (isRecord(candidate.async)) {
    const fromAsync = idField(candidate.async, "jobId") ?? idField(candidate.async, "id");
    if (fromAsync) return fromAsync;
  }

  if (Array.isArray(candidate.progress) && candidate.progress.length > 0) {
    const first = candidate.progress[0];
    if (isRecord(first)) {
      const fromProgress =
        idField(first, "id") ?? idField(first, "jobId") ?? idField(first, "name");
      if (fromProgress) return fromProgress;
    }
  }
  if (Array.isArray(candidate.jobs) && candidate.jobs.length > 0) {
    const first = candidate.jobs[0];
    if (isRecord(first)) {
      const fromJob =
        idField(first, "id") ??
        idField(first, "jobId") ??
        idField(first, "label") ??
        idField(first, "name");
      if (fromJob) return fromJob;
    }
  }

  if (Array.isArray(candidate.processes) && candidate.processes.length > 0) {
    const first = candidate.processes[0];
    if (isRecord(first)) {
      const fromProcess =
        idField(first, "name") ??
        idField(first, "id") ??
        idField(first, "processId") ??
        idField(first, "pid");
      if (fromProcess) return fromProcess;
    }
  }

  return undefined;
}

export function ompNativeSubagentId(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const hubName = hubStartProcessName(candidate);
    if (hubName) return hubName;
    const found = searchCandidateId(candidate);
    if (found) return found;
  }

  const fromText = (pattern: RegExp): string | undefined => {
    for (const candidate of candidates) {
      const text = extractText(candidate);
      const match = text?.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return undefined;
  };

  return (
    fromText(/\bhub\s+(?:start|spawn)\s+([^\s]+)/i) ??
    fromText(/Started\s+([^\s:]+):\s+running/i) ??
    fromText(/Spawned agent \`?([^\`\s,.]+)\`?/i) ??
    fromText(/job \`?([^\`\s,.]+)\`?/i) ??
    fromText(/started a background process named \`?([^\`\s,.]+)\`?/i) ??
    fromText(/background process named \`?([^\`\s,.]+)\`?/i) ??
    fromText(/process (?:named |ID )?\`?([^\`\s,.]+)\`?/i) ??
    fromText(/<task-result\s+[^>]*id="([^"]+)"/i) ??
    fromText(/###\s+([^\s]+)\s+\[/i) ??
    fromText(/subagent[_-]?id:\s*([^\s]+)/i) ??
    fromText(/task[_-]?id:\s*([^\s]+)/i) ??
    fromText(/job[_-]?id:\s*([^\s]+)/i) ??
    fromText(/process[_-]?id:\s*([^\s]+)/i) ??
    fromText(/process[_-]?name:\s*([^\s]+)/i)
  );
}

export function ompSubagentResultSummary(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) return bounded(text, SUMMARY_LIMIT);
  }
  return undefined;
}

export interface OmpSubagentWaitSettlement {
  id: string;
  status: HostSubagentStatus;
  resultSummary?: string;
}

function mapOmpJobStatus(status?: string): HostSubagentStatus {
  if (!status) return "completed";
  switch (status.toLowerCase()) {
    case "completed":
    case "succeeded":
    case "done":
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
    case "in-progress":
    case "working":
      return "running";
    default:
      return "completed";
  }
}

export function ompSubagentWaitSettlements(input: {
  name?: string | null;
  rawInput?: unknown;
  content?: unknown;
  rawOutput?: unknown;
}): OmpSubagentWaitSettlement[] {
  const isWait = isOmpWaitTool(input.name, input.rawInput);
  const isKill = isOmpKillTool(input.name, input.rawInput);
  if (!isWait && !isKill) return [];

  const list: OmpSubagentWaitSettlement[] = [];

  if (isKill && isRecord(input.rawInput)) {
    const targetId =
      stringField(input.rawInput, "name") ??
      stringField(input.rawInput, "to") ??
      stringField(input.rawInput, "id") ??
      stringField(input.rawInput, "taskId") ??
      stringField(input.rawInput, "subagentId");
    if (targetId) {
      list.push({ id: targetId, status: "interrupted" });
    }
    if (Array.isArray(input.rawInput.ids)) {
      for (const id of input.rawInput.ids) {
        if (typeof id === "string" && id.trim().length > 0) {
          list.push({ id: id.trim(), status: "interrupted" });
        }
      }
    }
  }

  const raw = input.rawOutput ?? input.content;
  if (isRecord(raw)) {
    const details = isRecord(raw.details) ? raw.details : raw;
    if (Array.isArray(details.jobs)) {
      for (const job of details.jobs) {
        if (!isRecord(job)) continue;
        const id =
          idField(job, "id") ??
          idField(job, "jobId") ??
          idField(job, "label") ??
          idField(job, "name");
        if (!id) continue;
        const status = isKill ? "interrupted" : mapOmpJobStatus(stringField(job, "status"));
        const resultSummary =
          stringField(job, "resultText") ??
          stringField(job, "output") ??
          stringField(job, "result");
        const boundedSummary = resultSummary ? bounded(resultSummary, SUMMARY_LIMIT) : undefined;
        list.push({
          id,
          status,
          ...(boundedSummary !== undefined ? { resultSummary: boundedSummary } : {}),
        });
      }
    }
    if (Array.isArray(details.processes)) {
      for (const proc of details.processes) {
        if (!isRecord(proc)) continue;
        const id =
          idField(proc, "name") ??
          idField(proc, "id") ??
          idField(proc, "processId") ??
          idField(proc, "pid");
        if (!id) continue;
        const status = isKill ? "interrupted" : mapOmpJobStatus(stringField(proc, "status"));
        list.push({ id, status });
      }
    }
    if (list.length > 0) return list;
  }

  const text = extractText(input.rawOutput) ?? extractText(input.content);
  if (text) {
    const taskResultPattern =
      /<task-result\s+[^>]*id="([^"]+)"(?:\s+[^>]*status="([^"]+)")?[^>]*>([\s\S]*?)<\/task-result>/gi;
    for (const match of text.matchAll(taskResultPattern)) {
      const id = match[1]?.trim();
      const rawStatus = match[2]?.trim();
      const output = match[3]?.trim();
      if (!id) continue;
      const status = isKill ? "interrupted" : mapOmpJobStatus(rawStatus);
      const boundedOutput = output ? bounded(output, SUMMARY_LIMIT) : undefined;
      list.push({
        id,
        status,
        ...(boundedOutput !== undefined ? { resultSummary: boundedOutput } : {}),
      });
    }
    if (list.length > 0) return list;

    const headingPattern =
      /###\s+([^\s]+)\s+\[[^\]]*\]\s*—\s*(completed|failed|running|interrupted|cancelled)/gi;
    for (const match of text.matchAll(headingPattern)) {
      const id = match[1]?.trim();
      const rawStatus = match[2]?.trim();
      if (!id) continue;
      const status = isKill ? "interrupted" : mapOmpJobStatus(rawStatus);
      list.push({ id, status });
    }
    if (list.length > 0) return list;
  }

  return list;
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
  if (typeof value.result === "string" && value.result.trim().length > 0) {
    return value.result.trim();
  }
  if (typeof value.code === "string" && value.code.trim().length > 0) {
    return value.code.trim();
  }
  if (value.content !== undefined) return extractText(value.content, depth + 1);
  return undefined;
}
