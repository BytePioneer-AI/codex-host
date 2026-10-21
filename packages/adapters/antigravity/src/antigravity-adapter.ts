import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  type HarnessAdapter,
  type HarnessError,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessInspection,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type InspectHarnessInput,
  type HostAgentMessageItem,
  type HostCommand,
  type HostContextCompactionItem,
  type HostEvent,
  type HostFileChange,
  type HostItem,
  type HostItemOutcome,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostSubagentState,
  type HostThreadSnapshot,
  type HostUsage,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type HarnessAccountSnapshot,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostItemId,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { resolveAntigravityExecutable } from "./command.js";
import { forkAntigravitySession, nativeBrainDirPath } from "./fork.js";
import { AntigravityHistory } from "./history.js";
import {
  antigravityAvailableThinkingOptions,
  antigravityModelArguments,
  parseAntigravityModels,
} from "./model-catalog.js";
import {
  ANTIGRAVITY_PERMISSION_MODE_CATALOG,
  decodeAntigravityPermissionModeId,
  type AntigravityPermissionMode,
} from "./permission-modes.js";
import { rollbackAntigravityLastTurn } from "./rollback.js";
import { ANTIGRAVITY_COMMAND_CATALOG, parseAndFormatAntigravityCommand } from "./slash-commands.js";
import {
  codeActionFileChange,
  fileChangeFromAntigravityParameters,
  requestAntigravityTrajectorySteps,
  type AntigravityCodeAction,
} from "./code-action-diff.js";
import { fetchAntigravityQuota, type AntigravityQuotaSnapshot } from "./quota.js";
import { AntigravityQuestionBridge } from "./question-bridge.js";
import { AntigravitySubagents } from "./subagents.js";
import { nativeSubagentIdSchema, readSubagentTranscript } from "./subagent-transcript.js";
import {
  antigravityToolErrorMessage,
  isAntigravityPermissionDenial,
  isRecord,
  parseAntigravityStreamLine,
  type AntigravityResultEvent,
  type AntigravityStepUpdateEvent,
  type AntigravityStreamEvent,
  type AntigravityUsage,
} from "./stream-events.js";
import {
  compactToolName,
  completeAntigravityToolItem,
  isAntigravityFileMutatingTool,
  startAntigravityToolItem,
  toolTargetFile,
} from "./tool-projection.js";

export interface AntigravityAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  inspectTimeoutMs?: number;
  printTimeout?: string;
  toolOutputLimit?: number;
  subagentObservationTimeoutMs?: number;
}

interface ActiveTurn {
  startedAtMs: number;
  command: TurnStartCommand;
  /** Compaction item active during explicit /compact or automatic checkpoint. */
  compactionItem: HostContextCompactionItem | null;
  /** Model passed to this CLI invocation, independent of later selections. */
  model: HarnessModelRef | undefined;
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  exited: Promise<void>;
  questions: AntigravityQuestionBridge | null;
  subagents: AntigravitySubagents;
  logPath: string;
  agentItem: HostAgentMessageItem | null;
  agentText: string;
  tools: Map<number, HostItem>;
  completedItems: HostItemSnapshot[];
  emittedAgentTexts: string[];
  stderr: string;
  cancellationRequested: boolean;
  receivedResult: boolean;
  /** agy's own effective permission mode, as reported by the `init` event. */
  nativePermissionMode: string | null;
  /** First tool denial of the Turn, kept to explain an otherwise empty result. */
  permissionDenial: string | null;
  latestUsage: HostUsage | null;
  contextUsagePromise: Promise<Pick<
    HostUsage,
    "contextUsedTokens" | "contextWindowTokens"
  > | null> | null;
  /**
   * Serializes stream handling: resolving a real edit diff needs an awaited
   * Language Server round trip, and Items must still reach the Host in the
   * order agy reported them.
   */
  queue: Promise<void>;
  /** Applied edits already claimed by a tool step, so a repeat edit of the
   * same file maps to the next recorded Code Action rather than the first. */
  codeActionCursor: number;
  fileChanges: Map<number, HostFileChange>;
  /** First sighting of a step whose Item was deferred: agy names the tool and
   * its parameters when the step opens, not when it ends. */
  pendingSteps: Map<number, AntigravityStepUpdateEvent["step_update"]>;
  httpsPort: number | null;
}

const antigravityHarnessId = harnessIdSchema.parse("antigravity");
const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_PRINT_TIMEOUT = "30m";
const DEFAULT_TOOL_OUTPUT_LIMIT = 64_000;
const DEFAULT_SUBAGENT_OBSERVATION_TIMEOUT_MS = 30_000;
const CONTEXT_USAGE_TIMEOUT_MS = 8_000;
const CONTEXT_USAGE_RETRY_MS = 100;
const TRAJECTORY_TIMEOUT_MS = 2_000;
const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;
const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * agy names a tool and its parameters when a step opens and repeats only what
 * changed when it ends, so a step whose Item was deferred has to carry that
 * opening detail forward.
 */
function mergePendingStep(
  pending: AntigravityStepUpdateEvent["step_update"] | undefined,
  step: AntigravityStepUpdateEvent["step_update"],
): AntigravityStepUpdateEvent["step_update"] {
  if (!pending) return step;
  const toolName = step.tool_name ?? pending.tool_name;
  const name = step.tool_info?.name ?? pending.tool_info?.name;
  const parameters = step.tool_info?.parameters ?? pending.tool_info?.parameters;
  const output = step.tool_info?.output ?? pending.tool_info?.output;
  const error = step.tool_info?.error ?? pending.tool_info?.error;
  return {
    ...pending,
    ...step,
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(step.tool_info !== undefined || pending.tool_info !== undefined
      ? {
          tool_info: {
            ...(name !== undefined ? { name } : {}),
            ...(parameters !== undefined ? { parameters } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(error !== undefined ? { error } : {}),
          },
        }
      : {}),
  };
}

/**
 * agy reports a tool target with the platform's own separators while its
 * trajectory reports a `file://` URI, so the two only compare after both are
 * resolved — case-insensitively where the filesystem is.
 */
function sameFile(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isBrainFile(targetPath: string, conversationId?: string): boolean {
  if (!targetPath) return false;
  const resolved = path.resolve(targetPath);
  if (conversationId) {
    const brainDir = path.resolve(nativeBrainDirPath(conversationId));
    if (resolved.startsWith(brainDir)) return true;
  }
  const defaultBrainRoot = path.resolve(os.homedir(), ".gemini", "antigravity-cli", "brain");
  return resolved.startsWith(defaultBrainRoot);
}

export function resolveAntigravityContextWindow(modelId?: string, reportedWindow?: number): number {
  if (modelId && /^claude(?:[-_.]|$)/iu.test(modelId)) {
    return CLAUDE_CONTEXT_WINDOW_TOKENS;
  }
  if (!modelId || /^gemini(?:[-_.]|$)/iu.test(modelId)) {
    return GEMINI_CONTEXT_WINDOW_TOKENS;
  }
  return reportedWindow && reportedWindow > 0 ? reportedWindow : GEMINI_CONTEXT_WINDOW_TOKENS;
}

const CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
  subagents: { observe: true, readTranscript: true },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidState(message: string): HarnessError {
  return { code: "invalidState", message, retryable: false };
}

export const ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION =
  "[System Instruction: When creating new files in the workspace, you MUST use the write_to_file tool. When modifying existing files, use the replace_file_content tool. CRITICAL: NEVER include ArtifactMetadata when calling write_to_file for workspace files (ArtifactMetadata is strictly reserved for artifacts in the brain directory, and providing it for workspace files causes a path validation rejection). Do NOT use terminal commands (such as Set-Content, Out-File, echo, or cat) to create or write code files. For clarification, ask_question is connected to the codexhost Desktop through a Hook. Use single-choice or text questions. The Hook returns the actual user response in its reason while blocking the native auto-skip behavior; do not retry merely because the native tool reports it was blocked.]\n\n";

export function formatAntigravityTurnPrompt(text: string): string {
  if (text.startsWith("/") || text.includes("ArtifactMetadata")) {
    return text;
  }
  return `${ANTIGRAVITY_WORKSPACE_FILE_INSTRUCTION}${text}`;
}

/**
 * Headless agy answers a permission request by denying it, then reports the
 * Turn as successful with an empty response. Without this the user sees a Turn
 * that silently did nothing. The denial echoes the rejected command line, so it
 * is redacted before it leaves the Adapter.
 */
export function permissionDeniedTurnError(nativeMode: string | null, denial: string): HarnessError {
  const mode = nativeMode ? ` '${nativeMode}'` : "";
  return {
    code: "nativeFailure",
    message:
      `Antigravity denied a tool call under its${mode} permission mode and produced no response. ` +
      "codexhost uses native Skip permissions and does not enforce tool permissions. " +
      "Check Antigravity CLI diagnostics and native Hooks for the denial; Desktop approvals and Configured permissions are not supported.",
    retryable: false,
    diagnostic: sanitizeDiagnosticTail(denial),
  };
}

function safeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function contextWindowMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const trajectory = isRecord(value.trajectory) ? value.trajectory : value;
  const generatorMetadata = trajectory.generatorMetadata;
  if (!Array.isArray(generatorMetadata) || generatorMetadata.length === 0) return null;
  for (let i = generatorMetadata.length - 1; i >= 0; i--) {
    const entry = generatorMetadata[i];
    if (isRecord(entry) && isRecord(entry.chatModel)) {
      const chatStartMetadata = entry.chatModel.chatStartMetadata;
      if (isRecord(chatStartMetadata) && isRecord(chatStartMetadata.contextWindowMetadata)) {
        return chatStartMetadata.contextWindowMetadata;
      }
    }
  }
  return null;
}

/** Parses the real context counters exposed by agy's local Language Server. */
export function parseAntigravityContextUsage(
  value: unknown,
  modelId?: string,
): Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null {
  const metadata = contextWindowMetadata(value);
  if (!metadata) return null;
  const breakdown = isRecord(metadata.tokenBreakdown) ? metadata.tokenBreakdown : null;
  const used = safeToken(
    metadata.estimatedTokensUsed ??
      metadata.estimated_tokens_used ??
      breakdown?.totalTokens ??
      breakdown?.total_tokens,
  );
  const window = safeToken(metadata.maxContextTokens ?? metadata.max_context_tokens);
  if (used === undefined) return null;
  const contextWindowTokens = resolveAntigravityContextWindow(modelId, window);
  return { contextUsedTokens: used, contextWindowTokens };
}

function requestAntigravityContextUsage(
  port: number,
  conversationId: string,
  timeoutMs: number,
  modelId?: string,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata",
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          ...(csrfToken ? { "x-codeium-csrf-token": csrfToken } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            resolve(parseAntigravityContextUsage(JSON.parse(body), modelId));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
    request.end(
      JSON.stringify({
        cascadeId: conversationId,
        generatorMetadataOffset: 0,
        includeMessages: false,
      }),
    );
  });
}

