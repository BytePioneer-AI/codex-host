import type { Writable } from "node:stream";

import { delegationCliHelp, type DelegationCliCommand } from "./delegation-cli-help.js";
import { compactDelegationOutput } from "./delegation-cli-output.js";

export { DELEGATION_HELP } from "./delegation-cli-help.js";

import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  DelegationControlError,
  type DelegationControlErrorCode,
} from "./delegation-types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function normalizeThreadId(value: string): string {
  const prefix = "codex://threads/";
  const normalized = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!normalized || normalized.includes("/") || normalized.includes("?")) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
  }
  return normalized;
}

function positiveInteger(value: string | undefined, name: string, maximum?: number): number {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number) || number <= 0 || (maximum && number > maximum)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`,
    );
  }
  return number;
}

function options(arguments_: readonly string[]): {
  positionals: string[];
  options: Map<string, string>;
} {
  const positionals: string[] = [];
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (parsed.has(argument))
      throw new DelegationControlError("INVALID_ARGUMENT", `${argument} may only be provided once`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--"))
      throw new DelegationControlError("INVALID_ARGUMENT", `${argument} requires a value`);
    parsed.set(argument, value);
    index += 1;
  }
  return { positionals, options: parsed };
}

function value(parsed: ReturnType<typeof options>, name: string): string | undefined {
  return parsed.options.get(name);
}

function rejectUnknown(parsed: ReturnType<typeof options>, allowed: readonly string[]): void {
  const known = new Set([...allowed, "--format"]);
  for (const name of parsed.options.keys()) {
    if (!known.has(name))
      throw new DelegationControlError("INVALID_ARGUMENT", `Unknown option '${name}'`);
  }
}

async function requestRuntime(input: {
  environment: NodeJS.ProcessEnv;
  path: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const endpoint = input.environment[DELEGATION_RUNTIME_ENDPOINT_ENV];
  const token = input.environment[DELEGATION_RUNTIME_TOKEN_ENV];
  if (!endpoint || !token) {
    const missingEnvironmentVariables = [
      ...(!endpoint ? [DELEGATION_RUNTIME_ENDPOINT_ENV] : []),
      ...(!token ? [DELEGATION_RUNTIME_TOKEN_ENV] : []),
    ];
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      `${missingEnvironmentVariables.join(" and ")} ${missingEnvironmentVariables.length === 1 ? "is" : "are"} required. If this command runs inside native Codex, shell_environment_policy may have filtered the Host-provided CODEXHOST_* variables. Prefer inherit = "all" with ignore_default_excludes = true and a narrow include_only allowlist that contains "CODEXHOST_RUNTIME_ENDPOINT" and "CODEXHOST_RUNTIME_TOKEN" plus the variables required by the platform and invoked tools; do not use unconstrained inherit = "all".`,
      {
        reason: "missing_runtime_environment",
        missingEnvironmentVariables,
        nativeCodexRecovery: {
          recommendedPolicy: {
            inherit: "all",
            ignoreDefaultExcludes: true,
            includeOnlyMustContain: [DELEGATION_RUNTIME_ENDPOINT_ENV, DELEGATION_RUNTIME_TOKEN_ENV],
          },
        },
      },
    );
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(new URL(input.path, endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input.body),
    });
  } catch (error) {
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      "Host Runtime could not be reached. If this command runs inside native Codex, use a session sandbox that permits local Runtime connections or run the command explicitly outside the sandbox.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const body = (await response.json()) as {
    error?: { code?: unknown; message?: unknown; details?: unknown };
  };
  if (!response.ok || body.error) {
    const code = typeof body.error?.code === "string" ? body.error.code : "INTERNAL_ERROR";
    const message =
      typeof body.error?.message === "string" ? body.error.message : "Runtime request failed";
    throw new DelegationControlError(
      code as DelegationControlErrorCode,
      message,
      body.error?.details as Record<string, unknown> | undefined,
    );
  }
  return body;
}

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runDelegationCli(input: {
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output?: Writable;
  diagnosticOutput?: Writable;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const output = input.output ?? process.stdout;
  const diagnosticOutput = input.diagnosticOutput ?? process.stderr;
  const environment = input.environment ?? process.env;
  try {
    const [group, command, ...rest] = input.arguments;
    const help = delegationCliHelp(input.arguments);
    if (help !== undefined) {
      output.write(help);
      return 0;
    }
    const parsed = options(rest);
    const format = value(parsed, "--format") ?? "json";
    if (format !== "json" && format !== "compact") {
      throw new DelegationControlError("INVALID_ARGUMENT", "--format must be json or compact");
    }
    const writeResult = (
      name: DelegationCliCommand,
      body: unknown,
      view: "result" | "messages" = "result",
    ): void =>
      writeJson(output, format === "json" ? body : compactDelegationOutput(name, body, view));
    if (group === "harness" && command === "list") {
      rejectUnknown(parsed, []);
      if (parsed.positionals.length > 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "harness list accepts no positional arguments",
        );
      }
      writeResult(
        "harness list",
        await requestRuntime({
          environment,
          path: "/v1/harness/list",
          body: {},
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "harness" && command === "inspect") {
      rejectUnknown(parsed, ["--cwd", "--refresh"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "harness inspect requires one Harness identifier",
        );
      }
      const harnessId = parsed.positionals[0];
      if (!harnessId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Harness identifier is required");
      }
      const refresh = value(parsed, "--refresh");
      if (refresh !== undefined && refresh !== "true" && refresh !== "false") {
        throw new DelegationControlError("INVALID_ARGUMENT", "--refresh must be true or false");
      }
      writeResult(
        "harness inspect",
        await requestRuntime({
          environment,
          path: "/v1/harness/inspect",
          body: {
            harnessId,
            ...(value(parsed, "--cwd") ? { cwd: value(parsed, "--cwd") } : {}),
            ...(refresh !== undefined ? { refresh: refresh === "true" } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "delegate" && command === "start") {
      rejectUnknown(parsed, [
        "--harness",
        "--task",
        "--cwd",
        "--model",
        "--thinking",
        "--parent-thread",
        "--request-id",
      ]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "delegate start accepts no positional arguments",
        );
      const harnessId = value(parsed, "--harness");
      const task = value(parsed, "--task");
      if (!harnessId || !task)
        throw new DelegationControlError("INVALID_ARGUMENT", "--harness and --task are required");
      const parentThread =
        value(parsed, "--parent-thread") ?? environment[DELEGATION_THREAD_ID_ENV];
      writeResult(
        "delegate start",
        await requestRuntime({
          environment,
          path: "/v1/delegate/start",
          body: {
            harnessId,
            task,
            ...(value(parsed, "--cwd") ? { cwd: value(parsed, "--cwd") } : {}),
            ...(value(parsed, "--model") ? { model: { id: value(parsed, "--model") } } : {}),
            ...(value(parsed, "--thinking")
              ? { thinkingOptionId: value(parsed, "--thinking") }
              : {}),
            ...(parentThread ? { parentThreadId: normalizeThreadId(parentThread) } : {}),
            ...(value(parsed, "--request-id") ? { requestId: value(parsed, "--request-id") } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "send") {
      rejectUnknown(parsed, ["--message"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread send requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      const message = value(parsed, "--message");
      if (!threadId || !message?.trim()) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Thread identifier and --message are required",
        );
      }
      writeResult(
        "thread send",
        await requestRuntime({
          environment,
          path: "/v1/thread/send",
          body: { threadId: normalizeThreadId(threadId), message },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "cancel") {
      rejectUnknown(parsed, []);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread cancel requires one Thread identifier",
        );
      }
      const threadId = parsed.positionals[0];
      if (!threadId) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      writeResult(
        "thread cancel",
        await requestRuntime({
          environment,
          path: "/v1/thread/cancel",
          body: { threadId: normalizeThreadId(threadId) },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && (command === "read" || command === "wait")) {
      rejectUnknown(parsed, ["--view", "--cursor", "--limit", "--timeout-ms"]);
      if (parsed.positionals.length !== 1)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `thread ${command} requires one Thread identifier`,
        );
      const view = value(parsed, "--view") ?? "result";
      if (view !== "result" && view !== "messages")
        throw new DelegationControlError("INVALID_ARGUMENT", "--view must be result or messages");
      if (view === "result" && (value(parsed, "--cursor") || value(parsed, "--limit")))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--cursor and --limit require --view messages",
        );
      if (command === "read" && value(parsed, "--timeout-ms"))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--timeout-ms is valid only for thread wait",
        );
      const threadId = parsed.positionals[0];
      if (!threadId)
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      const body = {
        threadId: normalizeThreadId(threadId),
        view,
        ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
        ...(value(parsed, "--limit")
          ? { limit: positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT) }
          : {}),
        ...(command === "wait"
          ? {
              timeoutMs: value(parsed, "--timeout-ms")
                ? positiveInteger(value(parsed, "--timeout-ms"), "--timeout-ms")
                : DEFAULT_WAIT_TIMEOUT_MS,
            }
          : {}),
      };
      writeResult(
        command === "read" ? "thread read" : "thread wait",
        await requestRuntime({
          environment,
          path: command === "read" ? "/v1/thread/read" : "/v1/thread/wait",
          body,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
        view,
      );
      return 0;
    }
    if (group === "thread" && command === "list") {
      rejectUnknown(parsed, ["--cwd", "--parent", "--limit", "--cursor", "--sort"]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread list accepts no positional arguments",
        );
      const sort = value(parsed, "--sort") ?? "created-desc";
      if (
        !new Set([
          "created-asc",
          "created-desc",
          "updated-asc",
          "updated-desc",
          "recency-asc",
          "recency-desc",
        ]).has(sort)
      )
        throw new DelegationControlError("INVALID_ARGUMENT", "--sort is invalid");
      const parentThread = value(parsed, "--parent");
      writeResult(
        "thread list",
        await requestRuntime({
          environment,
          path: "/v1/thread/list",
          body: {
            cwd: value(parsed, "--cwd") ?? process.cwd(),
            ...(parentThread ? { parentThreadId: normalizeThreadId(parentThread) } : {}),
            limit: value(parsed, "--limit")
              ? positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT)
              : DEFAULT_LIMIT,
            ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
            sort,
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Unknown delegation command. Run 'codexhost delegate --help'.",
    );
  } catch (error) {
    const normalized =
      error instanceof DelegationControlError
        ? error
        : new DelegationControlError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          );
    writeJson(diagnosticOutput, {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    });
    return 1;
  }
}
