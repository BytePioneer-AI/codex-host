import { spawn, type ChildProcess } from "node:child_process";

import { filterAmbientNodeWarnings, sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

import {
  deepSeekProcessInvocation,
  killDeepSeekProcessTree,
  resolveDeepSeekCommand,
  type DeepSeekCommandInvocation,
} from "./executable.js";

export type DeepSeekProtocolGeneration = "modern";

export type DeepSeekSupportedVersion = "0.1.2-rc.1" | "0.1.5-rc.1" | "0.1.5-rc.2";

export interface DeepSeekExecutableGeneration {
  readonly generation: DeepSeekProtocolGeneration;
  readonly version: DeepSeekSupportedVersion;
  readonly command: DeepSeekCommandInvocation;
}

export type DeepSeekGenerationProbeErrorCode =
  | "authenticationRequired"
  | "notInstalled"
  | "unavailable"
  | "protocolError"
  | "processExited"
  | "unsupported"
  | "cancelled";

export class DeepSeekGenerationProbeError extends Error {
  readonly retryable: boolean;
  readonly cleanupFailed: boolean;
  readonly stderrTail?: string;

  constructor(
    readonly code: DeepSeekGenerationProbeErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly retryable?: boolean;
      readonly cleanupFailed?: boolean;
      readonly stderrTail?: string;
    },
  ) {
    super(message, options);
    this.name = "DeepSeekGenerationProbeError";
    this.retryable = options?.retryable ?? (code === "unavailable" || code === "processExited");
    this.cleanupFailed = options?.cleanupFailed ?? false;
    if (options?.stderrTail !== undefined) this.stderrTail = options.stderrTail;
  }
}

export interface ProbeDeepSeekGenerationOptions {
  readonly command?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly outputLimitBytes?: number;
}

export interface DeepSeekGenerationProbeDependencies {
  spawn(
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      detached: boolean;
      stdio: "pipe";
      windowsHide: true;
      windowsVerbatimArguments?: boolean;
    },
  ): ChildProcess;
  terminateProcessTree(child: ChildProcess, timeoutMs: number): void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const DIAGNOSTIC_RAW_TAIL_BYTES = 16 * 1024;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const NUMERIC_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_IDENTIFIER = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN = new RegExp(
  String.raw`^${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}\.${NUMERIC_IDENTIFIER}` +
    String.raw`(?:-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?` +
    String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
  "u",
);

