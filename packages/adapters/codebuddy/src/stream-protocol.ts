import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

/**
 * Typed view of the CodeBuddy CLI `--output-format stream-json` frames. The
 * stream mirrors the Claude Code stream-json schema: a `system/init` frame
 * carries session identity, `assistant` frames carry finalized Anthropic-style
 * messages, `stream_event` frames carry raw SSE deltas when
 * `--include-partial-messages` is enabled, and a terminal `result` frame ends
 * each turn.
 */
export interface CodeBuddyStreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface CodeBuddyModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type CodeBuddyContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };

export interface CodeBuddyAssistantMessage {
  id?: string;
  model?: string;
  role?: string;
  content?: CodeBuddyContentBlock[];
  usage?: CodeBuddyStreamUsage;
}

export interface CodeBuddyStreamFrame {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
  message?: CodeBuddyAssistantMessage;
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: CodeBuddyStreamUsage;
  modelUsage?: Record<string, CodeBuddyModelUsage>;
  _meta?: Record<string, unknown>;
}

export interface CodeBuddyInitInfo {
  sessionId: string;
  model: string | null;
  permissionMode: string | null;
}

export interface CodeBuddyTurnResult {
  outcome: "succeeded" | "failed";
  is_error: boolean;
  resultText: string;
  totalCostUsd: number | null;
  usage: CodeBuddyStreamUsage | null;
  modelUsage: Record<string, CodeBuddyModelUsage>;
  meta: Record<string, unknown> | null;
  sessionId: string | null;
}

const STDERR_TAIL_LIMIT = 8_000;

/** Builds the CLI argument list for one stream-json print session. */
export function codebuddySpawnArgs(options: {
  resumeSessionId?: string;
  model?: string;
  permissionMode?: string;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  return args;
}

/** Builds the `user` stream-json input frame for one turn. */
export function codebuddyUserFrame(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

export function parseCodeBuddyStreamFrame(line: string): CodeBuddyStreamFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const frame = value as Record<string, unknown>;
    if (typeof frame.type !== "string") return null;
    return frame as unknown as CodeBuddyStreamFrame;
  } catch {
    return null;
  }
}

export function initInfoFromFrame(frame: CodeBuddyStreamFrame): CodeBuddyInitInfo | null {
  if (frame.type !== "system" || frame.subtype !== "init" || !frame.session_id) return null;
  return {
    sessionId: frame.session_id,
    model: typeof frame.model === "string" ? frame.model : null,
    permissionMode: typeof frame.permissionMode === "string" ? frame.permissionMode : null,
  };
}

export interface CodeBuddyProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface CodeBuddySpawnOptions {
  cwd: string;
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  spawn?: SpawnDependency;
}

export type SpawnDependency = typeof spawn;

export interface CodeBuddyTransportListener {
  onFrame(frame: CodeBuddyStreamFrame): void;
  onExit(exit: CodeBuddyProcessExit): void;
}

const KILL_GRACE_MS = 1_000;

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ESRCH") child.kill(signal);
  }
}

/**
 * Owns one CodeBuddy CLI child process running in stream-json print mode.
 * Frames are dispatched line-by-line to the listener; the process stays alive
 * between turns waiting for the next `user` input frame.
 */
export class CodeBuddyStreamProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #ended = false;
  #killTimer: NodeJS.Timeout | null = null;
  readonly stderrTail = { value: "" };

  constructor(options: CodeBuddySpawnOptions, listener: CodeBuddyTransportListener) {
    const spawnFn = options.spawn ?? spawn;
    this.#child = spawnFn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf-8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newlineIndex = this.#buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.#buffer.slice(0, newlineIndex);
        this.#buffer = this.#buffer.slice(newlineIndex + 1);
        const frame = parseCodeBuddyStreamFrame(line);
        if (frame) listener.onFrame(frame);
        newlineIndex = this.#buffer.indexOf("\n");
      }
    });
    this.#child.stderr.setEncoding("utf-8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.stderrTail.value = (this.stderrTail.value + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    this.#child.on("error", (error: Error) => {
      if (this.#ended) return;
      this.#ended = true;
      if (this.#killTimer) {
        clearTimeout(this.#killTimer);
        this.#killTimer = null;
      }
      listener.onExit({
        code: null,
        signal: null,
        stderrTail: sanitizeDiagnosticTail(`${error.message}\n${this.stderrTail.value}`),
      });
    });
    this.#child.on("close", (code, signal) => {
      if (this.#ended) return;
      this.#ended = true;
      if (this.#killTimer) {
        clearTimeout(this.#killTimer);
        this.#killTimer = null;
      }
      listener.onExit({
        code,
        signal,
        stderrTail: sanitizeDiagnosticTail(this.stderrTail.value),
      });
    });
  }

  /** Writes one turn input; returns false when the process is already gone. */
  writeTurnInput(text: string): boolean {
    if (this.#ended || this.#child.stdin.destroyed) return false;
    this.#child.stdin.write(`${codebuddyUserFrame(text)}\n`);
    return true;
  }

  /** Ends stdin so a graceful exit can happen once the active turn settles. */
  endInput(): void {
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
  }

  /** Terminates the child; idempotent. */
  kill(): void {
    if (this.#ended) return;
    if (this.#killTimer) return;
    signalProcessTree(this.#child, "SIGTERM");
    this.#killTimer = setTimeout(() => {
      if (!this.#ended) signalProcessTree(this.#child, "SIGKILL");
    }, KILL_GRACE_MS);
    this.#killTimer.unref();
  }
}
