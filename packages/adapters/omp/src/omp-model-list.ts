import { spawn } from "node:child_process";
import { commandInvocation } from "@codexhost/harness-discovery";
import { resolveOmpExecutable, withNodeRuntimeOnPath } from "./command.js";
import type { OmpNativeModel } from "./omp-model-catalog.js";
import { signalProcessTree } from "./omp-rpc-session.js";

const OMP_MODEL_LIST_TIMEOUT_MS = 15_000;
const OMP_MODEL_LIST_OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface OmpModelListInput {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  /** Aborting stops the command and resolves `unanswered`. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `models` carries the native catalog. `unanswered` means this OMP could not list models without
 * a Session (an older release, or a failing installation); the caller then inspects through a
 * Session, which also reports the native startup error.
 */
export type OmpModelListResult =
  | { kind: "models"; models: readonly OmpNativeModel[] }
  | { kind: "notInstalled"; message: string }
  | { kind: "timedOut" }
  | { kind: "unanswered" };

/**
 * Lists the Models with `omp models --json`. This command builds only the Model registry: it starts
 * no agent Session, so Session startup work such as Provider connection prewarm, MCP servers or LSP
 * warmup does not run. On a cold Model cache OMP may still fetch Provider Model lists.
 */
export function listOmpModels(input: OmpModelListInput): Promise<OmpModelListResult> {
  const environment = withNodeRuntimeOnPath({
    ...process.env,
    ...input.environment,
    OMP_SKIP_VERSION_CHECK: "1",
    OMP_TELEMETRY: "0",
  });
  const executable = resolveOmpExecutable({
    ...(input.command ? { command: input.command } : {}),
    environment,
  });
  const invocation = commandInvocation(executable, ["models", "--json"], environment);
  return new Promise((resolve) => {
    if (input.signal?.aborted) return resolve({ kind: "unanswered" });
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: input.cwd,
      env: environment,
      // A process group lets a stop reach OMP and its descendants, not only a launcher shim.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let settled = false;
    let stdout = "";
    const finish = (result: OmpModelListResult, stop = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeAllListeners("data");
      if (stop) {
        child.stdout.destroy();
        try {
          signalProcessTree(child, "SIGKILL");
        } catch {
          // The tree may already be gone; the result does not depend on it.
        }
      }
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "unanswered" }, true);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish({ kind: "timedOut" }, true),
      input.timeoutMs ?? OMP_MODEL_LIST_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > OMP_MODEL_LIST_OUTPUT_LIMIT) finish({ kind: "unanswered" }, true);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? { kind: "notInstalled", message: "Oh My Pi (omp) is not installed" }
          : { kind: "unanswered" },
      );
    });
    child.once("close", (code) => {
      if (code !== 0) return finish({ kind: "unanswered" });
      const models = parseOmpModelList(stdout);
      finish(models ? { kind: "models", models } : { kind: "unanswered" });
    });
  });
}

/** Returns null for output that is not the `models --json` shape. */
export function parseOmpModelList(output: string): OmpNativeModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const models: OmpNativeModel[] = [];
  for (const model of parsed.models) {
    if (
      !isRecord(model) ||
      !nonBlankString(model.provider) ||
      !nonBlankString(model.id) ||
      typeof model.reasoning !== "boolean"
    ) {
      return null;
    }
    models.push({ provider: model.provider, id: model.id, reasoning: model.reasoning });
  }
  return models;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
