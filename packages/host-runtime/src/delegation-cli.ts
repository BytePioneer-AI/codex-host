import type { JsonValue } from "@codexhost/protocol-core";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { delegationCliHelp, type DelegationCliCommand } from "./delegation-cli-help.js";
import {
  parseDelegationArguments,
  parseDelegationTurnRange,
  type DelegationCliArguments,
} from "./delegation-cli-options.js";
import { compactDelegationOutput, jsonDelegationOutput } from "./delegation-cli-output.js";
import { resolveCliTextInput } from "./delegation-cli-text-input.js";
import { startWithDelegationWorktree } from "./delegation-worktree.js";
import { assertDelegationTextCommand, textDelegationOutput } from "./delegation-cli-text.js";
import { resolveRuntimeConnection, usesExternalClient } from "./delegation-runtime-connection.js";
import { runClientCommand } from "./external-client-cli.js";
import { originClientName } from "./external-client-origin.js";
import { isRemoteHostId, isRemotePeerHostId } from "./remote-peer-delegation.js";

export { DELEGATION_HELP } from "./delegation-cli-help.js";

import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_SORT,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_WATCH_TIMEOUT_MS,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_THREAD_ID_ENV,
  NATIVE_CODEX_THREAD_ID_ENV,
  DelegationControlError,
  type DelegationControlErrorCode,
} from "./delegation-types.js";

// Node's fetch abandons a request that sends no response headers for 300 s, so
// longer waits are split into Runtime requests that each answer well before then.
const MAX_WAIT_REQUEST_MS = 240_000;
const EVENT_FOLLOW_POLL_MS = 55_000;
const MAX_LIMIT = 100;

function normalizeThreadId(value: string): string {
  const prefix = "codex://threads/";
  const normalized = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!normalized || normalized.includes("/") || normalized.includes("?")) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is invalid");
  }
  return normalized;
}

function readThreadReference(value: string): { threadId: string; hostId?: string } {
  if (!value.startsWith("thread://")) return { threadId: normalizeThreadId(value) };
  const match = /^thread:\/\/([^/?#]+)(?:\?hostId=([^&#]+))?$/u.exec(value);
  if (!match?.[1])
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread reference is invalid");
  return {
    threadId: normalizeThreadId(match[1]),
    ...(match[2] ? { hostId: decodeHostId(match[2]) } : {}),
  };
}

function decodeHostId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread reference is invalid");
  }
}

