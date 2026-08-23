import type { HarnessError } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  type HostTurnId,
  type JsonObject,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";

export interface DecodedThreadForkRequest {
  threadId: string;
  lastTurnId?: HostTurnId;
  beforeTurnId?: HostTurnId;
  path?: string;
  model?: string;
  modelProvider?: string;
  cwd?: string;
  excludeTurns: boolean;
  ephemeral?: boolean;
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: string;
  sandbox?: string;
  serviceTier?: string;
}

export interface DecodedThreadRollbackRequest {
  threadId: string;
  numTurns: number;
}

export interface DecodedThreadRevertRequest {
  threadId: string;
  beforeTurnId: HostTurnId;
}

export interface ExternalThreadRpcError {
  code: number;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(
  params: Record<string, unknown>,
  name: string,
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    throw new Error(`thread/fork params.${name} must be text or null`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`thread/fork params.${name} must be boolean`);
  return value;
}

export function decodeThreadForkRequest(request: JsonRpcRequest): DecodedThreadForkRequest | null {
  if (request.method !== "thread/fork") return null;
  if (!isRecord(request.params)) throw new Error("thread/fork params must be an object");
  const params = request.params;
  const threadId = optionalText(params, "threadId");
  if (!threadId) throw new Error("thread/fork params.threadId must be non-empty text");
  const lastTurnText = optionalText(params, "lastTurnId");
  const beforeTurnText = optionalText(params, "beforeTurnId");
  if (lastTurnText && beforeTurnText) {
    throw new Error("thread/fork cannot combine lastTurnId and beforeTurnId");
  }
  const runtimeWorkspaceRoots = params.runtimeWorkspaceRoots;
  if (
    runtimeWorkspaceRoots !== undefined &&
    runtimeWorkspaceRoots !== null &&
    (!Array.isArray(runtimeWorkspaceRoots) ||
      runtimeWorkspaceRoots.some((root) => typeof root !== "string" || root.length === 0))
  ) {
    throw new Error("thread/fork params.runtimeWorkspaceRoots must be text paths or null");
  }
  const path = optionalText(params, "path", { allowEmpty: true });
  const ephemeral = optionalBoolean(params, "ephemeral");
  return {
    threadId,
    ...(lastTurnText ? { lastTurnId: hostTurnIdSchema.parse(lastTurnText) } : {}),
    ...(beforeTurnText ? { beforeTurnId: hostTurnIdSchema.parse(beforeTurnText) } : {}),
    ...(path ? { path } : {}),
    ...optionalField(params, "model"),
    ...optionalField(params, "modelProvider"),
    ...optionalField(params, "cwd"),
    excludeTurns: optionalBoolean(params, "excludeTurns") ?? false,
    ...(ephemeral !== undefined ? { ephemeral } : {}),
    ...(Array.isArray(runtimeWorkspaceRoots)
      ? { runtimeWorkspaceRoots: runtimeWorkspaceRoots as string[] }
      : {}),
    ...optionalField(params, "approvalPolicy"),
    ...optionalField(params, "sandbox"),
    ...optionalField(params, "serviceTier"),
  };
}

export function decodeThreadRevertRequest(
  request: JsonRpcRequest,
): DecodedThreadRevertRequest | null {
  if (request.method !== "thread/revert") return null;
  if (!isRecord(request.params)) throw new Error("thread/revert params must be an object");
  const { threadId, beforeTurnId } = request.params;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("thread/revert params.threadId must be non-empty text");
  }
  if (typeof beforeTurnId !== "string" || beforeTurnId.length === 0) {
    throw new Error("thread/revert params.beforeTurnId must be non-empty text");
  }
  return { threadId, beforeTurnId: hostTurnIdSchema.parse(beforeTurnId) };
}

export function decodeThreadRollbackRequest(
  request: JsonRpcRequest,
): DecodedThreadRollbackRequest | null {
  if (request.method !== "thread/rollback") return null;
  if (!isRecord(request.params)) throw new Error("thread/rollback params must be an object");
  const { threadId, numTurns } = request.params;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("thread/rollback params.threadId must be non-empty text");
  }
  if (!Number.isSafeInteger(numTurns) || (numTurns as number) <= 0) {
    throw new Error("thread/rollback params.numTurns must be a positive safe integer");
  }
  return { threadId, numTurns: numTurns as number };
}

function optionalField<Name extends string>(
  params: Record<string, unknown>,
  name: Name,
): Partial<Record<Name, string>> {
  const value = optionalText(params, name);
  return value === undefined ? {} : ({ [name]: value } as Partial<Record<Name, string>>);
}

export function mapExternalThreadHarnessError(
  error: HarnessError,
  operation: "create" | "read" | "resume" | "fork" | "turn",
): ExternalThreadRpcError {
  switch (error.code) {
    case "invalidRequest":
      return { code: -32602, message: `External Thread ${operation} request is invalid` };
    case "sessionBusy":
      return { code: -32072, message: "External Thread has an active operation" };
    case "unsupported":
      return { code: -32076, message: `External Harness does not support ${operation}` };
    case "sessionNotFound":
      return { code: -32079, message: "External Native Session is unavailable" };
    case "checkpointNotFound":
      return { code: -32080, message: "External Fork Checkpoint is unavailable" };
    case "notInstalled":
    case "unavailable":
    case "authenticationRequired":
      return { code: -32077, message: "External Harness is unavailable" };
    case "nativeFailure":
    case "protocolError":
    case "processExited":
    case "internalError":
    case "invalidState":
      return { code: -32076, message: `External Thread ${operation} failed` };
  }
}

export function threadRevertResult(thread: JsonObject): JsonObject {
  return { thread: { ...thread, turns: [] } };
}

export function threadRollbackResult(thread: JsonObject): JsonObject {
  return { thread };
}

export function threadForkResult(
  thread: JsonObject,
  input: {
    model: string;
    cwd: string;
    runtimeWorkspaceRoots?: string[];
    approvalPolicy?: string;
    sandbox: JsonObject;
    serviceTier?: string;
  },
): JsonObject {
  return {
    thread,
    model: input.model,
    modelProvider: "codexhost",
    serviceTier: input.serviceTier ?? null,
    cwd: input.cwd,
    runtimeWorkspaceRoots: input.runtimeWorkspaceRoots ?? [],
    instructionSources: [],
    approvalPolicy: input.approvalPolicy ?? "never",
    approvalsReviewer: "user",
    sandbox: input.sandbox,
    activePermissionProfile: null,
    reasoningEffort: "medium",
    multiAgentMode: "explicitRequestOnly",
  };
}