function probeError(
  code: DeepSeekGenerationProbeErrorCode,
  message: string,
  options?: ErrorOptions & {
    readonly retryable?: boolean;
    readonly cleanupFailed?: boolean;
    readonly stderrTail?: string;
  },
): DeepSeekGenerationProbeError {
  return new DeepSeekGenerationProbeError(code, message, options);
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function positiveSafeInteger(
  value: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${String(maximum)}`,
    );
  }
  return value;
}

function singleOutputLine(output: string): string | null {
  let line = output;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  return line.length > 0 && !line.includes("\r") && !line.includes("\n") ? line : null;
}

export function classifyDeepSeekVersionOutput(
  output: string,
): Pick<DeepSeekExecutableGeneration, "generation" | "version"> {
  const version = singleOutputLine(output);
  if (version === null || !SEMVER_PATTERN.test(version)) {
    throw probeError(
      "protocolError",
      "DeepSeek Harness --version did not return exactly one semantic version",
    );
  }
  if (version === "0.1.2-rc.1" || version === "0.1.5-rc.1" || version === "0.1.5-rc.2") {
    return { generation: "modern", version };
  }
  throw probeError(
    "unsupported",
    `当前 DeepSeek Harness 版本 ${version} 不受支持；codexhost 仅支持 dsh-v0.1.2-rc.1、dsh-v0.1.5-rc.1 和 dsh-v0.1.5-rc.2，推荐安装 dsh-v0.1.5-rc.2。\nDeepSeek Harness ${version} is unsupported. codexhost only supports dsh-v0.1.2-rc.1, dsh-v0.1.5-rc.1 and dsh-v0.1.5-rc.2; dsh-v0.1.5-rc.2 is recommended.`,
  );
}

interface CapturedVersionOutput {
  readonly stdout: string;
  readonly stderr: string;
}

interface OutputBuffer {
  readonly chunks: Buffer[];
  bytes: number;
}

interface VersionProcessFailure {
  readonly error: DeepSeekGenerationProbeError;
  readonly requiresCleanup: boolean;
}

function appendOutput(target: OutputBuffer, value: unknown, limit: number): boolean {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (target.bytes + chunk.byteLength > limit) return false;
  target.chunks.push(chunk);
  target.bytes += chunk.byteLength;
  return true;
}

function capturedText(output: OutputBuffer): string {
  return Buffer.concat(output.chunks, output.bytes).toString("utf8");
}

async function terminateVersionProcess(
  child: ChildProcess,
  closed: Promise<void>,
  cleanupTimeoutMs: number,
  dependencies: Pick<DeepSeekGenerationProbeDependencies, "terminateProcessTree">,
): Promise<Error | null> {
  const deadline = Date.now() + cleanupTimeoutMs;
  const failures: Error[] = [];
  try {
    dependencies.terminateProcessTree(child, cleanupTimeoutMs);
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }
  const remaining = Math.max(0, deadline - Date.now());
  const closedInTime = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), remaining);
    void closed.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (!closedInTime) {
    failures.push(
      new Error("DeepSeek Harness version process did not close within cleanup bounds"),
    );
  }
  return failures.length === 0
    ? null
    : new AggregateError(failures, "DeepSeek Harness version process cleanup failed");
}

async function captureVersionOutput(
  child: ChildProcess,
  input: {
    readonly invocationKind: DeepSeekCommandInvocation["kind"];
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly cleanupTimeoutMs: number;
    readonly outputLimitBytes: number;
  },
  dependencies: Pick<DeepSeekGenerationProbeDependencies, "terminateProcessTree">,
): Promise<CapturedVersionOutput> {
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  const stdout: OutputBuffer = { chunks: [], bytes: 0 };
  const stderr: OutputBuffer = { chunks: [], bytes: 0 };
  let stderrDiagnosticTail = "";
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const lifetime = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let closeObserved = false;
  let resolveClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let cleanup = (): void => undefined;

  const capture = new Promise<CapturedVersionOutput>((resolve, reject) => {
    let finished = false;
    const rejectOnce = (error: DeepSeekGenerationProbeError, requiresCleanup: boolean): void => {
      if (finished) return;
      finished = true;
      reject({ error, requiresCleanup } satisfies VersionProcessFailure);
    };
    const append = (target: OutputBuffer, value: unknown): void => {
      if (finished || appendOutput(target, value, input.outputLimitBytes)) return;
      rejectOnce(
        probeError("protocolError", "DeepSeek Harness --version exceeded the bounded output limit"),
        true,
      );
    };
    const onStdout = (value: unknown): void => append(stdout, value);
    const onStderr = (value: unknown): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      stderrDiagnosticTail = `${stderrDiagnosticTail}${chunk
        .subarray(Math.max(0, chunk.byteLength - DIAGNOSTIC_RAW_TAIL_BYTES))
        .toString("utf8")}`.slice(-DIAGNOSTIC_RAW_TAIL_BYTES);
      append(stderr, value);
    };
    const onError = (error: Error): void => {
      rejectOnce(
        isMissingExecutableError(error)
          ? probeError("notInstalled", "DeepSeek Harness executable is not installed")
          : probeError("processExited", "DeepSeek Harness --version could not start"),
        false,
      );
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      closeObserved = true;
      resolveClosed();
      if (finished) return;
      finished = true;
      if (code !== 0) {
        reject({
          error:
            input.invocationKind === "npx"
              ? probeError("notInstalled", "DeepSeek Harness package is not installed")
              : probeError(
                  "processExited",
                  `DeepSeek Harness --version exited ${
                    signal ? `with signal ${signal}` : `with code ${String(code)}`
                  }`,
                ),
          requiresCleanup: false,
        } satisfies VersionProcessFailure);
        return;
      }
      resolve({ stdout: capturedText(stdout), stderr: capturedText(stderr) });
    };
    const onAbort = (): void => {
      rejectOnce(
        input.signal?.aborted
          ? probeError("cancelled", "DeepSeek Harness version probe was cancelled")
          : probeError("unavailable", "DeepSeek Harness version probe timed out"),
        true,
      );
    };

    cleanup = (): void => {
      childStdout?.off("data", onStdout);
      childStderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      lifetime.removeEventListener("abort", onAbort);
    };

    childStdout?.on("data", onStdout);
    childStderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    lifetime.addEventListener("abort", onAbort, { once: true });
    if (!childStdout || !childStderr) {
      rejectOnce(
        probeError("protocolError", "DeepSeek Harness --version did not expose piped output"),
        true,
      );
    } else if (lifetime.aborted) {
      onAbort();
    }
  });

  try {
    return await capture;
  } catch (value) {
    const failure = value as VersionProcessFailure;
    const stderrTail = sanitizeDiagnosticTail(stderrDiagnosticTail);
    if (!failure.requiresCleanup) {
      if (!stderrTail) throw failure.error;
      throw probeError(failure.error.code, failure.error.message, {
        cause: failure.error.cause,
        retryable: failure.error.retryable,
        stderrTail,
      });
    }
    const cleanupError = await terminateVersionProcess(
      child,
      closeObserved ? Promise.resolve() : closed,
      input.cleanupTimeoutMs,
      dependencies,
    );
    if (cleanupError) {
      throw probeError(
        "processExited",
        "DeepSeek Harness version probe failed and its process cleanup did not complete",
        {
          cause: new AggregateError([failure.error, cleanupError]),
          cleanupFailed: true,
          retryable: false,
          ...(stderrTail ? { stderrTail } : {}),
        },
      );
    }
    if (!stderrTail) throw failure.error;
    throw probeError(failure.error.code, failure.error.message, {
      cause: failure.error.cause,
      retryable: failure.error.retryable,
      stderrTail,
    });
  } finally {
    cleanup();
  }
}

export async function probeDeepSeekExecutableGeneration(
  options: ProbeDeepSeekGenerationOptions = {},
  dependencies: DeepSeekGenerationProbeDependencies = {
    spawn: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    terminateProcessTree: (child, timeoutMs) =>
      killDeepSeekProcessTree(child, process.platform, timeoutMs),
  },
): Promise<DeepSeekExecutableGeneration> {
  if (options.signal?.aborted) {
    throw probeError("cancelled", "DeepSeek Harness version probe was cancelled");
  }
  const timeoutMs = positiveSafeInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    MAX_TIMER_MILLISECONDS,
  );
  const cleanupTimeoutMs = positiveSafeInteger(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    "cleanupTimeoutMs",
    MAX_TIMER_MILLISECONDS,
  );
  const outputLimitBytes = positiveSafeInteger(
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    "outputLimitBytes",
  );
  const environment = options.environment ?? process.env;
  const command = resolveDeepSeekCommand(options.command, environment);
  if (!command) {
    throw probeError("notInstalled", "No local DeepSeek Harness executable was found");
  }
  const invocation = deepSeekProcessInvocation(
    command.command,
    [...command.arguments, "--version"],
    environment,
  );
  let child: ChildProcess;
  try {
    child = dependencies.spawn(invocation.command, invocation.arguments, {
      env: environment,
      detached: process.platform !== "win32",
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    throw isMissingExecutableError(error)
      ? probeError("notInstalled", "DeepSeek Harness executable is not installed")
      : probeError("processExited", "DeepSeek Harness --version could not start");
  }
  const output = await captureVersionOutput(
    child,
    {
      invocationKind: command.kind,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
      cleanupTimeoutMs,
      outputLimitBytes,
    },
    dependencies,
  );
  // Node >= 22 emits `(node:PID) [UNDICI-EHPA] Warning: ...` (plus a
  // `--trace-warnings` hint line) on stderr whenever the runtime injects
  // NODE_USE_ENV_PROXY — e.g. the macOS broker enables it while a system
  // proxy is active. Those lines carry no harness signal, so only stderr
  // that survives filtering counts as unexpected.
  const substantiveStderr = filterAmbientNodeWarnings(output.stderr);
  if (substantiveStderr.length > 0) {
    throw probeError("protocolError", "DeepSeek Harness --version wrote unexpected stderr", {
      stderrTail: sanitizeDiagnosticTail(substantiveStderr),
    });
  }
  return { ...classifyDeepSeekVersionOutput(output.stdout), command };
}