function positiveInteger(value: string | undefined, name: string, maximum?: number): number {
  const number = value && /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number <= 0 || (maximum && number > maximum)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`,
    );
  }
  return number;
}

/** Load the existing reply result; its owner interprets and validates it. */
function questionReply(source: string, path: string): JsonValue {
  try {
    return JSON.parse(source) as JsonValue;
  } catch (error) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Answers file '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function value(parsed: DelegationCliArguments, name: string): string | undefined {
  return parsed.options.get(name);
}

function assertRemotePeerHostOption(hostId: string | undefined): void {
  if (isRemoteHostId(hostId) && !isRemotePeerHostId(hostId)) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Remote Codex Desktop Hosts support thread read only; use a paired remote-peer:<id> Host for remote delegation",
    );
  }
}

function resolveThreadTarget(
  rawThread: string,
  explicitHostId: string | undefined,
  options: { allowNonPeerRemote: boolean },
): { threadId: string; hostId?: string } {
  const reference = readThreadReference(rawThread);
  if (explicitHostId && reference.hostId && explicitHostId !== reference.hostId) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "--host conflicts with the Thread reference",
    );
  }
  const hostId = explicitHostId ?? reference.hostId;
  if (!options.allowNonPeerRemote) assertRemotePeerHostOption(hostId);
  return {
    threadId: reference.threadId,
    ...(hostId ? { hostId } : {}),
  };
}

/** Resolve --cwd against the caller's cwd for local Hosts; remote paths are passed verbatim. */
function cwdOption(parsed: DelegationCliArguments, remote = false): string | undefined {
  const cwd = value(parsed, "--cwd");
  return cwd ? (remote ? cwd : path.resolve(process.cwd(), cwd)) : undefined;
}

function rejectUnknown(parsed: DelegationCliArguments, allowed: readonly string[]): void {
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
  const { endpoint, token, kind } = await resolveRuntimeConnection(input.environment);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(new URL(input.path, endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input.body),
      // The Runtime never redirects; following one would resend the request elsewhere.
      redirect: "error",
    });
  } catch (error) {
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      kind === "client"
        ? "Host Runtime could not be reached through the external client listener. Check that codexhost is running and the listener port is not turned off."
        : "Host Runtime could not be reached. If this command runs inside native Codex, use a session sandbox that permits local Runtime connections or run the command explicitly outside the sandbox.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  let body: { error?: { code?: unknown; message?: unknown; details?: unknown } };
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Runtime response is not a JSON object");
    }
    body = parsed as typeof body;
  } catch (error) {
    throw new DelegationControlError(
      "RUNTIME_UNREACHABLE",
      `Host Runtime returned an unreadable response (HTTP ${response.status}). Check that ${DELEGATION_RUNTIME_ENDPOINT_ENV} points to the Host Runtime.`,
      {
        reason: "invalid_runtime_response",
        status: response.status,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
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

/** Waits are non-consuming, so a long wait repeats bounded Runtime waits until its own deadline. */
async function waitInSlices(
  body: Record<string, unknown> & { timeoutMs?: number },
  request: (body: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const deadline = Date.now() + (body.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  while (true) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await request({ ...body, timeoutMs: Math.min(remaining, MAX_WAIT_REQUEST_MS) });
    const timedOut = (result as { timedOut?: unknown } | null)?.timedOut === true;
    if (!timedOut || deadline - Date.now() <= 0) return result;
  }
}

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** A Thread, or `client:<name>` for an external client's own event log. */
function normalizeNotifyTarget(value: string): string {
  return originClientName(value) !== undefined ? value : normalizeThreadId(value);
}

/** The calling Thread: Host-provided for External Harnesses, Codex-provided for native Codex. */
function callerThreadId(environment: NodeJS.ProcessEnv): string | undefined {
  return (
    environment[DELEGATION_THREAD_ID_ENV] || environment[NATIVE_CODEX_THREAD_ID_ENV] || undefined
  );
}

export async function runDelegationCli(input: {
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output?: Writable;
  diagnosticOutput?: Writable;
  stdin?: Readable & { isTTY?: boolean };
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
    const parsed = parseDelegationArguments(group === "events" ? input.arguments.slice(1) : rest);
    const format = value(parsed, "--format") ?? "json";
    if (format !== "json" && format !== "compact" && format !== "text") {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "--format must be json, compact or text",
      );
    }
    if (format === "text")
      assertDelegationTextCommand(group === "events" ? group : `${group} ${command}`);
    const writeResult = (
      name: DelegationCliCommand,
      body: unknown,
      view: "result" | "messages" = "result",
    ): void => {
      if (format === "text") {
        const text = textDelegationOutput(name, body, view);
        output.write(text.endsWith("\n") ? text : `${text}\n`);
      } else {
        writeJson(
          output,
          format === "json"
            ? jsonDelegationOutput(name, body)
            : compactDelegationOutput(name, body, view),
        );
      }
    };
    if (group === "events") {
      const options = parsed;
      rejectUnknown(options, ["--after", "--limit", "--follow"]);
      if (options.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "events accepts no positional arguments",
        );
      if (!(await usesExternalClient(environment)))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "events are kept for external clients; use local CLI credentials or an explicit external client token",
        );
      const follow = value(options, "--follow");
      if (follow !== undefined && follow !== "true" && follow !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--follow must be true or false");
      let after = value(options, "--after") ? Number(value(options, "--after")) : 0;
      if (!Number.isSafeInteger(after) || after < 0)
        throw new DelegationControlError("INVALID_ARGUMENT", "--after must be an event id");
      const limit = value(options, "--limit")
        ? positiveInteger(value(options, "--limit"), "--limit", MAX_LIMIT)
        : MAX_LIMIT;
      const poll = (timeoutMs: number) =>
        requestRuntime({
          environment,
          path: "/v1/events/poll",
          body: { after, limit, timeoutMs },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }) as Promise<{ events: Array<{ id: number }>; cursor: number }>;
      if (follow !== "true") {
        writeJson(output, await poll(0));
        return 0;
      }
      // One JSON line per event until interrupted; the last id printed is the cursor to resume from.
      while (true) {
        const page = await poll(EVENT_FOLLOW_POLL_MS);
        for (const event of page.events) output.write(`${JSON.stringify(event)}\n`);
        after = page.cursor;
      }
    }
    if (group === "client") {
      rejectUnknown(parsed, ["--scope"]);
      writeJson(
        output,
        await runClientCommand(command, parsed.positionals, environment, {
          scope: value(parsed, "--scope"),
        }),
      );
      return 0;
    }
    if (group === "host" && command === "list") {
      rejectUnknown(parsed, []);
      if (parsed.positionals.length)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "host list accepts no positional arguments",
        );
      writeResult(
        "host list",
        await requestRuntime({
          environment,
          path: "/v1/host/list",
          body: {},
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if ((group === "host" && command === "info") || (group === "project" && command === "list")) {
      rejectUnknown(
        parsed,
        group === "host" ? ["--refresh"] : ["--refresh", "--query", "--offset", "--limit"],
      );
      if (parsed.positionals.length)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "This command accepts no positional arguments",
        );
      const refresh = value(parsed, "--refresh");
      if (refresh !== undefined && refresh !== "true" && refresh !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--refresh must be true or false");
      const offset = value(parsed, "--offset");
      if (offset !== undefined && (!/^\d+$/u.test(offset) || !Number.isSafeInteger(Number(offset))))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--offset must be a non-negative integer",
        );
      writeResult(
        group === "host" ? "host info" : "project list",
        await requestRuntime({
          environment,
          path: group === "host" ? "/v1/host/info" : "/v1/project/list",
          body: {
            ...(refresh !== undefined ? { refresh: refresh === "true" } : {}),
            ...(value(parsed, "--query") !== undefined ? { query: value(parsed, "--query") } : {}),
            ...(offset !== undefined ? { offset: Number(offset) } : {}),
            ...(value(parsed, "--limit")
              ? { limit: positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT) }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "file") {
      rejectUnknown(parsed, ["--path", "--offset", "--limit", "--revision"]);
      const threadId = parsed.positionals[0];
      if (parsed.positionals.length !== 1 || !threadId || !value(parsed, "--path"))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread file requires one Thread and --path",
        );
      const offset = value(parsed, "--offset");
      if (offset !== undefined && (!/^\d+$/u.test(offset) || !Number.isSafeInteger(Number(offset))))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--offset must be a non-negative integer",
        );
      writeResult(
        "thread file",
        await requestRuntime({
          environment,
          path: "/v1/thread/file",
          body: {
            threadId: normalizeThreadId(threadId),
            path: value(parsed, "--path"),
            ...(offset !== undefined ? { offset: Number(offset) } : {}),
            ...(value(parsed, "--limit")
              ? { limit: positiveInteger(value(parsed, "--limit"), "--limit", 1_048_576) }
              : {}),
            ...(value(parsed, "--revision") ? { revision: value(parsed, "--revision") } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "harness" && command === "list") {
      rejectUnknown(parsed, ["--host"]);
      if (parsed.positionals.length > 0) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "harness list accepts no positional arguments",
        );
      }
      const hostId = value(parsed, "--host");
      assertRemotePeerHostOption(hostId);
      const caller = callerThreadId(environment);
      const remote = isRemoteHostId(hostId);
      writeResult(
        "harness list",
        await requestRuntime({
          environment,
          path: "/v1/harness/list",
          body: {
            ...(hostId ? { hostId } : {}),
            ...(caller
              ? remote
                ? { callerThreadId: normalizeThreadId(caller) }
                : { parentThreadId: normalizeThreadId(caller) }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "harness" && command === "inspect") {
      rejectUnknown(parsed, ["--host", "--cwd", "--refresh"]);
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
      const hostId = value(parsed, "--host");
      assertRemotePeerHostOption(hostId);
      const remote = isRemoteHostId(hostId);
      const caller = callerThreadId(environment);
      const cwd = cwdOption(parsed, remote);
      writeResult(
        "harness inspect",
        await requestRuntime({
          environment,
          path: "/v1/harness/inspect",
          body: {
            harnessId,
            ...(hostId ? { hostId } : {}),
            ...(caller
              ? remote
                ? { callerThreadId: normalizeThreadId(caller) }
                : { parentThreadId: normalizeThreadId(caller) }
              : {}),
            ...(cwd ? { cwd } : {}),
            ...(refresh !== undefined ? { refresh: refresh === "true" } : {}),
            ...(!caller || remote
              ? { credentialAccess: refresh === "true" ? "retry" : "allow" }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "delegate" && command === "start") {
      rejectUnknown(parsed, [
        "--host",
        "--harness",
        "--task",
        "--task-file",
        "--task-name",
        "--cwd",
        "--worktree",
        "--base",
        "--model",
        "--thinking",
        "--parent-thread",
        "--request-id",
        "--watch",
        "--watch-timeout-ms",
        "--ref",
      ]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "delegate start accepts no positional arguments",
        );
      const hostId = value(parsed, "--host");
      assertRemotePeerHostOption(hostId);
      const remote = isRemoteHostId(hostId);
      const harnessId = value(parsed, "--harness");
      const task = await resolveCliTextInput(parsed.options, "--task", input.stdin);
      if (!harnessId || !task)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--harness and either --task or --task-file are required",
        );
      const caller = callerThreadId(environment);
      const parentThread = value(parsed, "--parent-thread") ?? caller;
      const watch = value(parsed, "--watch");
      if (watch !== undefined && watch !== "true" && watch !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--watch must be true or false");
      if (watch !== "true" && value(parsed, "--watch-timeout-ms"))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--watch-timeout-ms requires --watch true",
        );
      if (remote && watch === "true")
        throw new DelegationControlError(
          "UNSUPPORTED",
          "Cross-host thread watch is not supported yet",
        );
      // Validate all local options before creating a worktree or making a Runtime request.
      const model = value(parsed, "--model");
      const cwd = cwdOption(parsed, remote);
      const worktree = value(parsed, "--worktree");
      const base = value(parsed, "--base");
      const body = {
        harnessId,
        task,
        ...(hostId ? { hostId } : {}),
        ...(value(parsed, "--task-name") !== undefined
          ? { taskName: value(parsed, "--task-name") }
          : {}),
        ...(cwd ? { cwd } : {}),
        ...(model === undefined ? {} : { model }),
        ...(value(parsed, "--thinking") ? { thinkingOptionId: value(parsed, "--thinking") } : {}),
        ...(parentThread ? { parentThreadId: normalizeThreadId(parentThread) } : {}),
        ...(caller ? { callerThreadId: normalizeThreadId(caller) } : {}),
        ...(value(parsed, "--request-id") ? { requestId: value(parsed, "--request-id") } : {}),
        ...(parsed.repeated.get("--ref") ? { refs: parsed.repeated.get("--ref") } : {}),
        ...(watch === "true"
          ? {
              watchTimeoutMs: value(parsed, "--watch-timeout-ms")
                ? positiveInteger(value(parsed, "--watch-timeout-ms"), "--watch-timeout-ms")
                : DEFAULT_WATCH_TIMEOUT_MS,
            }
          : {}),
      };
      if (remote) {
        writeResult(
          "delegate start",
          await requestRuntime({
            environment,
            path: "/v1/delegate/start",
            body: {
              ...body,
              ...(worktree !== undefined ? { worktree } : {}),
              ...(base !== undefined ? { base } : {}),
            },
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          }),
        );
        return 0;
      }
      writeResult(
        "delegate start",
        await startWithDelegationWorktree(
          {
            cwd: body.cwd ?? (worktree ? process.cwd() : undefined),
            branch: worktree,
            base,
          },
          (resolvedCwd) =>
            requestRuntime({
              environment,
              path: "/v1/delegate/start",
              body: { ...body, ...(resolvedCwd ? { cwd: resolvedCwd } : {}) },
              ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
            }),
        ),
      );
      return 0;
    }
    if (group === "thread" && command === "send") {
      rejectUnknown(parsed, [
        "--host",
        "--message",
        "--message-file",
        "--interrupt",
        "--steer",
        "--mailbox",
        "--watch",
        "--watch-timeout-ms",
      ]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread send requires one Thread identifier",
        );
      }
      const rawThread = parsed.positionals[0];
      const message = await resolveCliTextInput(parsed.options, "--message", input.stdin);
      if (!rawThread || !message?.trim()) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Thread identifier and either --message or --message-file are required",
        );
      }
      const target = resolveThreadTarget(rawThread, value(parsed, "--host"), {
        allowNonPeerRemote: false,
      });
      const remote = isRemoteHostId(target.hostId);
      const steer = value(parsed, "--steer");
      if (steer !== undefined && steer !== "true" && steer !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--steer must be true or false");
      const interrupt = value(parsed, "--interrupt");
      if (interrupt !== undefined && interrupt !== "true" && interrupt !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--interrupt must be true or false");
      const mailbox = value(parsed, "--mailbox");
      if (mailbox !== undefined && mailbox !== "true" && mailbox !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--mailbox must be true or false");
      if (steer === "true" && interrupt === "true")
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--steer and --interrupt are mutually exclusive",
        );
      if (mailbox === "true" && (steer !== undefined || interrupt !== undefined))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--mailbox true cannot be combined with --steer or --interrupt",
        );
      const watch = value(parsed, "--watch");
      if (watch !== undefined && watch !== "true" && watch !== "false")
        throw new DelegationControlError("INVALID_ARGUMENT", "--watch must be true or false");
      if (watch !== "true" && value(parsed, "--watch-timeout-ms"))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--watch-timeout-ms requires --watch true",
        );
      if (remote && watch === "true")
        throw new DelegationControlError(
          "UNSUPPORTED",
          "Cross-host thread watch is not supported yet",
        );
      if (remote && mailbox === "true")
        throw new DelegationControlError("UNSUPPORTED", "Cross-host mailbox is not supported yet");
      const caller = callerThreadId(environment);
      writeResult(
        "thread send",
        await requestRuntime({
          environment,
          path: "/v1/thread/send",
          body: {
            ...target,
            // A mailbox message names its sender when it is delivered later.
            ...((remote || mailbox === "true") && caller
              ? { callerThreadId: normalizeThreadId(caller) }
              : {}),
            message,
            ...(interrupt === "true" ? { interrupt: true } : {}),
            ...(steer !== undefined ? { steer: steer === "true" } : {}),
            ...(mailbox === "true" ? { mailbox: true } : {}),
            ...(watch === "true"
              ? {
                  ...(caller ? { notifyThreadId: normalizeThreadId(caller) } : {}),
                  watchTimeoutMs: value(parsed, "--watch-timeout-ms")
                    ? positiveInteger(value(parsed, "--watch-timeout-ms"), "--watch-timeout-ms")
                    : DEFAULT_WATCH_TIMEOUT_MS,
                }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "export") {
      rejectUnknown(parsed, ["--out"]);
      const thread = parsed.positionals[0];
      if (parsed.positionals.length !== 1 || !thread)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread export requires one Thread identifier",
        );
      const out = value(parsed, "--out");
      writeResult(
        "thread export",
        await requestRuntime({
          environment,
          path: "/v1/thread/export",
          body: {
            ...readThreadReference(thread),
            ...(out ? { out: path.resolve(process.cwd(), out) } : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "cancel") {
      rejectUnknown(parsed, ["--host"]);
      if (parsed.positionals.length !== 1) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread cancel requires one Thread identifier",
        );
      }
      const rawThread = parsed.positionals[0];
      if (!rawThread) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      }
      const target = resolveThreadTarget(rawThread, value(parsed, "--host"), {
        allowNonPeerRemote: false,
      });
      const caller = callerThreadId(environment);
      writeResult(
        "thread cancel",
        await requestRuntime({
          environment,
          path: "/v1/thread/cancel",
          body: {
            ...target,
            ...(isRemoteHostId(target.hostId) && caller
              ? { callerThreadId: normalizeThreadId(caller) }
              : {}),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && (command === "read" || command === "wait")) {
      rejectUnknown(parsed, ["--view", "--from", "--to", "--timeout-ms", "--host"]);
      if (parsed.positionals.length !== 1)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `thread ${command} requires one Thread identifier`,
        );
      const view = value(parsed, "--view") ?? "result";
      if (view !== "result" && view !== "messages")
        throw new DelegationControlError("INVALID_ARGUMENT", "--view must be result or messages");
      if (view === "result" && (value(parsed, "--from") || value(parsed, "--to")))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--from and --to require --view messages",
        );
      if (command === "read" && value(parsed, "--timeout-ms"))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--timeout-ms is valid only for thread wait",
        );
      const rawThread = parsed.positionals[0];
      if (!rawThread)
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      const target = resolveThreadTarget(rawThread, value(parsed, "--host"), {
        allowNonPeerRemote: command === "read",
      });
      const caller = callerThreadId(environment);
      const body = {
        ...target,
        ...(caller && (command === "read" || isRemoteHostId(target.hostId))
          ? { callerThreadId: normalizeThreadId(caller) }
          : {}),
        view,
        ...parseDelegationTurnRange(parsed.options),
        ...(command === "wait"
          ? {
              timeoutMs: value(parsed, "--timeout-ms")
                ? positiveInteger(value(parsed, "--timeout-ms"), "--timeout-ms")
                : DEFAULT_WAIT_TIMEOUT_MS,
            }
          : {}),
      };
      const request = (requestBody: Record<string, unknown>) =>
        requestRuntime({
          environment,
          path: command === "read" ? "/v1/thread/read" : "/v1/thread/wait",
          body: requestBody,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        });
      writeResult(
        command === "read" ? "thread read" : "thread wait",
        command === "read" ? await request(body) : await waitInSlices(body, request),
        view,
      );
      return 0;
    }
    if (group === "thread" && command === "answer") {
      rejectUnknown(parsed, ["--host", "--interaction", "--answers-file"]);
      if (parsed.positionals.length !== 1)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread answer requires one Thread identifier",
        );
      const rawThread = parsed.positionals[0];
      const interactionId = value(parsed, "--interaction");
      const answersFile = value(parsed, "--answers-file");
      if (!rawThread || !interactionId?.trim() || !answersFile) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Thread identifier, --interaction <id>, and --answers-file <file> are required",
        );
      }
      const target = resolveThreadTarget(rawThread, value(parsed, "--host"), {
        allowNonPeerRemote: false,
      });
      let source: string;
      try {
        source = await readFile(answersFile, "utf8");
      } catch (error) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `Answers file '${answersFile}' could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const caller = callerThreadId(environment);
      writeResult(
        "thread answer",
        await requestRuntime({
          environment,
          path: "/v1/thread/answer",
          body: {
            ...target,
            ...(isRemoteHostId(target.hostId) && caller
              ? { callerThreadId: normalizeThreadId(caller) }
              : {}),
            interactionId,
            result: questionReply(source, answersFile),
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "watch") {
      rejectUnknown(parsed, ["--host", "--notify", "--timeout-ms"]);
      if (parsed.positionals.length !== 1)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread watch requires one Thread identifier",
        );
      const rawThread = parsed.positionals[0];
      if (!rawThread)
        throw new DelegationControlError("INVALID_ARGUMENT", "Thread identifier is required");
      const target = resolveThreadTarget(rawThread, value(parsed, "--host"), {
        allowNonPeerRemote: true,
      });
      if (isRemoteHostId(target.hostId))
        throw new DelegationControlError(
          "UNSUPPORTED",
          "Cross-host thread watch is not supported yet",
        );
      const notifyThread = value(parsed, "--notify") ?? callerThreadId(environment);
      // An external client is notified itself; the Runtime fills that in.
      const external = await usesExternalClient(environment);
      if (!notifyThread && !external)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "--notify <thread> is required when the caller Thread is unknown; delegate start reports it as parent",
        );
      writeResult(
        "thread watch",
        await requestRuntime({
          environment,
          path: "/v1/thread/watch",
          body: {
            threadId: target.threadId,
            ...(notifyThread ? { notifyThreadId: normalizeNotifyTarget(notifyThread) } : {}),
            timeoutMs: value(parsed, "--timeout-ms")
              ? positiveInteger(value(parsed, "--timeout-ms"), "--timeout-ms")
              : DEFAULT_WATCH_TIMEOUT_MS,
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "watches") {
      rejectUnknown(parsed, []);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread watches accepts no positional arguments",
        );
      writeResult(
        "thread watches",
        await requestRuntime({
          environment,
          path: "/v1/thread/watches",
          body: {},
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        }),
      );
      return 0;
    }
    if (group === "thread" && command === "list") {
      rejectUnknown(parsed, [
        "--host",
        "--cwd",
        "--parent",
        "--client",
        "--ref",
        "--limit",
        "--cursor",
        "--sort",
      ]);
      if (parsed.positionals.length > 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "thread list accepts no positional arguments",
        );
      const hostId = value(parsed, "--host");
      assertRemotePeerHostOption(hostId);
      const remote = isRemoteHostId(hostId);
      const sort = value(parsed, "--sort") ?? DEFAULT_LIST_SORT;
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
      const client = value(parsed, "--client");
      const ref = value(parsed, "--ref");
      const caller = callerThreadId(environment);
      // An external client or remote Peer has no local workspace to default to.
      const external = await usesExternalClient(environment);
      const cwd =
        cwdOption(parsed, remote) ??
        (remote || external || client || ref ? undefined : process.cwd());
      writeResult(
        "thread list",
        await requestRuntime({
          environment,
          path: "/v1/thread/list",
          body: {
            ...(hostId ? { hostId } : {}),
            ...(remote && caller ? { callerThreadId: normalizeThreadId(caller) } : {}),
            ...(cwd ? { cwd } : {}),
            ...(parentThread ? { parentThreadId: normalizeThreadId(parentThread) } : {}),
            ...(client ? { client } : {}),
            ...(ref ? { ref } : {}),
            limit: value(parsed, "--limit")
              ? positiveInteger(value(parsed, "--limit"), "--limit", MAX_LIMIT)
              : DEFAULT_LIST_LIMIT,
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