export async function readTranscriptContextUsage(
  conversationId: string,
  modelId?: string,
  homedir = os.homedir(),
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  if (!conversationId) return null;
  const dir = path.join(nativeBrainDirPath(conversationId, homedir), ".system_generated", "logs");
  const candidates = [path.join(dir, "transcript.jsonl"), path.join(dir, "transcript_full.jsonl")];
  let content = "";
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, "utf8");
      if (content.length > 0) break;
    } catch {
      // Fall through to next candidate.
    }
  }
  if (!content) return null;
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const input = safeToken(parsed.input_tokens);
      if (input !== undefined) {
        const cached = safeToken(parsed.cache_read_tokens) ?? 0;
        const used = input + cached;
        const rawWindow = safeToken(parsed.context_window_tokens ?? parsed.max_context_tokens);
        const contextWindowTokens = resolveAntigravityContextWindow(modelId, rawWindow);
        if (contextWindowTokens !== undefined && contextWindowTokens > 0) {
          return { contextUsedTokens: used, contextWindowTokens };
        }
      }
    } catch {
      // Skip malformed trailing line.
    }
  }
  return null;
}

async function readTranscriptThinkingSteps(
  conversationId: string,
  seenSteps: Set<number>,
): Promise<Array<{ stepIndex: number; thinking: string }>> {
  if (!conversationId) return [];
  const dir = path.join(nativeBrainDirPath(conversationId), ".system_generated", "logs");
  const candidates = [path.join(dir, "transcript_full.jsonl"), path.join(dir, "transcript.jsonl")];
  let content = "";
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, "utf8");
      if (content.length > 0) break;
    } catch {
      // Fall through to next candidate.
    }
  }
  if (!content) return [];
  const results: Array<{ stepIndex: number; thinking: string }> = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        isRecord(parsed) &&
        parsed.source === "MODEL" &&
        parsed.type === "PLANNER_RESPONSE" &&
        typeof parsed.step_index === "number" &&
        typeof parsed.thinking === "string" &&
        parsed.thinking.trim().length > 0
      ) {
        if (!seenSteps.has(parsed.step_index)) {
          results.push({ stepIndex: parsed.step_index, thinking: parsed.thinking });
        }
      }
    } catch {
      // Skip incomplete trailing line.
    }
  }
  return results;
}

async function readAllExistingTranscriptSteps(conversationId: string): Promise<Set<number>> {
  const steps = new Set<number>();
  if (!conversationId) return steps;
  const dir = path.join(nativeBrainDirPath(conversationId), ".system_generated", "logs");
  const candidates = [path.join(dir, "transcript_full.jsonl"), path.join(dir, "transcript.jsonl")];
  let content = "";
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, "utf8");
      if (content.length > 0) break;
    } catch {
      // Fall through to next candidate.
    }
  }
  if (!content) return steps;
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        isRecord(parsed) &&
        parsed.source === "MODEL" &&
        parsed.type === "PLANNER_RESPONSE" &&
        typeof parsed.step_index === "number"
      ) {
        steps.add(parsed.step_index);
      }
    } catch {
      // Skip incomplete trailing line.
    }
  }
  return steps;
}

export async function readTranscriptToolArgs(
  conversationId: string,
  stepIndex: number,
  toolName?: string,
  targetFile?: string,
): Promise<Record<string, unknown> | null> {
  if (!conversationId) return null;
  const dir = path.join(nativeBrainDirPath(conversationId), ".system_generated", "logs");
  const candidates = [path.join(dir, "transcript.jsonl"), path.join(dir, "transcript_full.jsonl")];

  interface ParsedPlanner {
    stepIndex: number;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  }

  for (const candidate of candidates) {
    let content = "";
    try {
      content = await readFile(candidate, "utf8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;

    const planners: ParsedPlanner[] = [];
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (
          isRecord(parsed) &&
          parsed.source === "MODEL" &&
          parsed.type === "PLANNER_RESPONSE" &&
          typeof parsed.step_index === "number" &&
          Array.isArray(parsed.tool_calls)
        ) {
          const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
          for (const tc of parsed.tool_calls) {
            if (isRecord(tc) && typeof tc.name === "string") {
              const args = isRecord(tc.args) ? (tc.args as Record<string, unknown>) : {};
              toolCalls.push({ name: tc.name, args });
            }
          }
          if (toolCalls.length > 0) {
            planners.push({ stepIndex: parsed.step_index, toolCalls });
          }
        }
      } catch {
        // Skip incomplete trailing line.
      }
    }

    if (planners.length === 0) continue;

    const compactTarget = toolName ? compactToolName(toolName) : undefined;
    const precedingPlanners = planners
      .filter((p) => p.stepIndex < stepIndex)
      .sort((a, b) => b.stepIndex - a.stepIndex);

    const matchesCall = (cand: { name: string; args: Record<string, unknown> }): boolean => {
      if (compactTarget && compactToolName(cand.name) !== compactTarget) {
        return false;
      }
      if (targetFile) {
        const candFile = toolTargetFile(cand.name, cand.args);
        if (!sameFile(candFile, targetFile)) return false;
      }
      return true;
    };

    // 1. Try the closest preceding planner response by offset
    const closest = precedingPlanners[0];
    if (closest) {
      const offset = stepIndex - closest.stepIndex - 1;
      if (offset >= 0 && offset < closest.toolCalls.length) {
        const candidateCall = closest.toolCalls[offset];
        if (candidateCall && matchesCall(candidateCall)) {
          return candidateCall.args;
        }
      }

      // 2. Search the closest planner only when the target file can distinguish
      // multiple calls of the same tool. Older or future planners are not a
      // valid source for the current step's arguments.
      if (targetFile) {
        for (const call of closest.toolCalls) {
          if (matchesCall(call)) {
            return call.args;
          }
        }
      }
    }
  }

  return null;
}

