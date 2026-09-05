import type { HarnessCommandCatalog } from "@codexhost/shared-contracts";

import {
  deepSeekHarnessCommandCatalog,
  type DeepSeekCommandDescriptor,
} from "../harness-commands.js";
import { ModernRemoteConnectionError, type ModernRemoteCallOptions } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

const MAX_COMMANDS = 1_024;
const MAX_COMMAND_NAME_LENGTH = 128;
const MAX_COMMAND_DESCRIPTION_LENGTH = 512;
const MAX_COMMAND_INPUT_HINT_LENGTH = 512;
const MAX_COMMAND_ID_LENGTH = 512;
const MAX_COMMAND_RESULT_TEXT_LENGTH = 64 * 1_024;
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

export type ModernCommandErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "limitExceeded"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "remoteError"
  | "unavailable";

export class ModernCommandError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernCommandErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernCommandError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
  }
}

export interface ModernCommandRemote {
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options?: ModernRemoteCallOptions,
  ): Promise<ModernRemoteResult<T>>;
}

export interface ModernCommandExecution {
  readonly commandId: string;
  readonly result:
    | { readonly kind: "success"; readonly text?: string; readonly sourceEventSeq?: number }
    | { readonly kind: "error"; readonly text: string };
}

function commandError(
  code: ModernCommandErrorCode,
  message: string,
  nativeCode?: string,
): ModernCommandError {
  return new ModernCommandError(code, message, nativeCode);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}

function boundedString(value: unknown, maximum: number, allowBlank = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowBlank || value.trim().length > 0) &&
    !value.includes("\0")
  );
}

/** Strictly parse one successful Modern `commands/list` value. */
export function parseModernCommandDescriptors(value: unknown): DeepSeekCommandDescriptor[] {
  if (!Array.isArray(value)) {
    throw commandError("protocolError", "DeepSeek Harness returned an invalid command catalog");
  }
  if (value.length > MAX_COMMANDS) {
    throw commandError("limitExceeded", "DeepSeek Harness command catalog exceeded its bound");
  }

  const names = new Set<string>();
  return value.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, ["name", "description"], ["input"]) ||
      !boundedString(candidate.name, MAX_COMMAND_NAME_LENGTH) ||
      !COMMAND_NAME.test(candidate.name) ||
      names.has(candidate.name) ||
      !boundedString(candidate.description, MAX_COMMAND_DESCRIPTION_LENGTH)
    ) {
      throw commandError("protocolError", "DeepSeek Harness returned an invalid command catalog");
    }
    names.add(candidate.name);

    if (candidate.input === undefined) {
      return { name: candidate.name, description: candidate.description };
    }
    const input = candidate.input;
    if (
      !isPlainRecord(input) ||
      !hasExactKeys(input, ["hint"], ["images"]) ||
      !boundedString(input.hint, MAX_COMMAND_INPUT_HINT_LENGTH) ||
      (input.images !== undefined && typeof input.images !== "boolean")
    ) {
      throw commandError("protocolError", "DeepSeek Harness returned an invalid command catalog");
    }
    return {
      name: candidate.name,
      description: candidate.description,
      input: {
        hint: input.hint,
        ...(input.images === undefined ? {} : { images: input.images }),
      },
    };
  });
}

/** Strictly parse one successful Modern `commands/execute` value. */
export function parseModernCommandExecution(value: unknown): ModernCommandExecution | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["commandId", "result"]) ||
    !boundedString(value.commandId, MAX_COMMAND_ID_LENGTH) ||
    !isPlainRecord(value.result)
  ) {
    throw commandError("protocolError", "DeepSeek Harness returned an invalid command execution");
  }

  const result = value.result;
  if (result.kind === "success") {
    if (
      !hasExactKeys(result, ["kind"], ["text", "sourceEventSeq"]) ||
      (result.text !== undefined &&
        !boundedString(result.text, MAX_COMMAND_RESULT_TEXT_LENGTH, true)) ||
      (result.sourceEventSeq !== undefined &&
        (!Number.isSafeInteger(result.sourceEventSeq) ||
          (result.sourceEventSeq as number) < 0 ||
          Object.is(result.sourceEventSeq, -0)))
    ) {
      throw commandError("protocolError", "DeepSeek Harness returned an invalid command execution");
    }
    return {
      commandId: value.commandId,
      result: {
        kind: "success",
        ...(result.text === undefined ? {} : { text: result.text }),
        ...(result.sourceEventSeq === undefined
          ? {}
          : { sourceEventSeq: result.sourceEventSeq as number }),
      },
    };
  }
  if (
    result.kind !== "error" ||
    !hasExactKeys(result, ["kind", "text"]) ||
    !boundedString(result.text, MAX_COMMAND_RESULT_TEXT_LENGTH)
  ) {
    throw commandError("protocolError", "DeepSeek Harness returned an invalid command execution");
  }
  return { commandId: value.commandId, result: { kind: "error", text: result.text } };
}

function connectionError(endpoint: string, error: ModernRemoteConnectionError): ModernCommandError {
  return commandError(
    error.code,
    `DeepSeek Harness ${endpoint} request failed: ${error.message}`,
    error.nativeCode,
  );
}

async function callModernCommand<T>(
  remote: ModernCommandRemote,
  endpoint: "commands/list" | "commands/execute",
  args: Readonly<Record<string, unknown>>,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
  timeoutMs?: number | null,
): Promise<T> {
  if (timeoutMs === null && signal === undefined) {
    throw new TypeError("A non-timed command request requires an AbortSignal");
  }
  try {
    const result = await remote.call<unknown>(
      endpoint,
      args,
      signal,
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
    if (!result.ok) {
      const safe = sanitizeModernRemoteFailure(result.error);
      throw commandError(
        "remoteError",
        `DeepSeek Harness ${endpoint} failed: ${safe.message}`,
        safe.code,
      );
    }
    return parse(result.value);
  } catch (error) {
    if (error instanceof ModernCommandError) throw error;
    if (error instanceof ModernRemoteConnectionError) throw connectionError(endpoint, error);
    const code =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    throw commandError(
      code === "cancelled" ? "cancelled" : "unavailable",
      `DeepSeek Harness ${endpoint} request failed`,
    );
  }
}

/** Read and filter the current Session's exact native command catalog. */
export async function listModernCommands(
  remote: ModernCommandRemote,
  agentId: string,
  signal?: AbortSignal,
): Promise<HarnessCommandCatalog> {
  const descriptors = await callModernCommand(
    remote,
    "commands/list",
    { agentId },
    parseModernCommandDescriptors,
    signal,
  );
  return deepSeekHarnessCommandCatalog(descriptors);
}

/** Execute one already-reviewed complete native command line. */
export function executeModernCommand(
  remote: ModernCommandRemote,
  agentId: string,
  line: string,
  signal: AbortSignal,
): Promise<ModernCommandExecution | undefined> {
  return callModernCommand(
    remote,
    "commands/execute",
    { agentId, line, images: [] },
    parseModernCommandExecution,
    signal,
    null,
  );
}