async function antigravityHttpsPort(logPath: string): Promise<number | null> {
  try {
    const log = await readFile(logPath, "utf8");
    const match = log.match(
      /Language server listening on random port at (\d+) for HTTPS \(gRPC\)/iu,
    );
    const port = match ? Number(match[1]) : Number.NaN;
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

async function pollAntigravityContextUsage(
  logPath: string,
  conversationId: string,
  modelId?: string,
  isDone?: () => boolean,
): Promise<Pick<HostUsage, "contextUsedTokens" | "contextWindowTokens"> | null> {
  const deadline = Date.now() + CONTEXT_USAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const transcriptUsage = await readTranscriptContextUsage(conversationId, modelId);
    if (transcriptUsage) return transcriptUsage;
    const port = await antigravityHttpsPort(logPath);
    if (port !== null) {
      const usage = await requestAntigravityContextUsage(
        port,
        conversationId,
        CONTEXT_USAGE_RETRY_MS,
        modelId,
      );
      if (usage) return usage;
    }
    if (isDone?.()) break;
    await new Promise<void>((resolve) => setTimeout(resolve, CONTEXT_USAGE_RETRY_MS));
  }
  return await readTranscriptContextUsage(conversationId, modelId);
}

function hostUsage(value: AntigravityUsage | undefined, modelId?: string): HostUsage | null {
  if (!value) return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const contextUsedTokens = safeToken(value.context_used_tokens ?? value.estimated_tokens_used);
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens =
    contextUsedTokens !== undefined || rawWindow !== undefined || modelId !== undefined
      ? resolveAntigravityContextWindow(modelId, rawWindow)
      : undefined;
  const usage: HostUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextWindowTokens !== undefined && contextWindowTokens > 0
      ? {
          contextWindowTokens,
          ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
        }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

function normalizedProcessError(
  detail: string,
  fallback: string,
  exposeDetail = false,
): HarnessError {
  const nativeDetail = detail.trim();
  // stderr can echo the invoked command line, so retain its existing redacted
  // diagnostic tail. A structured result.error is shown verbatim below.
  const diagnostic = sanitizeDiagnosticTail(nativeDetail);
  if (/sign[ -]?in|authenticat|credential|login/iu.test(nativeDetail)) {
    return {
      code: "authenticationRequired",
      message: exposeDetail ? nativeDetail || fallback : diagnostic || fallback,
      retryable: false,
    };
  }
  return {
    code: "nativeFailure",
    message: exposeDetail && nativeDetail ? `${fallback}: ${nativeDetail}` : fallback,
    // These native rejections need a changed precondition or a quota reset;
    // immediately replaying a Turn (and its tools) cannot resolve them.
    retryable: !/User location is not supported for the API use|Individual quota reached/iu.test(
      nativeDetail,
    ),
    ...(diagnostic ? { stderrTail: diagnostic.slice(-4_000) } : {}),
  };
}

async function runBuffered(
  executable: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const invocation = commandInvocation(executable, arguments_, environment);
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: environment,
      ...(signal ? { signal, killSignal: "SIGKILL" as const } : {}),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Antigravity CLI timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Antigravity CLI exited with code ${String(code)}`));
    });
  });
}

class AntigravitySession implements HarnessSession {
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly capabilities = CAPABILITIES;
  readonly commands: HarnessCommandCapability;
  readonly initialUsage: HostUsage | null = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #onClosed: () => void;
  readonly #printTimeout: string;
  readonly #toolOutputLimit: number;
  readonly #subagentObservationTimeoutMs: number;
  readonly #history: AntigravityHistory;
  readonly #subagentObservers = new Set<AntigravitySubagents>();
  readonly #emittedReasoningSteps = new Set<number>();
  #initializedTranscriptSteps = false;
  #active: ActiveTurn | null = null;
  #preparingQuestions: Promise<AntigravityQuestionBridge> | null = null;
  #questionCleanup: Promise<void> = Promise.resolve();
  #closed = false;
  #model: HarnessModelRef | undefined;
  #nativeRef: NativeSessionRef | undefined;
  #permissionMode: AntigravityPermissionMode;
  #thinkingOptionId: HarnessThinkingOptionId | undefined;
  readonly #catalog: HarnessModelCatalog | undefined;

  constructor(input: {
    catalog?: HarnessModelCatalog;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    executable: string;
    model?: HarnessModelRef;
    nativeRef?: NativeSessionRef;
    history: AntigravityHistory;
    permissionMode: AntigravityPermissionMode;
    printTimeout: string;
    thinkingOptionId?: HarnessThinkingOptionId;
    toolOutputLimit: number;
    subagentObservationTimeoutMs: number;
    onClosed(): void;
  }) {
    this.#catalog = input.catalog;
    this.#cwd = input.cwd;
    this.#environment = input.environment;
    this.#executable = input.executable;
    this.#history = input.history;
    this.#model = input.model ?? input.history.model;
    this.#nativeRef = input.nativeRef;
    this.#permissionMode = input.permissionMode;
    this.#printTimeout = input.printTimeout;
    this.#thinkingOptionId = input.thinkingOptionId ?? input.history.thinkingOptionId;
    this.#toolOutputLimit = input.toolOutputLimit;
    this.#subagentObservationTimeoutMs = input.subagentObservationTimeoutMs;
    this.#onClosed = input.onClosed;
    this.initialState = this.#state();
    this.outputs = this.#channel.outputs;
    this.commands = {
      list: async () => ({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG }),
      execute: (command) => this.#executeHarnessCommand(command),
    };
  }

  get nativeRef(): NativeSessionRef | undefined {
    return this.#nativeRef;
  }

  get model(): HarnessModelRef | undefined {
    return this.#model;
  }

  get thinkingOptionId(): HarnessThinkingOptionId | undefined {
    return this.#thinkingOptionId;
  }

  get permissionMode(): AntigravityPermissionMode {
    return this.#permissionMode;
  }

  get history(): AntigravityHistory {
    return this.#history;
  }

  get isActive(): boolean {
    return (
      this.#active !== null ||
      this.#preparingQuestions !== null ||
      [...this.#subagentObservers].some((observer) => observer.running)
    );
  }

  subagentState(id: string): HostSubagentState | undefined {
    for (const observer of [...this.#subagentObservers].reverse()) {
      const state = observer.state(id);
      if (state) return state;
    }
    return historySubagentState(this.#history, id);
  }

  readonly initialState: HarnessSessionState;

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    return { ok: true, value: { turns: this.#history.snapshot(), state: this.#state() } };
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Session is closed") };
    if (command.type === "turn.cancel") return this.#cancel(command);
    if (command.type === "model.select") return this.#selectModel(command);
    if (command.type === "permissionMode.select") return this.#selectPermissionMode(command);
    if (command.type === "thinking.select") return this.#selectThinking(command);
    if (command.type === "interaction.respond") {
      return (
        this.#active?.questions?.respond(command) ?? {
          ok: false,
          error: invalidState("Antigravity Question is not active"),
        }
      );
    }
    if (this.isActive) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Turn is already running",
          retryable: true,
        },
      };
    }
    const text = command.input
      .map(({ text: part }) => part)
      .join("\n")
      .trim();
    if (!text) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Antigravity Turn is empty", retryable: false },
      };
    }
    const isCompact = text === "/compact" || text.startsWith("/compact ");
    const nativeConversationId = this.#nativeRef?.nativeSessionId;
    if (isCompact && !nativeConversationId) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Antigravity context compaction requires an active conversation",
          retryable: false,
        },
      };
    }

    let questions: AntigravityQuestionBridge | null = null;
    let environment = this.#environment;
    if (!isCompact) {
      this.#preparingQuestions = AntigravityQuestionBridge.create({
        turnId: command.turnId,
        nativeSessionId: () =>
          this.#active?.command === command && !this.#active.cancellationRequested
            ? this.#nativeRef?.nativeSessionId
            : undefined,
        schedule: (action) => {
          if (this.#active?.command === command) this.#enqueue(this.#active, action);
          else action();
        },
        emit: (output) => {
          const active = this.#active;
          if (!active || active.command !== command) return;
          if (output.kind === "event" && output.event.type === "item.started" && active.agentItem) {
            this.#closeAgentItem(active, { status: "succeeded" }, "commentary");
          }
          if (output.kind === "event" && output.event.type === "item.completed") {
            active.completedItems.push(output.event.snapshot);
          }
          this.#channel.emit(output);
        },
      });
      try {
        questions = await this.#preparingQuestions;
        environment = { ...this.#environment, ...questions.environment };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "nativeFailure",
            message: `Question bridge setup failed: ${errorMessage(error)}`,
            retryable: true,
          },
        };
      } finally {
        this.#preparingQuestions = null;
      }
      if (this.#closed) {
        await questions.dispose();
        return { ok: false, error: invalidState("Antigravity Session is closed") };
      }
    } else if (this.#closed) {
      return { ok: false, error: invalidState("Antigravity Session is closed") };
    }
    const logPath = path.join(os.tmpdir(), `codexhost-antigravity-${randomUUID()}.log`);
    const arguments_ = isCompact
      ? [
          "--conversation",
          nativeConversationId ?? "",
          `--print=${text}`,
          "--output-format",
          "stream-json",
          "--print-timeout",
          this.#printTimeout,
        ]
      : [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--print-timeout",
          this.#printTimeout,
        ];
    if (!isCompact && this.#nativeRef)
      arguments_.unshift("--conversation", this.#nativeRef.nativeSessionId);
    arguments_.push(...antigravityModelArguments(this.#model, this.#thinkingOptionId));
    arguments_.push("--dangerously-skip-permissions");
    arguments_.push("--add-dir", this.#cwd);
    if (!isCompact && questions) arguments_.push("--add-dir", questions.directory);
    arguments_.push("--log-file", logPath);
    const invocation = commandInvocation(this.#executable, arguments_, environment);
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(invocation.command, invocation.arguments, {
        cwd: this.#cwd,
        env: environment,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      await questions?.dispose();
      return {
        ok: false,
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      };
    }
    let compactionItem: HostContextCompactionItem | null = null;
    if (isCompact) {
      compactionItem = {
        type: "contextCompaction",
        itemId: this.#newItemId(),
      };
    }
    const active: ActiveTurn = {
      startedAtMs: Date.now(),
      command,
      compactionItem,
      model: this.#model,
      process: child,
      exited: new Promise<void>((resolve) => child.once("close", () => resolve())),
      questions,
      subagents: new AntigravitySubagents({
        turnId: command.turnId,
        parentId: () => this.#nativeRef?.nativeSessionId,
        port: () => this.#languageServerPort(active),
        cwd: this.#cwd,
        outputLimit: this.#toolOutputLimit,
        observationTimeoutMs: this.#subagentObservationTimeoutMs,
        initialStates: this.#history
          .snapshot()
          .flatMap((turn) =>
            turn.items.flatMap(({ item }) =>
              item.type === "subagentDelegation" ? item.subagents : [],
            ),
          ),
        emit: (event) => {
          if (event.type === "subagent.state.changed") {
            const state = active.subagents.state(event.nativeSubagentId);
            if (state) this.#history.updateSubagent(state);
          }
          this.#event(event);
        },
        complete: (snapshot) => active.completedItems.push(snapshot),
        schedule: (work) => this.#enqueue(active, work),
      }),
      logPath,
      agentItem: null,
      agentText: "",
      tools: new Map(),
      completedItems: [],
      emittedAgentTexts: [],
      stderr: "",
      cancellationRequested: false,
      receivedResult: false,
      nativePermissionMode: null,
      permissionDenial: null,
      latestUsage: null,
      contextUsagePromise: null,
      queue: Promise.resolve(),
      codeActionCursor: 0,
      fileChanges: new Map(),
      pendingSteps: new Map(),
      httpsPort: null,
    };
    this.#active = active;
    this.#subagentObservers.add(active.subagents);
    child.stdin.on("error", () => undefined);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      active.stderr = (active.stderr + chunk).slice(-8_000);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseAntigravityStreamLine(line);
      if (event) this.#enqueue(active, () => this.#handleEvent(active, event));
      else if (line.trim()) active.stderr = (active.stderr + `\n${line}`).slice(-8_000);
    });
    child.once("error", (error) => {
      this.#enqueue(active, () => {
        if (this.#active !== active) return;
        this.#completeTurn(active, {
          status: "failed",
          error: { code: "nativeFailure", message: error.message, retryable: true },
        });
      });
    });
    child.once("close", (code) => {
      this.#enqueue(active, () => {
        void unlink(active.logPath).catch(() => undefined);
        if (active.subagents.running) void active.subagents.cancel();
        else active.subagents.stop();
        if (this.#active !== active || active.receivedResult) return;
        if (active.cancellationRequested) {
          this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user" });
        } else {
          this.#completeTurn(active, {
            status: "failed",
            error: normalizedProcessError(
              active.stderr,
              `Antigravity CLI exited before a result event (code ${String(code)})`,
            ),
          });
        }
      });
    });
    if (isCompact && compactionItem) {
      child.stdin.end();
      this.#event({ type: "turn.started", turnId: command.turnId });
      this.#event({ type: "item.started", turnId: command.turnId, item: compactionItem });
      return { ok: true, value: { turnId: command.turnId } };
    }
    try {
      const turnPrompt = formatAntigravityTurnPrompt(text);
      if (child.stdin.writable) {
        child.stdin.write(
          `${JSON.stringify({ event: "user", message: { content: turnPrompt } })}\n`,
          () => undefined,
        );
      }
    } catch (error) {
      child.kill();
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      });
      return {
        ok: false,
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      };
    }
    this.#event({ type: "turn.started", turnId: command.turnId });
    return { ok: true, value: { turnId: command.turnId } };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const preparing = await this.#preparingQuestions?.catch(() => undefined);
    await preparing?.dispose();
    if (this.#active) {
      const active = this.#active;
      active.cancellationRequested = true;
      await active.subagents.cancel();
      active.process.kill();
      this.#completeTurn(active, { status: "cancelled", reason: "Session closed" });
    }
    await Promise.all([...this.#subagentObservers].map((observer) => observer.cancel()));
    await this.#questionCleanup;
    await this.#history.flush().catch(() => undefined);
    this.#channel.end();
    this.#onClosed();
  }

  /**
   * Runs stream work one item at a time. Resolving a real edit patch needs an
   * awaited Language Server call, and Codex Desktop renders Items in arrival
   * order, so nothing may overtake a step that is still resolving.
   */
  #enqueue(active: ActiveTurn, work: () => Promise<void> | void): void {
    active.queue = active.queue.then(work).catch((error: unknown) => {
      if (this.#active !== active) return;
      this.#completeTurn(active, {
        status: "failed",
        error: { code: "nativeFailure", message: errorMessage(error), retryable: true },
      });
    });
  }

  async #handleEvent(active: ActiveTurn, event: AntigravityStreamEvent): Promise<void> {
    if (this.#active !== active) return;
    if (event.event === "init") {
      active.nativePermissionMode = event.init?.permission_mode ?? null;
      if (this.#nativeRef && this.#nativeRef.nativeSessionId !== event.conversation_id) {
        this.#completeTurn(active, {
          status: "failed",
          error: {
            code: "sessionNotFound",
            message: "Antigravity resumed a different Conversation",
            retryable: false,
          },
        });
        active.process.kill();
        return;
      }
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: event.conversation_id,
        formatVersion: 1,
      });
      this.#history.bindNativeSession(event.conversation_id);
      this.#event({ type: "session.state.changed", state: this.#state() });
      if (!this.#initializedTranscriptSteps) {
        this.#initializedTranscriptSteps = true;
        const existing = await readAllExistingTranscriptSteps(event.conversation_id);
        for (const step of existing) this.#emittedReasoningSteps.add(step);
      }
      this.#ensureContextUsage(active, event.conversation_id);
      return;
    }
    if (event.event === "step_update") {
      if (event.step_update.conversation_id !== this.#nativeRef?.nativeSessionId) return;
      await this.#handleStep(active, event.step_update);
      const usage = hostUsage(event.step_update.usage, active.model?.id);
      if (usage) this.#publishUsage(active, usage);
      this.#ensureContextUsage(active, event.step_update.conversation_id);
      return;
    }
    if (event.event !== "result") return;
    active.receivedResult = true;
    await this.#handleResult(active, event);
  }

  async #handleResult(active: ActiveTurn, event: AntigravityResultEvent): Promise<void> {
    if (this.#active !== active) return;
    const resultConversationId = event.result.conversation_id.trim();
    if (
      resultConversationId &&
      this.#nativeRef &&
      resultConversationId !== this.#nativeRef.nativeSessionId
    ) {
      this.#completeTurn(active, {
        status: "failed",
        error: {
          code: "protocolError",
          message: "Antigravity returned a result for a different Conversation",
          retryable: false,
        },
      });
      return;
    }
    const usage = hostUsage(event.result.usage, active.model?.id);
    if (usage) this.#publishUsage(active, usage);
    this.#ensureContextUsage(active, event.result.conversation_id);
    const contextUsage =
      (await readTranscriptContextUsage(
        resultConversationId ||
          event.result.conversation_id ||
          this.#nativeRef?.nativeSessionId ||
          "",
        active.model?.id,
      )) ?? (active.contextUsagePromise ? await active.contextUsagePromise : null);
    if (contextUsage) this.#publishUsage(active, contextUsage);
    await active.subagents.refresh();
    if (this.#active !== active) return;
    const convId = resultConversationId || this.#nativeRef?.nativeSessionId || "";

    if (!this.#nativeRef && convId) {
      this.#nativeRef = nativeSessionRefSchema.parse({
        harnessId: this.harnessId,
        nativeSessionId: convId,
        formatVersion: 1,
      });
      this.#history.bindNativeSession(convId);
      this.#event({ type: "session.state.changed", state: this.#state() });
    }
    if (convId && !active.agentItem && active.emittedAgentTexts.length === 0) {
      await this.#syncReasoning(active, convId);
    }
    if (event.result.response) {
      this.#appendOrSyncAgentText(active, event.result.response, false);
    }
    const safeTurnId =
      event.result.num_turns !== undefined && event.result.num_turns !== null
        ? `turn:${event.result.num_turns}`
        : `turn:${this.#history.snapshot().length + 1}`;
    const safeSessionId = convId || this.#nativeRef?.nativeSessionId || "unknown-session";

    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: safeSessionId,
      nativeTurnKey: safeTurnId,
      formatVersion: 1,
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: safeSessionId,
      checkpointId: safeTurnId,
      formatVersion: 1,
    });
    if (active.cancellationRequested) {
      this.#completeTurn(
        active,
        { status: "cancelled", reason: "Cancelled by user", checkpoint },
        nativeTurnRef,
      );
    } else if (event.result.status === "SUCCESS") {
      if (active.compactionItem) {
        this.#completeCompactionItem(active, { status: "succeeded" });
      }
      if (active.permissionDenial !== null && !active.agentItem) {
        this.#completeTurn(
          active,
          {
            status: "failed",
            error: permissionDeniedTurnError(active.nativePermissionMode, active.permissionDenial),
            checkpoint,
          },
          nativeTurnRef,
        );
      } else {
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      }
    } else {
      if (active.compactionItem) {
        this.#completeCompactionItem(active, {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "Antigravity context compaction failed",
            retryable: false,
          },
        });
      }
      const nativeError = event.result.error?.trim();
      const errorDetail = nativeError || active.stderr;
      this.#completeTurn(
        active,
        {
          status: "failed",
          error: normalizedProcessError(
            errorDetail,
            `Antigravity Turn ended with status ${event.result.status}`,
            nativeError !== undefined,
          ),
          checkpoint,
        },
        nativeTurnRef,
      );
    }
  }

  #publishUsage(active: ActiveTurn, usage: HostUsage): void {
    active.latestUsage = { ...(active.latestUsage ?? {}), ...usage };
    this.#event({
      type: "session.usage.changed",
      usage: active.latestUsage,
      observedForTurnId: active.command.turnId,
    });
  }

  #ensureContextUsage(active: ActiveTurn, conversationId: string): void {
    if (active.contextUsagePromise) return;
    active.contextUsagePromise = pollAntigravityContextUsage(
      active.logPath,
      conversationId,
      active.model?.id,
      () =>
        active.receivedResult || active.cancellationRequested || active.process.exitCode !== null,
    );
  }

  async #handleStep(
    active: ActiveTurn,
    step: AntigravityStepUpdateEvent["step_update"],
  ): Promise<void> {
    if (
      step.conversation_id &&
      (step.step_type === "tool" || step.step_type === "subagent" || !active.agentItem)
    ) {
      await this.#syncReasoning(active, step.conversation_id);
    }
    if (step.step_type === "subagent") {
      if (active.agentItem) {
        this.#closeAgentItem(active, { status: "succeeded" }, "commentary");
      }
      if (active.subagents.handle(step)) return;
      step = { ...step, step_type: "tool" };
    }
    if (step.step_type === "agent_response") {
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        this.#appendOrSyncAgentText(active, step.text_delta, true);
        return;
      }
      const fullOrDelta =
        step.text ??
        (typeof step.content === "string" ? step.content : undefined) ??
        (typeof step.message === "string" ? step.message : undefined);
      if (typeof fullOrDelta === "string" && fullOrDelta.length > 0) {
        this.#appendOrSyncAgentText(active, fullOrDelta, false);
        return;
      }
      return;
    }
    if (step.step_type === "checkpoint") {
      if (active.agentItem) {
        this.#closeAgentItem(active, { status: "succeeded" }, "commentary");
      }
      if (!active.compactionItem) {
        const item: HostContextCompactionItem = {
          type: "contextCompaction",
          itemId: this.#newItemId(),
        };
        active.compactionItem = item;
        this.#event({ type: "item.started", turnId: active.command.turnId, item });
      }
      if (step.state === "DONE") {
        this.#completeCompactionItem(active, { status: "succeeded" });
        void readTranscriptContextUsage(step.conversation_id, active.model?.id).then(
          (contextUsage) => {
            if (contextUsage && this.#active === active) {
              this.#publishUsage(active, contextUsage);
            }
          },
        );
      } else if (step.state === "ERROR") {
        this.#completeCompactionItem(active, {
          status: "failed",
          error: {
            code: "nativeFailure",
            message: "Antigravity context compaction failed",
            retryable: false,
          },
        });
      }
      return;
    }
    if (step.step_type !== "tool") return;
    if (active.agentItem) {
      this.#closeAgentItem(active, { status: "succeeded" }, "commentary");
    }
    const merged = mergePendingStep(active.pendingSteps.get(step.step_index), step);
    let item = active.tools.get(step.step_index);
    if (!item) {
      const started = await this.#startToolItem(active, merged);
      if (!started) {
        active.pendingSteps.set(step.step_index, merged);
        return;
      }
      active.pendingSteps.delete(step.step_index);
      item = started;
      active.tools.set(step.step_index, item);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    if (merged.state !== "DONE" && merged.state !== "ERROR") return;
    const toolError = antigravityToolErrorMessage(merged.tool_info?.error);
    if (toolError !== null && active.permissionDenial === null) {
      if (isAntigravityPermissionDenial(toolError)) active.permissionDenial = toolError;
    }
    const completed = completeAntigravityToolItem(item, merged, this.#toolOutputLimit, this.#cwd);
    active.tools.delete(step.step_index);
    const toolName =
      merged.tool_name ??
      merged.tool_info?.name ??
      (item.type === "toolExecution" ? item.toolName : item.type);
    const itemOutcome: HostItemOutcome =
      merged.state === "ERROR"
        ? {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: toolError
                ? `Antigravity tool '${toolName}' failed: ${toolError}`
                : `Antigravity tool '${toolName}' failed`,
              retryable: false,
            },
          }
        : { status: "succeeded" };
    this.#completeItem(active, completed, itemOutcome);

    if (
      itemOutcome.status === "succeeded" &&
      item.type !== "fileChange" &&
      isAntigravityFileMutatingTool(toolName)
    ) {
      const change = await this.#claimFileChange(active, merged, toolName);
      if (change) {
        const fileItem: HostItem = {
          type: "fileChange",
          itemId: this.#newItemId(),
          sourceItemIds: [completed.itemId],
          changes: [change],
        };
        this.#event({ type: "item.started", turnId: active.command.turnId, item: fileItem });
        this.#completeItem(active, fileItem, { status: "succeeded" });
      }
    }
  }

  /**
   * A file-mutating step only becomes a File Change Item once its patch is
   * known. agy publishes the step before the Language Server has recorded the
   * applied edit, so an unresolved step stays uncarded until its terminal
   * update rather than showing an empty patch.
   */
  async #startToolItem(
    active: ActiveTurn,
    step: AntigravityStepUpdateEvent["step_update"],
  ): Promise<HostItem | null> {
    const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
    if (isAntigravityFileMutatingTool(toolName)) {
      const change = await this.#claimFileChange(active, step, toolName);
      if (change) {
        return { type: "fileChange", itemId: this.#newItemId(), changes: [change] };
      }
      if (step.state !== "DONE" && step.state !== "ERROR") return null;
    }
    return startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
  }

  async #claimFileChange(
    active: ActiveTurn,
    step: AntigravityStepUpdateEvent["step_update"],
    toolName: string,
  ): Promise<HostFileChange | null> {
    const claimed = active.fileChanges.get(step.step_index);
    if (claimed) return claimed;
    const target = toolTargetFile(toolName, step.tool_info?.parameters);
    if (target && isBrainFile(target, step.conversation_id)) return null;

    const port = await this.#languageServerPort(active);
    if (port !== null && target) {
      const actions = await requestAntigravityTrajectorySteps(
        port,
        step.conversation_id,
        TRAJECTORY_TIMEOUT_MS,
      );
      const index = actions.findIndex(
        (action, at) => at >= active.codeActionCursor && sameFile(action.absolutePath, target),
      );
      const action: AntigravityCodeAction | undefined = index === -1 ? undefined : actions[index];
      if (action) {
        const change = codeActionFileChange(action, this.#cwd);
        if (change) {
          active.codeActionCursor = index + 1;
          active.fileChanges.set(step.step_index, change);
          return change;
        }
      }
    }
    const fallback = fileChangeFromAntigravityParameters(
      toolName,
      step.tool_info?.parameters,
      this.#cwd,
    );
    if (fallback) {
      active.fileChanges.set(step.step_index, fallback);
      return fallback;
    }
    if (step.conversation_id) {
      const transcriptArgs = await readTranscriptToolArgs(
        step.conversation_id,
        step.step_index,
        toolName,
        target ?? undefined,
      );
      if (transcriptArgs) {
        const resolvedTarget = target ?? toolTargetFile(toolName, transcriptArgs);
        if (resolvedTarget && isBrainFile(resolvedTarget, step.conversation_id)) {
          return null;
        }
        const fromTranscript = fileChangeFromAntigravityParameters(
          toolName,
          transcriptArgs,
          this.#cwd,
        );
        if (fromTranscript) {
          active.fileChanges.set(step.step_index, fromTranscript);
          return fromTranscript;
        }
      }
    }
    return null;
  }

  async #languageServerPort(active: ActiveTurn): Promise<number | null> {
    if (active.httpsPort !== null) return active.httpsPort;
    const port = await antigravityHttpsPort(active.logPath);
    if (port !== null) active.httpsPort = port;
    return port;
  }

  async #syncReasoning(active: ActiveTurn, conversationId: string): Promise<void> {
    const thinkingSteps = await readTranscriptThinkingSteps(
      conversationId,
      this.#emittedReasoningSteps,
    );
    if (thinkingSteps.length === 0) return;
    for (const { stepIndex, thinking } of thinkingSteps) {
      this.#emittedReasoningSteps.add(stepIndex);
      const itemId = this.#newItemId();
      const item: HostReasoningItem = {
        type: "reasoning",
        itemId,
        text: thinking,
      };
      this.#event({
        type: "item.started",
        turnId: active.command.turnId,
        item: { type: "reasoning", itemId, text: "" },
      });
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId,
        update: { type: "text.append", text: thinking },
      });
      this.#completeItem(active, item, { status: "succeeded" });
    }
  }

  #closeAgentItem(
    active: ActiveTurn,
    outcome: HostItemOutcome = { status: "succeeded" },
    phase?: "commentary" | "final_answer",
  ): void {
    if (!active.agentItem) return;
    const item = phase ? { ...active.agentItem, phase } : active.agentItem;
    this.#completeItem(active, item, outcome);
    const trimmed = active.agentText.trim();
    if (trimmed.length > 0) {
      active.emittedAgentTexts.push(active.agentText);
    }
    active.agentItem = null;
    active.agentText = "";
  }

  #appendOrSyncAgentText(active: ActiveTurn, text: string, isExplicitDelta: boolean): void {
    if (!text) return;
    if (isExplicitDelta) {
      this.#appendAgentText(active, text);
      return;
    }
    const trimmedIncoming = text.trim();
    if (!trimmedIncoming) return;

    if (active.agentItem) {
      const trimmedActive = active.agentText.trim();
      if (
        text === active.agentText ||
        trimmedActive === trimmedIncoming ||
        active.agentText.startsWith(text)
      ) {
        return;
      }
      if (text.startsWith(active.agentText)) {
        const delta = text.slice(active.agentText.length);
        if (delta.length > 0) this.#appendAgentText(active, delta);
        return;
      }
      // If the incoming text is neither an existing prefix nor a continuation,
      // close the existing item as commentary so the new block starts cleanly.
      this.#closeAgentItem(active, { status: "succeeded" }, "commentary");
    }

    if (active.emittedAgentTexts.length > 0) {
      if (
        active.emittedAgentTexts.some((prev) => {
          const p = prev.trim();
          return p === trimmedIncoming;
        })
      ) {
        return;
      }

      const concatenated = active.emittedAgentTexts.map((t) => t.trim()).join("\n\n");
      if (
        concatenated === trimmedIncoming ||
        concatenated.replace(/\s+/gu, " ") === trimmedIncoming.replace(/\s+/gu, " ")
      ) {
        return;
      }

      let remaining = trimmedIncoming;
      for (const prev of active.emittedAgentTexts) {
        const p = prev.trim();
        if (p.length > 0 && remaining.startsWith(p)) {
          remaining = remaining.slice(p.length).trim();
        }
      }
      if (!remaining) return;
      if (
        active.emittedAgentTexts.some((prev) => {
          const p = prev.trim();
          return p === remaining;
        })
      ) {
        return;
      }

      this.#appendAgentText(active, remaining);
      return;
    }

    this.#appendAgentText(active, text);
  }

  #appendAgentText(active: ActiveTurn, text: string): void {
    if (!active.agentItem) {
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text };
      active.agentText = text;
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.agentItem });
      return;
    }
    active.agentText += text;
    active.agentItem = { ...active.agentItem, text: active.agentText };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.agentItem.itemId,
      update: { type: "text.append", text },
    });
  }

  #completeTurn(active: ActiveTurn, outcome: TurnOutcome, nativeTurnRef?: NativeTurnRef): void {
    if (this.#active !== active) return;
    active.questions?.stop();
    this.#questionCleanup = this.#questionCleanup
      .then(async () => {
        if (outcome.status !== "succeeded") await active.subagents.cancel();
        await active.subagents.settled;
        if (active.process.stdin.writable) active.process.stdin.end();
        const timer = setTimeout(() => active.process.kill(), 2_000);
        await active.exited.finally(() => clearTimeout(timer));
        await active.questions?.dispose();
        this.#subagentObservers.delete(active.subagents);
      })
      .catch(() => undefined);
    this.#active = null;
    const itemOutcome: HostItemOutcome =
      outcome.status === "failed"
        ? { status: "failed", error: outcome.error }
        : outcome.status === "cancelled"
          ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
          : { status: "succeeded" };
    active.subagents.finish(itemOutcome);
    if (active.compactionItem) {
      this.#completeCompactionItem(active, itemOutcome);
    }
    // A step whose patch never resolved still ran, so an interrupted Turn
    // reports it as a Tool Execution rather than dropping it silently.
    for (const step of active.pendingSteps.values()) {
      const item = startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
      this.#event({ type: "item.started", turnId: active.command.turnId, item });
      this.#completeItem(active, item, itemOutcome);
    }
    active.pendingSteps.clear();
    for (const item of active.tools.values()) this.#completeItem(active, item, itemOutcome);
    active.tools.clear();
    if (active.agentItem) {
      this.#closeAgentItem(
        active,
        itemOutcome,
        itemOutcome.status === "succeeded" ? "final_answer" : "commentary",
      );
    }
    if (nativeTurnRef) {
      this.#history.append({
        nativeTurnRef,
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
        turnInput: active.command.input,
        items: active.completedItems.map((snapshot) => ({
          ...snapshot,
          item: active.subagents.snapshot(snapshot.item),
        })),
        outcome:
          outcome.status === "failed"
            ? { status: "failed", error: outcome.error }
            : outcome.status === "cancelled"
              ? { status: "cancelled", ...(outcome.reason ? { reason: outcome.reason } : {}) }
              : { status: "succeeded" },
        startedAtMs: active.startedAtMs,
        completedAtMs: Date.now(),
        ...(this.#model ? { model: this.#model } : {}),
      });
    }
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      outcome,
      ...(nativeTurnRef ? { nativeTurnRef } : {}),
    });
  }

  #completeCompactionItem(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.compactionItem;
    if (!item) return;
    active.compactionItem = null;
    this.#completeItem(active, item, outcome);
  }

  #completeItem(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome } satisfies HostItemSnapshot;
    active.completedItems.push(snapshot);
    this.#event({ type: "item.completed", turnId: active.command.turnId, snapshot });
  }

  async #executeHarnessCommand(
    command: HarnessCommandInvocation,
  ): Promise<HarnessResult<HarnessCommandAccepted>> {
    if (this.#closed) {
      return { ok: false, error: invalidState("Antigravity Session is closed") };
    }
    if (this.isActive) {
      return {
        ok: false,
        error: {
          code: "sessionBusy",
          message: "Antigravity Turn is already running",
          retryable: true,
        },
      };
    }
    const formatted = parseAndFormatAntigravityCommand(command);
    if (!formatted.ok) {
      return formatted;
    }
    if (formatted.value.descriptor.invocation === "/compact" && !this.#nativeRef) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Antigravity context compaction requires an active conversation",
          retryable: false,
        },
      };
    }
    const started = await this.execute({
      type: "turn.start",
      turnId: command.turnId,
      input: [{ type: "text", text: formatted.value.prompt }],
    });
    if (!started.ok) {
      return started;
    }
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#active || this.#active.command.turnId !== command.turnId) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "Antigravity Turn is not active",
          retryable: false,
        },
      };
    }
    const active = this.#active;
    active.cancellationRequested = true;
    active.questions?.stop();
    await active.subagents.cancel();
    active.process.kill();
    return { ok: true, value: { cancellationRequested: true } };
  }

  #selectModel(command: ModelSelectCommand): HarnessResult<ModelSelectCompleted> {
    this.#model = harnessModelRefSchema.parse(command.model);
    // Efforts are per-Model, so a Model that does not accept the retained
    // option must drop it rather than pass a combination the CLI rejects.
    const available = antigravityAvailableThinkingOptions(this.#catalog, this.#model);
    if (this.#thinkingOptionId && !available?.some(({ id }) => id === this.#thinkingOptionId)) {
      this.#thinkingOptionId = undefined;
    }
    this.#history.setSelection(this.#model, this.#thinkingOptionId);
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectThinking(command: ThinkingSelectCommand): HarnessResult<ThinkingSelectCompleted> {
    const requested = harnessThinkingOptionIdSchema.safeParse(command.thinkingOptionId);
    if (!requested.success) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Antigravity Thinking option is not a valid identifier",
          retryable: false,
        },
      };
    }
    const available = antigravityAvailableThinkingOptions(this.#catalog, this.#model);
    if (!available?.some(({ id }) => id === requested.data)) {
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: `Antigravity Model does not accept effort "${requested.data}"`,
          retryable: false,
        },
      };
    }
    this.#thinkingOptionId = requested.data;
    this.#history.setSelection(this.#model, this.#thinkingOptionId);
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #selectPermissionMode(
    command: PermissionModeSelectCommand,
  ): HarnessResult<PermissionModeSelectCompleted> {
    if (this.isActive) {
      return {
        ok: false,
        error: { code: "sessionBusy", message: "Turn is active", retryable: true },
      };
    }
    try {
      this.#permissionMode = decodeAntigravityPermissionModeId(command.permissionModeId);
    } catch (error) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
      };
    }
    this.#event({ type: "session.state.changed", state: this.#state() });
    return { ok: true, value: { completed: true } };
  }

  #state(): HarnessSessionState {
    const availableThinkingOptions = antigravityAvailableThinkingOptions(
      this.#catalog,
      this.#model,
    );
    return {
      ...(this.#nativeRef ? { nativeRef: this.#nativeRef } : {}),
      ...(this.#model ? { effectiveModel: this.#model } : {}),
      ...(this.#thinkingOptionId ? { effectiveThinkingOptionId: this.#thinkingOptionId } : {}),
      ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
      effectivePermissionModeId: ANTIGRAVITY_PERMISSION_MODE_CATALOG.modes.find(
        ({ id }) => id === this.#permissionMode,
      )?.id as HarnessPermissionModeId,
    };
  }

  #event(event: HostEvent): void {
    this.#channel.emit({ kind: "event", event });
  }

  #newItemId(): HostItemId {
    return hostItemIdSchema.parse(randomUUID());
  }
}

function historySubagentState(
  history: AntigravityHistory,
  id: string,
): HostSubagentState | undefined {
  for (const turn of history.snapshot().reverse()) {
    for (const { item } of [...turn.items].reverse()) {
      if (item.type !== "subagentDelegation") continue;
      const state = item.subagents.find((child) => child.nativeSubagentId === id);
      if (state) return state;
    }
  }
  return undefined;
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly commandCatalog = ANTIGRAVITY_COMMAND_CATALOG;
  readonly harnessId: HarnessId = antigravityHarnessId;
  readonly subagents = {
    readSnapshot: async (input: {
      parent: NativeSessionRef;
      nativeSubagentId: string;
      cwd: string;
    }): Promise<HarnessResult<HostThreadSnapshot>> => {
      if (
        this.#closed ||
        input.parent.harnessId !== this.harnessId ||
        !nativeSubagentIdSchema.safeParse(input.nativeSubagentId).success
      ) {
        return { ok: false, error: invalidState("Invalid Antigravity Subagent reference") };
      }
      const session = this.#findSession(input.parent.nativeSessionId);
      const history =
        session?.history ??
        (await AntigravityHistory.findByNativeSessionId(
          this.#environment,
          input.parent.nativeSessionId,
        ));
      const state =
        session?.subagentState(input.nativeSubagentId) ??
        (history ? historySubagentState(history, input.nativeSubagentId) : undefined);
      if (!state) {
        return {
          ok: false,
          error: invalidState("Subagent does not belong to this parent Session"),
        };
      }
      return readSubagentTranscript({
        parentId: input.parent.nativeSessionId,
        childId: input.nativeSubagentId,
        status: state.status,
        cwd: input.cwd,
        outputLimit: this.#toolOutputLimit,
      });
    },
  };
  readonly #command: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #inspectTimeoutMs: number;
  readonly #inspectionCache = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  readonly #inspectionInFlight = new Map<string, Promise<HarnessInspection>>();
  readonly #printTimeout: string;
  readonly #sessions = new Set<AntigravitySession>();
  readonly #toolOutputLimit: number;
  readonly #subagentObservationTimeoutMs: number;
  #closed = false;
  #quota: AntigravityQuotaSnapshot | null = null;
  #quotaCwd: string | null = null;
  #quotaRefresh: Promise<AntigravityQuotaSnapshot | null> | null = null;
  readonly #quotaAbort = new AbortController();

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    this.#printTimeout = options.printTimeout ?? DEFAULT_PRINT_TIMEOUT;
    this.#toolOutputLimit = options.toolOutputLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT;
    const subagentObservationTimeoutMs =
      options.subagentObservationTimeoutMs ?? DEFAULT_SUBAGENT_OBSERVATION_TIMEOUT_MS;
    if (!Number.isFinite(subagentObservationTimeoutMs) || subagentObservationTimeoutMs <= 0) {
      throw new RangeError("subagentObservationTimeoutMs must be a finite positive number");
    }
    this.#subagentObservationTimeoutMs = subagentObservationTimeoutMs;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight) return inFlight;
    if (!input.refresh) {
      const cached = this.#inspectionCache.get(cwd);
      if (cached) return cached;
    }

    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") {
        this.#inspectionCache.set(cwd, result);
        this.#quotaCwd = cwd;
        void this.refreshCredits().catch(() => undefined);
      }
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }

  async #inspectCwd(cwd: string): Promise<HarnessInspection> {
    const executable = resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false,
        },
      };
    }
    try {
      const { stdout } = await runBuffered(
        executable,
        ["models"],
        cwd,
        this.#environment,
        this.#inspectTimeoutMs,
      );
      return {
        status: "ready",
        catalog: parseAntigravityModels(stdout),
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: CAPABILITIES,
      };
    } catch (error) {
      const message = errorMessage(error);
      const normalized = normalizedProcessError(message, message);
      return {
        status: "error",
        error: { ...normalized, stage: "model-catalog" },
      };
    }
  }

  async inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    // The native /usage command resolves authentication itself. Never fall back
    // to the last quota observation when authentication has changed or failed.
    const snapshot = await this.refreshCredits();
    if (!snapshot) return null;
    return {
      credits: {
        ...(snapshot.label ? { label: snapshot.label } : {}),
        ...(snapshot.scope ? { scope: snapshot.scope } : {}),
        usedPercent: snapshot.usedPercent,
        periodType: snapshot.periodType,
        ...(snapshot.resetsAt ? { resetsAt: snapshot.resetsAt } : {}),
        ...(snapshot.productUsage ? { productUsage: [...snapshot.productUsage] } : {}),
      },
    };
  }

  /** Public account telemetry cache; never attributes quota to historical Thread spend. */
  credits(): AntigravityQuotaSnapshot | null {
    return this.#quota;
  }

  refreshCredits(): Promise<AntigravityQuotaSnapshot | null> {
    if (this.#quotaRefresh) return this.#quotaRefresh;
    this.#quotaRefresh = this.#loadQuota().finally(() => {
      this.#quotaRefresh = null;
    });
    return this.#quotaRefresh;
  }

  async #loadQuota(): Promise<AntigravityQuotaSnapshot | null> {
    if (this.#closed) return null;
    const executable = resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) return null;
    const cwd = this.#quotaCwd ?? process.cwd();
    const snapshot = await fetchAntigravityQuota(async (arguments_) => {
      const { stdout } = await runBuffered(
        executable,
        [...arguments_],
        cwd,
        this.#environment,
        Math.min(this.#inspectTimeoutMs, 10_000),
        this.#quotaAbort.signal,
      );
      return stdout;
    });
    if (snapshot) this.#quota = snapshot;
    return snapshot;
  }

  #findSession(nativeSessionId: string): AntigravitySession | undefined {
    for (const session of this.#sessions) {
      if (session.nativeRef?.nativeSessionId === nativeSessionId) {
        return session;
      }
    }
    return undefined;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return { ok: false, error: invalidState("Antigravity Adapter is closed") };
    let permissionMode: AntigravityPermissionMode = "dangerously-skip-permissions";
    if (input.kind !== "fork" && input.permissionModeId) {
      try {
        permissionMode = decodeAntigravityPermissionModeId(input.permissionModeId);
      } catch (error) {
        return {
          ok: false,
          error: { code: "invalidRequest", message: errorMessage(error), retryable: false },
        };
      }
    }
    if (!input.cwd) {
      return {
        ok: false,
        error: { code: "invalidRequest", message: "Antigravity requires cwd", retryable: false },
      };
    }
    const executable = resolveAntigravityExecutable({
      ...(this.#command ? { command: this.#command } : {}),
      environment: this.#environment,
    });
    if (!executable) {
      return {
        ok: false,
        error: {
          code: "notInstalled",
          message: "Antigravity CLI is not installed",
          retryable: false,
        },
      };
    }
    const cwd = path.resolve(input.cwd);
    let catalog = this.#inspectionCache.get(cwd)?.catalog;
    if (!catalog) {
      const inspection = await this.inspect({ cwd: input.cwd });
      if (inspection.status === "ready") catalog = inspection.catalog;
    }

    if (input.kind === "fork") {
      const sourceSession = this.#findSession(input.sourceRef.nativeSessionId);
      return forkAntigravitySession({
        harnessId: this.harnessId,
        input,
        adapterEnvironment: this.#environment,
        ...(sourceSession
          ? {
              sourceSession: {
                history: sourceSession.history,
                model: sourceSession.model,
                thinkingOptionId: sourceSession.thinkingOptionId,
                permissionMode: sourceSession.permissionMode,
                isActive: sourceSession.isActive,
              },
            }
          : {}),
        createSession: (params) => {
          const session = new AntigravitySession({
            ...(catalog ? { catalog } : {}),
            cwd: params.cwd,
            environment: params.environment,
            executable,
            history: params.history,
            ...(params.model ? { model: params.model } : {}),
            nativeRef: params.nativeRef,
            permissionMode: params.permissionMode,
            printTimeout: this.#printTimeout,
            ...(params.thinkingOptionId ? { thinkingOptionId: params.thinkingOptionId } : {}),
            toolOutputLimit: this.#toolOutputLimit,
            subagentObservationTimeoutMs: this.#subagentObservationTimeoutMs,
            onClosed: () => this.#sessions.delete(session),
          });
          this.#sessions.add(session);
          return session;
        },
      });
    }

    if (input.kind === "rollbackLastTurn") {
      const sourceSession = this.#findSession(input.sourceRef.nativeSessionId);
      return rollbackAntigravityLastTurn({
        harnessId: this.harnessId,
        input,
        adapterEnvironment: this.#environment,
        ...(sourceSession
          ? {
              sourceSession: {
                history: sourceSession.history,
                model: sourceSession.model,
                thinkingOptionId: sourceSession.thinkingOptionId,
                permissionMode: sourceSession.permissionMode,
                isActive: sourceSession.isActive,
              },
            }
          : {}),
        createSession: (params) => {
          const session = new AntigravitySession({
            ...(catalog ? { catalog } : {}),
            cwd: params.cwd,
            environment: params.environment,
            executable,
            history: params.history,
            ...(params.model ? { model: params.model } : {}),
            nativeRef: params.nativeRef,
            permissionMode: params.permissionMode,
            printTimeout: this.#printTimeout,
            ...(params.thinkingOptionId ? { thinkingOptionId: params.thinkingOptionId } : {}),
            toolOutputLimit: this.#toolOutputLimit,
            subagentObservationTimeoutMs: this.#subagentObservationTimeoutMs,
            onClosed: () => this.#sessions.delete(session),
          });
          this.#sessions.add(session);
          return session;
        },
      });
    }

    let nativeRef: NativeSessionRef | undefined;
    if (input.kind === "resume") {
      nativeRef = nativeSessionRefSchema.parse(input.nativeRef);
      if (nativeRef.harnessId !== this.harnessId) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: "Antigravity cannot resume another Harness Session",
            retryable: false,
          },
        };
      }
    }
    const sessionEnvironment = { ...this.#environment, ...(input.environment ?? {}) };
    const history = await AntigravityHistory.open({
      environment: sessionEnvironment,
      ...(nativeRef ? { nativeSessionId: nativeRef.nativeSessionId } : {}),
      ...(input.kind === "resume" && input.knownTurnRefs
        ? { knownTurnRefs: input.knownTurnRefs }
        : {}),
    });
    const model = (input.kind === "create" ? input.model : undefined) ?? history.model;
    const thinkingOptionId =
      (input.kind === "create" ? input.thinkingOptionId : undefined) ?? history.thinkingOptionId;
    // `thread/start` reaches open() directly, so an effort the Model does not
    // accept has to be refused here; otherwise the CLI only rejects the
    // resulting `--effort` once the first Turn runs.
    if (thinkingOptionId) {
      const available = antigravityAvailableThinkingOptions(catalog, model);
      if (!available?.some(({ id }) => id === thinkingOptionId)) {
        return {
          ok: false,
          error: {
            code: "invalidRequest",
            message: `Antigravity Model does not accept effort "${thinkingOptionId}"`,
            retryable: false,
          },
        };
      }
    }
    if (model || thinkingOptionId) history.setSelection(model, thinkingOptionId);
    const session = new AntigravitySession({
      ...(catalog ? { catalog } : {}),
      cwd: input.cwd,
      environment: sessionEnvironment,
      executable,
      history,
      ...(model ? { model } : {}),
      ...(nativeRef ? { nativeRef } : {}),
      permissionMode,
      printTimeout: this.#printTimeout,
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      toolOutputLimit: this.#toolOutputLimit,
      subagentObservationTimeoutMs: this.#subagentObservationTimeoutMs,
      onClosed: () => this.#sessions.delete(session),
    });
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inspectionCache.clear();
    this.#quota = null;
    this.#quotaCwd = null;
    this.#quotaAbort.abort();
    await Promise.all([...this.#sessions].map((session) => session.close()));
  }
}
